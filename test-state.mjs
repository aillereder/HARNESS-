// 阶段 1 的可执行验证：state.js 的纯逻辑。
// 用固定 rng 跑，保证可复现；所有断言都在真实数值上。

import { BASELINE, CLAMP, apply, createState, describe, drift, generationBias } from './lib/state.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}
function near(a, b, eps) { return Math.abs(a - b) <= eps }

const T0 = 1_800_000_000_000 // 固定基准时刻

// ── 1. 无时间流逝不改变状态 ────────────────────────────────────────────────
{
  const s = createState(T0)
  const d = drift(s, T0, () => 0.5)
  ok('零间隔不漂移（除 at 外全等）',
    near(d.mood, s.mood, 1e-12) && near(d.energy, s.energy, 1e-12) && near(d.patience, s.patience, 1e-12),
    JSON.stringify({ before: s.patience, after: d.patience }))
}

// ── 2. 按真实时间成比例：1×60min 与 60×1min 的**确定性部分**应当一致 ────────
// 逐分钟版（rng 固定在期望值 0.5，正态偏置为 0 时）与一次 60 分钟应当落在同一处。
// 这里只比较"回归"分量：用一个恒定 rng 让噪声均值可控，比较 60 步与 1 步的总体走向。
{
  const base = createState(T0)
  base.patience = 9.5 // 从高处起步，看回归

  // 60 次 1 分钟
  let stepwise = base
  for (let i = 1; i <= 60; i += 1) {
    stepwise = drift(stepwise, T0 + i * 60000, () => 0.5)
  }
  // 1 次 60 分钟
  const oneShot = drift(base, T0 + 60 * 60000, () => 0.5)

  const a = stepwise.patience
  const b = oneShot.patience
  ok('按时间成比例：60×1min 与 1×60min 走向一致（差 < 1.0）',
    Math.abs(a - b) < 1.0,
    'stepwise=' + a.toFixed(3) + ' oneshot=' + b.toFixed(3))
}

// ── 3. 长间隔不塌成 0：这正是 sqrt(1-r^2) 缩放要保证的 ─────────────────────
{
  const s = createState(T0)
  s.patience = 9.5
  // 极大间隔：回归因子 r → 0，retention 把值拉回基线，
  // 但噪声项必须仍有幅度（不是 0），否则长间隔后状态会死成基线不动。
  const rngSeq = [0.99, 0.99, 0.99, 0.99, 0.99]
  let i = 0
  const rng = () => { const v = rngSeq[i % rngSeq.length]; i += 1; return v }
  const far = drift(s, T0 + 10 * 24 * 60 * 60000, rng) // 10 天
  ok('超长间隔后仍在合法区间',
    far.patience >= CLAMP[0] && far.patience <= CLAMP[1],
    'patience=' + far.patience.toFixed(3))
  // 10 天后 retention 极小，说明确实回归了；但不允许出现 NaN
  ok('超长间隔不产生 NaN/Infinity',
    Number.isFinite(far.patience) && Number.isFinite(far.mood) && Number.isFinite(far.energy),
    JSON.stringify(far))
}

// ── 4. 老实现那个 bug：3 分钟跑 30 次不许砸到地板 ──────────────────────────
{
  // 场景：unanswered = 3，3 分钟内被调用 30 次
  let s = createState(T0)
  s.unanswered = 3
  s.patience = 5.5
  for (let i = 1; i <= 30; i += 1) {
    s = drift(s, T0 + i * (3 * 60000 / 30), () => 0.5)
  }
  const oneShot = drift(Object.assign(createState(T0), { unanswered: 3, patience: 5.5 }), T0 + 3 * 60000, () => 0.5)
  ok('3 分钟 30 次调用与 1 次调用结果接近（差 < 0.6）',
    Math.abs(s.patience - oneShot.patience) < 0.6,
    '30x=' + s.patience.toFixed(3) + ' 1x=' + oneShot.patience.toFixed(3))
  ok('连续没回音确实压低耐心（但不到地板）',
    s.patience < 5.5 && s.patience > CLAMP[0],
    'patience=' + s.patience.toFixed(3))
}

// ── 5. 事件权重：工具失败掉耐心、用户回来清零 unanswered ───────────────────
{
  let s = createState(T0)
  const before = s.patience
  s = apply(s, { kind: 'tool-result', isError: true, consecutiveErrors: 1, at: T0 })
  ok('工具失败掉耐心', s.patience < before, before.toFixed(2) + ' -> ' + s.patience.toFixed(2))

  const p1 = s.patience
  s = apply(s, { kind: 'tool-result', isError: true, consecutiveErrors: 2, at: T0 })
  ok('连续第二次失败掉更多', (p1 - s.patience) > 0.5, 'drop=' + (p1 - s.patience).toFixed(3))

  s = apply(s, { kind: 'no-reply-turn', at: T0 })
  s = apply(s, { kind: 'no-reply-turn', at: T0 })
  ok('连发没回音累加 unanswered', s.unanswered === 2, 'unanswered=' + s.unanswered)
  s = apply(s, { kind: 'user-message', silentMin: 10, at: T0 })
  ok('用户回来后 unanswered 清零', s.unanswered === 0, 'unanswered=' + s.unanswered)
}

// ── 6. 生成偏置：状态越差，回得越短（这是真提速，也是拟人）─────────────────
{
  const good = createState(T0)
  const bad = Object.assign(createState(T0), { patience: 2.0, energy: 2.0, focus: 3.0, mood: 3.0 })
  const g = generationBias(good)
  const b = generationBias(bad)
  ok('状态差时 maxTokens 明显更低', b.maxTokens < g.maxTokens, g.maxTokens + ' -> ' + b.maxTokens)
  ok('temperature 被夹在 0.5~1.2', b.temperature >= 0.5 && b.temperature <= 1.2, String(b.temperature))
}

// ── 7. describe 只陈述事实，不做解读 ───────────────────────────────────────
{
  const s = Object.assign(createState(T0), { mood: 4.23, energy: 3.11, patience: 5.0, focus: 6.0, unanswered: 4 })
  const text = describe(s)
  ok('describe 含数值与连发事实', text.indexOf('心情 4.2/10') === 0 && text.indexOf('连发 4 条没回音') > 0, text)
  ok('describe 不含解读性判断（无"不想说"/"烦"等）',
    !/不想|懒得|烦躁|生气|高兴/.test(text), text)
}

// ── 8. 所有变量始终在合法区间 ──────────────────────────────────────────────
{
  let s = createState(T0)
  for (let i = 0; i < 500; i += 1) {
    s = drift(s, T0 + i * 60_000 * 7, Math.random)
    s = apply(s, { kind: 'assistant-message', length: 400, at: T0 + i * 60000 * 7 })
    if (i % 3 === 0) s = apply(s, { kind: 'tool-result', isError: true, consecutiveErrors: 3, at: T0 })
    if (i % 5 === 0) s = apply(s, { kind: 'no-reply-turn', at: T0 })
    if (i % 11 === 0) s = apply(s, { kind: 'user-message', silentMin: 200, at: T0 })
    const bad = ['mood', 'energy', 'patience', 'focus'].filter((k) => !(s[k] >= CLAMP[0] && s[k] <= CLAMP[1]))
    if (bad.length > 0) { ok('500 轮后仍在合法区间', false, 'i=' + i + ' 越界=' + bad.join(',')); break }
  }
  ok('500 轮混合事件后仍在合法区间', true)
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
