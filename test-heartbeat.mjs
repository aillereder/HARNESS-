// 阶段 2 验证：lib/heartbeat.js 主动心跳的决策逻辑。
//
// 这是**唯一会"无中生有"发消息**的机制，所以测试重心是：
// 该拦的都拦住（不打扰、不刷屏、累了不硬撑），而不是"能发出去"。

import {
  DEFAULT_POLICY, DEFAULT_WAIT_SECONDS, DailyCounter, WAIT_MAX_SECONDS, WAIT_MIN_SECONDS,
  dayKeyOf, evaluate, hourOf, inQuietHours, parseWait, proactiveHint, resolveNextWake,
} from './lib/heartbeat.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const T0 = new Date(2026, 0, 15, 14, 0, 0).getTime() // 本地 14:00，不在默认静默时段
const MIN = 60000
const goodState = { energy: 6, patience: 6, mood: 6, focus: 6 }
const always = () => 0 // 概率必过

/** 一个"什么条件都满足"的基线输入 */
function base(extra) {
  return Object.assign({
    state: goodState,
    now: T0,
    lastUserAt: T0 - 60 * MIN,      // 用户沉默 60 分钟
    lastProactiveAt: 0,
    todayCount: 0,
    busy: false,
    policy: { enabled: true },
    rng: always,
  }, extra || {})
}

// ── 1. 默认关闭（装完不该自己说话）──────────────────────────────────────
{
  ok('默认策略是关闭的', DEFAULT_POLICY.enabled === false)
  const r = evaluate({ state: goodState, now: T0, lastUserAt: T0 - 60 * MIN, policy: {} })
  ok('未显式启用时不允许主动', r.allow === false && r.reason.indexOf('未启用') >= 0, JSON.stringify(r))
}

// ── 2. 基线：条件齐备时允许 ─────────────────────────────────────────────
{
  const r = evaluate(base())
  ok('条件齐备时允许主动', r.allow === true, JSON.stringify(r))
}

// ── 3. 不打扰时段 ───────────────────────────────────────────────────────
{
  ok('[0,7) 含 0 点', inQuietHours(0, [[0, 7]]) === true)
  ok('[0,7) 含 6 点', inQuietHours(6, [[0, 7]]) === true)
  ok('[0,7) 不含 7 点（左闭右开）', inQuietHours(7, [[0, 7]]) === false)
  ok('[0,7) 不含 14 点', inQuietHours(14, [[0, 7]]) === false)
  ok('跨零点时段 [23,7) 含 23', inQuietHours(23, [[23, 7]]) === true)
  ok('跨零点时段 [23,7) 含 3', inQuietHours(3, [[23, 7]]) === true)
  ok('跨零点时段 [23,7) 不含 12', inQuietHours(12, [[23, 7]]) === false)
  ok('多段并存', inQuietHours(13, [[0, 7], [12, 14]]) === true)
  ok('畸形时段不误判', inQuietHours(13, [[1]]) === false && inQuietHours(13, null) === false)

  // 凌晨 3 点即使其他条件齐备也不主动
  const night = new Date(2026, 0, 15, 3, 0, 0).getTime()
  const r = evaluate(base({ now: night, lastUserAt: night - 60 * MIN }))
  ok('凌晨 3 点不主动（不打扰）', r.allow === false && r.reason.indexOf('不打扰') >= 0, JSON.stringify(r))
}

// ── 4. 用户刚说过话 → 不主动 ────────────────────────────────────────────
{
  const r = evaluate(base({ lastUserAt: T0 - 1 * MIN })) // 只沉默 1 分钟
  ok('用户刚说完就不主动（默认静默 5 分钟）',
    r.allow === false && r.reason.indexOf('刚说过话') >= 0, JSON.stringify(r))
}

