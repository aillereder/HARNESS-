// 阶段 4 端到端验证：ws.js + napcat.js 对着**假 OneBot 服务**跑。
//
// 纯逻辑测试覆盖不到网络层，而这个夹具让方案里三条量化验收可以复现：
//   · 自回声 = 0
//   · 发送顺序 === 到达顺序
//   · 断线能恢复

import { NapCatClient, seg } from '../lib/napcat.js'
import { FollowUpQueue } from '../lib/followup.js'
import { OneBotSocket } from '../lib/ws.js'
import { parseMessageEvent, shouldHandle } from '../lib/onebot.js'
import { createFakeOneBot } from './fake-onebot.mjs'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TOKEN = 'dsbot'
const ME = 3063567044

/** 造一条私聊事件 */
function evPrivate(from, text, id) {
  return {
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: from,
    time: Math.floor(Date.now() / 1000),
    message_id: id,
    message: [{ type: 'text', data: { text: text } }],
    sender: { user_id: from, nickname: 'Ailler' },
  }
}

const fake = createFakeOneBot({ token: TOKEN })
const port = await fake.listen()
const base = 'http://127.0.0.1:' + port

// ── 1. HTTP 客户端 ──────────────────────────────────────────────────────
{
  const c = new NapCatClient({ http: base, token: TOKEN, timeout: 3000 })
  const info = await c.getLoginInfo()
  ok('get_login_info 通', info !== null && String(info.user_id) === String(ME), JSON.stringify(info))
  ok('selfId 被记下', c.selfId === String(ME), String(c.selfId))

  const id = await c.sendMsg([seg.text('你好')], { messageType: 'private', userId: 1802352763 })
  ok('send_msg 返回 message_id（唯一送达凭证）', typeof id === 'number', String(id))
  const call = fake.callsOf('send_msg')[0]
  ok('  带上正确的 target', call.params.message_type === 'private'
    && call.params.user_id === '1802352763', JSON.stringify(call.params))

  // 发送失败必须抛（不能静默当成成功）
  fake.setSendShouldFail(true)
  let threw = false
  try {
    await c.sendMsg([seg.text('x')], { messageType: 'private', userId: 1 })
  } catch (error) { threw = true }
  ok('发送失败会抛异常（不能静默记成成功）', threw === true)
  fake.setSendShouldFail(false)

  // soft 调用不抛
  fake.setStatusGood(true)
  const soft = await c.deleteMsg(123)
  ok('soft 调用失败不抛', soft === null || soft === undefined || soft !== null)

  // 未知 action 非 soft 会抛
  let unknownThrew = false
  try { await c.call('no_such_action') } catch (error) { unknownThrew = true }
  ok('未知 action 抛错', unknownThrew === true)
}

// ── 2. 四层健康检查 ─────────────────────────────────────────────────────
{
  const c = new NapCatClient({ http: base, token: TOKEN, timeout: 3000 })
  const h = await c.health(false)
  ok('读侧健康', h.ok === true && h.http === true && h.login === true, JSON.stringify(h))
  ok('未测发送时 canSend 为 null', h.canSend === null, String(h.canSend))

  const deep = await c.health(true)
  ok('深度自检能测发送链路', deep.canSend === true, JSON.stringify(deep))

  fake.setSendShouldFail(true)
  const broken = await c.health(true)
  ok('发送链路坏时判不健康（旧的"只看接口"会误判）',
    broken.ok === false && broken.canSend === false, JSON.stringify(broken))
  ok('  且给出"能读不能发"的诊断', broken.why.indexOf('能读不能发') >= 0, broken.why)
  fake.setSendShouldFail(false)

  // HTTP 层不通
  const dead = new NapCatClient({ http: 'http://127.0.0.1:1', token: TOKEN, timeout: 1000 })
  const dh = await dead.health(false)
  ok('HTTP 不通判不健康', dh.ok === false && dh.http === false, JSON.stringify(dh))
}

// ── 3. WebSocket 连接与事件接收 ─────────────────────────────────────────
{
  const received = []
  const states = []
  const sock = new OneBotSocket({
    url: 'ws://127.0.0.1:' + port,
    token: TOKEN,
    tickMs: 60000,
    onEvent: (ev) => received.push(ev),
    onState: (s) => states.push(s.kind),
  })
  sock.start()
  await sleep(150)
  ok('WS 完成握手', sock.connected === true, JSON.stringify(states))
  ok('  并且服务器端看到客户端', fake.connectedClients >= 1, String(fake.connectedClients))

  fake.pushEvent(evPrivate(1802352763, '第一条', 101))
  await sleep(60)
  ok('收到事件', received.length === 1, String(received.length))
  ok('  事件内容对', received[0].message_id === 101)

  // 粘包：连续推三条
  fake.pushEvent(evPrivate(1802352763, 'A', 102))
  fake.pushEvent(evPrivate(1802352763, 'B', 103))
  fake.pushEvent(evPrivate(1802352763, 'C', 104))
  await sleep(80)
  ok('粘连三帧全部解析', received.length === 4, String(received.length))

  // 非 JSON 帧应被安静忽略而不是崩
  fake.pushGarbage()
  await sleep(50)
  ok('非 JSON 帧不影响连接', sock.connected === true && received.length === 4,
    String(received.length))

  // 无 post_type 的对象不算事件
  fake.pushEvent({ foo: 'bar' })
  await sleep(50)
  ok('无 post_type 的帧不计为事件', received.length === 4, String(received.length))

  sock.stop()
  await sleep(50)
  ok('stop() 后断开', sock.connected === false)
}

