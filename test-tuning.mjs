// 阶段 1 的调参验收：模拟连续长对话，确认活力不会被砸穿。
//
// 这个测试的存在理由是一个**实测到的真问题**：
// 第一版权重在真实会话里跑 17 轮后，energy 从 6.5 掉到 0.8，
// generationBias 把 maxTokens 压到 160 —— 表现成"她越聊越没电"。
// 那是参数错，不是机制错；本测试把修好之后的行为钉住。

import { CLAMP, apply, createState, drift, generationBias } from './lib/state.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const T0 = 1_800_000_000_000
const MIN = 60000

// ── 场景 A：连续 20 轮长对话（每轮她发 1 条 1200 字、间隔 30 秒）──────────
// 注意**必须带 turn-end 边界**：真实运行里 burst 是靠 turn/end 归零的，
// 早期这版测试漏了它，导致 burst 线性增长把活力压穿 —— 那是场景失真，
// 曾被误读成参数问题。补上边界之后这个测试才测的是真事。
{
  let s = createState(T0)
  const rng = () => 0.5 // 关掉噪声，只看确定性的消耗项
  for (let i = 1; i <= 20; i += 1) {
    const at = T0 + i * 30 * 1000
    s = drift(s, at, rng)
    s = apply(s, { kind: 'assistant-message', length: 1200, at: at })
    s = apply(s, { kind: 'turn-end', steps: 1, at: at })
  }
  const b = generationBias(s)
  ok('20 轮长对话后活力未触底（> 1.8 软地板）', s.energy > 1.8,
    'energy=' + s.energy.toFixed(2))
  ok('疲惫体现在"回得短"，但不至于说不出话（maxTokens >= 400）', b.maxTokens >= 400,
    'maxTokens=' + b.maxTokens + ' energy=' + s.energy.toFixed(2))
  console.log('       (20 轮后 energy=' + s.energy.toFixed(2) + ' patience=' + s.patience.toFixed(2) + ' maxTokens=' + b.maxTokens + ')')
}

// ── 场景 A2：生成偏置随状态单调，且有合理下限 ─────────────────────────────
{
  const mk = (energy) => Object.assign(createState(T0), { energy: energy })
  const hi = generationBias(mk(8.0)).maxTokens
  const mid = generationBias(mk(3.0)).maxTokens
  const lo = generationBias(mk(1.5)).maxTokens
  ok('maxTokens 随活力单调不增', hi >= mid && mid >= lo, hi + ' >= ' + mid + ' >= ' + lo)
  ok('最低档不低到"只会蹦字"（>= 400）', lo >= 400, String(lo))
  ok('最高档不超默认上限（<= 800）', hi <= 800, String(hi))
}

// ── 场景 B：长度惩罚封顶 —— 3000 字与 1000 字的单条消耗差距有限 ────────────
{
  const rng = () => 0.5
  const a = apply(createState(T0), { kind: 'assistant-message', length: 1000, at: T0 })
  const b = apply(createState(T0), { kind: 'assistant-message', length: 3000, at: T0 })
  const diff = a.energy - b.energy
  ok('长度惩罚封顶：1000 字与 3000 字的消耗差 <= 0.11', diff <= 0.11,
    'diff=' + diff.toFixed(4) + ' (a=' + a.energy.toFixed(3) + ' b=' + b.energy.toFixed(3) + ')')
}

// ── 场景 C：安静恢复 —— 她沉默 60 分钟后活力回升 ─────────────────────────
{
  const rng = () => 0.5
  let s = createState(T0)
  s.energy = 3.0
  s.focus = 2.0
  s.lastSpeakAt = T0
  const after = drift(s, T0 + 60 * MIN, rng)
  ok('沉默 60 分钟后活力回升', after.energy > 3.0, '3.00 -> ' + after.energy.toFixed(2))
  ok('沉默 60 分钟后专注回升', after.focus > 2.0, '2.00 -> ' + after.focus.toFixed(2))
}

// ── 场景 D：安静恢复有上限，久不出现不会直接回满 ──────────────────────────
{
  const rng = () => 0.5
  let s = createState(T0)
  s.energy = 1.0
  s.lastSpeakAt = T0
  const after = drift(s, T0 + 30 * 24 * 60 * MIN, rng) // 30 天
  ok('30 天不做功后活力不超上限', after.energy <= CLAMP[1], 'energy=' + after.energy.toFixed(2))
}

// ── 场景 E：被晾着 vs 单纯安静，方向相反 ──────────────────────────────────
{
  const rng = () => 0.5
  // 被晾着：连发没回音，30 分钟内被反复驱动
  let ignored = createState(T0)
  ignored.unanswered = 4
  ignored.patience = 5.5
  for (let i = 1; i <= 30; i += 1) ignored = drift(ignored, T0 + i * MIN, rng)
  // 单纯安静：同样 30 分钟，但没人晾她
  let quiet = createState(T0)
  quiet.lastSpeakAt = T0 + 1
  for (let i = 1; i <= 30; i += 1) quiet = drift(quiet, T0 + i * MIN, rng)

  ok('被晾着会明显掉耐心（< 4.0）', ignored.patience < 4.0, 'patience=' + ignored.patience.toFixed(2))
  ok('单纯安静不会掉耐心', quiet.patience >= 5.4, 'patience=' + quiet.patience.toFixed(2))
  console.log('       (被晾 30min patience=' + ignored.patience.toFixed(2)
    + ' / 安静 30min patience=' + quiet.patience.toFixed(2) + ')')
}

// ── 场景 F：耐心允许被压到地板（软性地板**不**作用于耐心）─────────────────
{
  const rng = () => 0.5
  let s = createState(T0)
  s.unanswered = 8
  s.patience = 5.5
  for (let i = 1; i <= 120; i += 1) s = drift(s, T0 + i * MIN, rng)
  ok('长时间被晾：耐心可以到地板（这不是 bug）', s.patience <= 1.0,
    'patience=' + s.patience.toFixed(2))
}

console.log('\n调参验收：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