// ── 5. 冷却期 ───────────────────────────────────────────────────────────
{
  const cooled = base({ lastProactiveAt: T0 - 10 * MIN }) // 10 分钟前刚主动过
  const r1 = evaluate(cooled)
  ok('冷却期内不主动', r1.allow === false && r1.reason.indexOf('冷却') >= 0, JSON.stringify(r1))

  const ready = base({ lastProactiveAt: T0 - 60 * MIN })
  ok('冷却过后可以', evaluate(ready).allow === true)
}

// ── 6. 每日预算 ─────────────────────────────────────────────────────────
{
  const over = base({ todayCount: DEFAULT_POLICY.dailyBudget })
  const r = evaluate(over)
  ok('预算用完不再主动', r.allow === false && r.reason.indexOf('预算') >= 0, JSON.stringify(r))
  ok('  差一次仍可以', evaluate(base({ todayCount: DEFAULT_POLICY.dailyBudget - 1 })).allow === true)
}

// ── 7. 有进行中的轮次 → 不插话 ──────────────────────────────────────────
{
  const r = evaluate(base({ busy: true }))
  ok('有人在说话时不插话', r.allow === false && r.reason.indexOf('进行中') >= 0, JSON.stringify(r))
}

// ── 8. 状态撑不住 → 不主动（这是性格不是安全阀）─────────────────────────
{
  const tired = base({ state: { energy: 2.0, patience: 6, mood: 6 } })
  const r1 = evaluate(tired)
  ok('精力太低不主动（累了不想说话）',
    r1.allow === false && r1.reason.indexOf('精力') >= 0, JSON.stringify(r1))

  const impatient = base({ state: { energy: 6, patience: 1.5, mood: 6 } })
  const r2 = evaluate(impatient)
  ok('耐心太低不主动', r2.allow === false && r2.reason.indexOf('耐心') >= 0, JSON.stringify(r2))

  const sad = base({ state: { energy: 6, patience: 6, mood: 1.5 } })
  const r3 = evaluate(sad)
  ok('心情太低不主动', r3.allow === false && r3.reason.indexOf('心情') >= 0, JSON.stringify(r3))

  ok('状态刚好过线则可以',
    evaluate(base({ state: { energy: 3.1, patience: 2.6, mood: 2.6 } })).allow === true)
}

// ── 9. 概率闸（不是每次评估都发）────────────────────────────────────────
{
  const never = base({ rng: () => 0.99 }) // 概率 0.3 → 0.99 不过
  const r = evaluate(never)
  ok('概率没过则不主动', r.allow === false && r.reason.indexOf('概率') >= 0, JSON.stringify(r))

  // 长期频率应当接近设定概率
  let hits = 0
  let seed = 12345
  const lcg = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const N = 4000
  for (let i = 0; i < N; i += 1) {
    if (evaluate(base({ rng: lcg })).allow) hits += 1
  }
  const rate = hits / N
  ok('长期通过率接近设定概率 0.3（0.25~0.35）', rate > 0.25 && rate < 0.35, rate.toFixed(3))
}

// ── 10. 每日计数器跨天归零 ──────────────────────────────────────────────
{
  const c = new DailyCounter()
  ok('初始为 0', c.today(T0) === 0)
  c.bump(T0)
  c.bump(T0)
  ok('同一天累加', c.today(T0) === 2, String(c.today(T0)))

  const nextDay = T0 + 24 * 60 * MIN
  ok('跨天归零', c.today(nextDay) === 0, String(c.today(nextDay)))
  c.bump(nextDay)
  ok('跨天后重新计数', c.today(nextDay) === 1)

  const c2 = new DailyCounter()
  c2.restore(dayKeyOf(T0), 5)
  ok('可从快照恢复', c2.today(T0) === 5, String(c2.today(T0)))

  ok('dayKeyOf 形状正确', /^\d{4}-\d{2}-\d{2}$/.test(dayKeyOf(T0)), dayKeyOf(T0))
  ok('hourOf 取本地小时', typeof hourOf(T0) === 'number' && hourOf(T0) >= 0 && hourOf(T0) <= 23)
}