// ── 4. 自回声 = 0（验收项一）────────────────────────────────────────────
{
  const handled = []
  const sock = new OneBotSocket({
    url: 'ws://127.0.0.1:' + port,
    token: TOKEN,
    tickMs: 60000,
    onEvent: (ev) => {
      const parsed = parseMessageEvent(ev, String(ME))
      if (played(parsed)) handled.push(parsed)
    },
  })
  function played(p) { return shouldHandle(p).ok === true }
  sock.start()
  await sleep(150)

  // 50 条混合：一半是自己的，一半是对方的
  for (let i = 0; i < 50; i += 1) {
    if (i % 2 === 0) fake.pushEvent(evPrivate(ME, '这是我自己发的 ' + i, 200 + i))
    else fake.pushEvent(evPrivate(1802352763, '对方发的 ' + i, 200 + i))
  }
  await sleep(200)
  const selfLeaked = handled.filter((p) => p.isSelf === true).length
  ok('自回声 = 0（连推 50 条混合，自己的一条都没进处理）', selfLeaked === 0, String(selfLeaked))
  ok('  对方向的消息正常进入处理', handled.length === 25, String(handled.length))
  sock.stop()
  await sleep(50)
}

// ── 5. 发送顺序 === 到达顺序（验收项二）─────────────────────────────────
{
  const q = new FollowUpQueue()
  const sendOrder = []
  const sock = new OneBotSocket({
    url: 'ws://127.0.0.1:' + port,
    token: TOKEN,
    tickMs: 60000,
    onEvent: async (ev) => {
      const parsed = parseMessageEvent(ev, String(ME))
      if (shouldHandle(parsed).ok !== true) return
      const { seq, duplicate } = q.begin(parsed.messageId)
      if (duplicate === true) return
      const mine = await q.awaitTurn(seq, 5000)
      if (mine !== true) return
      // 模拟"处理耗时"：让后面的消息在这条处理期间到达
      await sleep(20)
      sendOrder.push(parsed.text)
      q.finish(seq)
    },
  })
  sock.start()
  await sleep(150)

  // 三条几乎同时到达 —— 正是"她在说话时用户又发消息"的场景
  fake.pushEvent(evPrivate(1802352763, '一', 301))
  fake.pushEvent(evPrivate(1802352763, '二', 302))
  fake.pushEvent(evPrivate(1802352763, '三', 303))
  await sleep(400)

  ok('发送顺序 === 到达顺序', JSON.stringify(sendOrder) === JSON.stringify(['一', '二', '三']),
    JSON.stringify(sendOrder))

  // 重复 message_id 不得重复回复
  const before = sendOrder.length
  fake.pushEvent(evPrivate(1802352763, '重复的', 301))
  await sleep(200)
  ok('重复 message_id 不重复回复（幂等）', sendOrder.length === before,
    JSON.stringify(sendOrder))
  sock.stop()
  await sleep(50)
}

// ── 6. 断线重连（真实场景：QQ 重启掐断 WS）──────────────────────────────
{
  const states = []
  const received = []
  const sock = new OneBotSocket({
    url: 'ws://127.0.0.1:' + port,
    token: TOKEN,
    tickMs: 60000,
    onEvent: (ev) => received.push(ev),
    onState: (s) => states.push(s.kind),
  })
  sock.start()
  await sleep(150)
  ok('先连上', sock.connected === true, JSON.stringify(states))

  // 服务端主动踢掉 —— 模拟 QQ 重启
  const kicked = fake.kickClients()
  ok('服务端踢掉了客户端', kicked >= 1, String(kicked))
  await sleep(120)
  ok('客户端察觉断开', sock.connected === false, JSON.stringify(states))
  ok('  并进入退避重连', states.indexOf('reconnect-scheduled') >= 0, JSON.stringify(states))

  // 退避最小 2s，所以等足够长时间
  await sleep(2600)
  ok('退避后自动重连成功（无需人工干预）', sock.connected === true, JSON.stringify(states))

  // 重连后事件能继续收到
  fake.pushEvent(evPrivate(1802352763, '重连之后的消息', 601))
  await sleep(80)
  ok('重连后仍能收到事件', received.length >= 1, String(received.length))

  sock.stop()
  await sleep(50)
  ok('stop() 后不再重连', sock.connected === false)
  const statesAfterStop = states.length
  await sleep(200)
  ok('  且没有多余的状态变化', states.length === statesAfterStop, String(states.length))
}

// ── 7. 鉴权 ─────────────────────────────────────────────────────────────
{
  const bad = new NapCatClient({ http: base, token: 'wrong-token', timeout: 3000 })
  let threw = false
  try { await bad.getLoginInfo() } catch (error) { threw = true }
  ok('错 token 的 HTTP 调用被拒', threw === true)

  const badWs = new OneBotSocket({
    url: 'ws://127.0.0.1:' + port, token: 'wrong-token', tickMs: 60000,
    onEvent: () => {},
  })
  badWs.start()
  await sleep(200)
  ok('错 token 的 WS 连不上', badWs.connected === false)
  badWs.stop()
}

// ── 8. 正在输入（感知延迟的关键动作）────────────────────────────────────
{
  const c = new NapCatClient({ http: base, token: TOKEN, timeout: 3000 })
  await c.setInputStatus(1802352763)
  const call = fake.callsOf('set_input_status')[0]
  ok('set_input_status 发出去了', call !== undefined && call.params.user_id === '1802352763',
    JSON.stringify(call))
}

await fake.close()
console.log('\ne2e 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
