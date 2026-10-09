// 阶段 5 验证：lib/followup.js 的入站严格顺序、去重、静默窗、频率上限。
//
// 核心断言：**发送顺序 === 到达顺序**。这是"她还在说、用户又发消息"
// 场景下唯一不翻车的保证；反了就是答非所问。

import {
  ACTIVE, CONSUMED, Debouncer, FINISHED, FollowUpQueue, PENDING, RateLimiter,
} from './lib/followup.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1. 到达顺序分配序号 ───────────────────────────────────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('m1')
  const b = q.begin('m2')
  const c = q.begin('m3')
  ok('序号按到达递增', a.seq === 0 && b.seq === 1 && c.seq === 2, JSON.stringify([a.seq, b.seq, c.seq]))
  ok('初始都是 pending', q.status.get(0) === PENDING)
}

// ── 2. 幂等：同一 message_id 不重复入队 ──────────────────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('msg-42')
  const b = q.begin('msg-42')
  ok('首发入队', a.duplicate === false && a.seq === 0)
  ok('重复被识别', b.duplicate === true && b.seq === -1, JSON.stringify(b))
  ok('重复不入队（只有 1 个槽位）', q.snapshot().slots.length === 1)
  ok('无 key 时不去重（每次都是新消息）',
    q.begin(undefined).duplicate === false && q.begin(undefined).duplicate === false)
}

// ── 3. 顺序等待：A active 时 B/C 必须等 ──────────────────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('a')
  const b = q.begin('b')
  const c = q.begin('c')

  const t1 = await q.awaitTurn(a.seq)
  ok('A 拿到当前回合', t1 === true && q.status.get(a.seq) === ACTIVE)

  let bGot = false
  const pB = q.awaitTurn(b.seq).then((r) => { bGot = r; return r })
  await sleep(20)
  ok('B 在 A 未结束时拿不到回合（这是核心保证）', bGot === false, String(bGot))
  ok('B 仍是 pending', q.status.get(b.seq) === PENDING)

  q.finish(a.seq)
  const rb = await pB
  ok('A 结束后 B 立刻拿到回合', rb === true && bGot === true)

  q.finish(b.seq)
  const rc = await q.awaitTurn(c.seq)
  ok('C 随后也能拿到', rc === true)
  q.finish(c.seq)
}

// ── 4. 发送顺序 === 到达顺序（端到端）────────────────────────────────────
{
  const q = new FollowUpQueue()
  const order = []
  const seqs = [q.begin('1').seq, q.begin('2').seq, q.begin('3').seq]

  // 三条并发"处理"，各自等待轮到自己
  const tasks = seqs.map(async (seq) => {
    const mine = await q.awaitTurn(seq)
    if (mine !== true) return
    order.push(seq)
    await sleep(5)
    q.finish(seq)
  })
  await Promise.all(tasks)
  ok('发送顺序等于到达顺序', JSON.stringify(order) === JSON.stringify(seqs),
    JSON.stringify(order) + ' vs ' + JSON.stringify(seqs))
}

// ── 5. consumed：被前面的处理顺带消化，不再单独回复 ──────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('a')
  const b = q.begin('b')

  const t1 = await q.awaitTurn(a.seq)
  ok('A 拿到回合', t1 === true)

  // A 处理时把 B 顺带看进去了 → B 标 consumed
  q.markConsumed(b.seq)
  ok('B 被标为 consumed', q.status.get(b.seq) === CONSUMED)

  q.finish(a.seq)
  // 队首推进后应跳过 B
  const rb = await q.awaitTurn(b.seq)
  ok('B 拿不到回合（已被消化，不该重复回复）', rb === false)
  ok('队首已越过 B', q.nextTurn === 2, String(q.nextTurn))
}

// ── 6. 不死锁：槽位全部结束后 active 复位 ───────────────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('a')
  await q.awaitTurn(a.seq)
  ok('处理中 active=true', q.isActive() === true)
  q.finish(a.seq)
  ok('全部结束后 active=false', q.isActive() === false)
  ok('槽位清空', q.snapshot().slots.length === 0)
}

// ── 7. 超时释放：头阻塞有上限，不会永久卡死 ─────────────────────────────
{
  const q = new FollowUpQueue()
  const a = q.begin('a')
  const b = q.begin('b')
  // 故意不给 A 任何结束 → B 只能靠超时释放
  const rb = await q.awaitTurn(b.seq, 60)
  ok('超时后 B 仍能拿到回合（不允许卡死）', rb === true, String(rb))
  ok('B 被置为 active', q.status.get(b.seq) === ACTIVE)
  q.finish(b.seq)
}

// ── 8. 静默窗合并 ───────────────────────────────────────────────────────
{
  const d = new Debouncer(200)
  d.push('m1', 1000)
  d.push('m2', 1100)
  ok('窗内不触发', d.ready(1150) === false)
  ok('批次里有两条', d.size === 2)
  d.push('m3', 1200)
  ok('继续推会刷新静默窗', d.ready(1350) === false)
  ok('静默窗过了才就绪', d.ready(1420) === true)

  const batch = d.take()
  ok('取走批次内容正确', JSON.stringify(batch) === JSON.stringify(['m1', 'm2', 'm3']), JSON.stringify(batch))
  ok('取走后清空', d.size === 0)
  ok('空批不就绪', d.ready(99999) === false)
}

// ── 9. 频率上限：超限丢弃而不是排队 ─────────────────────────────────────
{
  const rl = new RateLimiter(5, 3)
  const now = 1_000_000
  const results = []
  for (let i = 0; i < 6; i += 1) {
    // 每条间隔 10 秒，避开突发限制
    results.push(rl.allow(now + i * 10000))
  }
  ok('前 5 条放行', results.slice(0, 5).every((x) => x === true), JSON.stringify(results))
  ok('第 6 条被每分钟上限拦下', results[5] === false, JSON.stringify(results))

  // 一分钟窗口滑过后恢复
  ok('窗口滑过后恢复', rl.allow(now + 5 * 10000 + 61000) === true)
}

// ── 10. 突发限制 ─────────────────────────────────────────────────────────
{
  const rl = new RateLimiter(100, 3)
  const now = 2_000_000
  ok('3 秒内第 1 条放行', rl.allow(now) === true)
  ok('第 2 条放行', rl.allow(now + 100) === true)
  ok('第 3 条放行', rl.allow(now + 200) === true)
  ok('第 4 条被突发限制拦下（防连珠炮）', rl.allow(now + 300) === false)
  ok('3 秒后恢复', rl.allow(now + 3200) === true)
}

// ── 11. 容错 ─────────────────────────────────────────────────────────────
{
  const q = new FollowUpQueue()
  let threw = false
  try {
    q.finish(999)
    q.markConsumed(999)
    const never = await q.awaitTurn(999)
    if (never !== false) threw = true
  } catch (error) { threw = true }
  ok('对不存在的槽位操作不抛（且 awaitTurn 返回 false）', threw === false)

  const d = new Debouncer()
  ok('默认静默窗为 200ms', d.silenceMs === 200, String(d.silenceMs))
  const rl = new RateLimiter()
  ok('默认限额为正数', rl.perMinute > 0 && rl.burst > 0)
}

console.log('\nfollowup 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