// ── 11. 旁注必须允许沉默 ────────────────────────────────────────────────
{
  const h = proactiveHint('心情 6.0/10、精力 5.0/10')
  ok('用记录口吻（不是第一人称）', h.indexOf('旁注') >= 0, h.slice(0, 30))
  ok('带上状态', h.indexOf('心情 6.0/10') >= 0)
  ok('明确允许什么都不说', h.indexOf('也可以什么都不说') >= 0, h)
  ok('明确允许沉默（防退化成定时发消息）', h.indexOf('别开口') >= 0 || h.indexOf('别说') >= 0, h)
  ok('空状态也不崩', proactiveHint('').length > 0 && proactiveHint(null).length > 0)
  ok('  且不含空的状态行', proactiveHint('').indexOf('你现在的状态：（') < 0)
}

// ── 12. 容错 ───────────────────────────────────────────────────────────
{
  let threw = false
  try {
    evaluate(null)
    evaluate(undefined)
    evaluate({})
    evaluate({ state: null, policy: null, rng: null })
  } catch (error) { threw = true }
  ok('畸形输入不抛', threw === false)
}

// ── 13. 她自己定节奏：parseWait ──────────────────────────────────────────
{
  ok('数字当秒', parseWait(90).kind === 'wait' && parseWait(90).seconds === 90)
  ok('0 表示别叫我', parseWait(0).kind === 'never')
  ok('负数也表示别叫我', parseWait(-5).kind === 'never')
  ok('"90" 当秒', parseWait('90').seconds === 90)
  ok('"60秒"', parseWait('60秒').seconds === 60)
  ok('"2分钟" → 120', parseWait('2分钟').seconds === 120)
  ok('"1.5min" → 90', parseWait('1.5min').seconds === 90)
  ok('"半小时" → 1800', parseWait('半小时').seconds === 1800)
  ok('"1小时" → 3600', parseWait('1小时').seconds === 3600)
  ok('"别叫我了" → never', parseWait('别叫我了').kind === 'never')
  ok('"先别打扰我" → never', parseWait('先别打扰我').kind === 'never')

  // 边界与容错
  ok('过小被抬到下限', parseWait(1).seconds === WAIT_MIN_SECONDS, String(parseWait(1).seconds))
  ok('过大被压到上限', parseWait(999999).seconds === WAIT_MAX_SECONDS, String(parseWait(999999).seconds))
  ok('解析不出返回 null（不猜）', parseWait('随便吧') === null)
  ok('空串返回 null', parseWait('') === null && parseWait('   ') === null)
  ok('null/undefined 返回 null', parseWait(null) === null && parseWait(undefined) === null)
  ok('非字符串非数字返回 null', parseWait({}) === null && parseWait([]) === null)
}

// ── 14. 她自己定节奏：resolveNextWake ───────────────────────────────────
{
  // 关键回归：没给节奏时**不能**设闸。
  // 第一版返回 now+interval，而每次 tick 重算 → now < now+interval 恒真，
  // 心跳一次都不会触发。这条断言就是为那个 bug 加的。
  const noWake = resolveNextWake({ now: T0, lastUserAt: 0, selfWake: null })
  ok('没给节奏时不设闸（nextAt=null）——否则心跳永不触发', noWake.nextAt === null,
    String(noWake.nextAt))

  const wait = resolveNextWake({
    now: T0, lastUserAt: 0,
    selfWake: { kind: 'wait', seconds: 120, at: T0 },
  })
  ok('给了秒数 → 在她给的时间点唤醒', wait.nextAt === T0 + 120000, String(wait.nextAt))
  ok('  并说明来源', wait.source.indexOf('她自定节奏') >= 0, wait.source)

  const never = resolveNextWake({
    now: T0, lastUserAt: 0,
    selfWake: { kind: 'never', at: T0 },
  })
  ok('说了别叫我 → 无限远', never.nextAt === Number.POSITIVE_INFINITY, String(never.nextAt))

  // 用户在她"别叫我"之后说话了 → 撤销
  const revoked = resolveNextWake({
    now: T0 + 60000, lastUserAt: T0 + 30000,
    selfWake: { kind: 'never', at: T0 },
  })
  ok('用户开口后"别叫我"失效（不再无限远）', revoked.nextAt === null, String(revoked.nextAt))

  const revokedWait = resolveNextWake({
    now: T0 + 60000, lastUserAt: T0 + 30000,
    selfWake: { kind: 'wait', seconds: 600, at: T0 },
  })
  ok('用户开口后她给的秒数也失效', revokedWait.nextAt === null, String(revokedWait.nextAt))

  ok('默认兜底秒数为正', DEFAULT_WAIT_SECONDS > 0, String(DEFAULT_WAIT_SECONDS))
}

// ── 15. 旁注要告知"你可以自己定节奏"（能力不告知等于不存在）─────────────
{
  const h = proactiveHint('心情 5.0/10')
  ok('旁注提到 heartbeat_wait', h.indexOf('heartbeat_wait') >= 0, h.slice(-90))
  ok('旁注说明给 0 就是别叫我', h.indexOf('别叫我') >= 0)
}

// ── 16. 她排的时机到了 → 让过"用户刚说过话"与概率两道闸 ─────────────────
{
  // 场景（实测踩到的 bug）：用户说"15 秒后跟我说话"，她排了 15 秒。到点时：
  //   · 静默闸判"用户刚说过话" → 拦掉
  //   · 概率闸还有 60% 概率让她装死
  // 所以"被明确要求的时机"必须让这两道闸让路 —— 它们是给**自主**开口用的。
  const atDue = {
    state: goodState,
    now: T0,
    lastUserAt: T0 - 15000,     // 用户 15 秒前刚说过话 → 静默闸会拦
    lastProactiveAt: 0,
    todayCount: 0,
    busy: false,
    policy: { enabled: true },
    rng: () => 0.99,             // 概率闸也会拦
  }

  const autonomous = evaluate(atDue)
  ok('自主评估时：用户刚说过话 → 拦住', autonomous.allow === false
    && autonomous.reason.indexOf('刚说过话') >= 0, JSON.stringify(autonomous))

  const explicit = evaluate(Object.assign({}, atDue, { explicitWake: true }))
  ok('她排的时机到了：静默闸让路 → 放行', explicit.allow === true, JSON.stringify(explicit))
  ok('  概率闸也让路（不靠掷骰子）', explicit.reason.indexOf('她排的时机') >= 0, explicit.reason)

  // 但安全性两条仍要保留
  const inQuiet = new Date(2026, 0, 15, 3, 0, 0).getTime()
  const quiet = evaluate(Object.assign({}, atDue, { explicitWake: true, now: inQuiet }))
  ok('即使是她排的时机，不打扰时段仍拦住', quiet.allow === false, JSON.stringify(quiet))

  const overBudget = evaluate(Object.assign({}, atDue, {
    explicitWake: true, todayCount: DEFAULT_POLICY.dailyBudget,
  }))
  ok('即使是她排的时机，每日预算仍拦住', overBudget.allow === false, JSON.stringify(overBudget))

  const busy = evaluate(Object.assign({}, atDue, { explicitWake: true, busy: true }))
  ok('正在说话时不插话（这条也不让路）', busy.allow === false, JSON.stringify(busy))
}

// ── 17. tickMs 是粒度上限 ───────────────────────────────────────────────
{
  ok('默认 tickMs 是秒级（不是分钟级）', DEFAULT_POLICY.tickMs <= 60000,
    String(DEFAULT_POLICY.tickMs))
  ok('最小等待与 tickMs 同量级（否则排了也等不到）',
    WAIT_MIN_SECONDS * 1000 <= DEFAULT_POLICY.tickMs * 2,
    WAIT_MIN_SECONDS + 's vs ' + DEFAULT_POLICY.tickMs + 'ms')
}

console.log('\nheartbeat 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)