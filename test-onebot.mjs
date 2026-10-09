// 阶段 4 验证：lib/onebot.js 的事件解析、自消息判定、健康检查判定。
//
// 自消息判定必须有测试钉住：它是"bot 跟自己说话"的唯一防线，
// 而那个 bug 一旦出现就是无限循环。

import {
  healthVerdict, parseMessageEvent, sendTarget, shouldHandle, toPromptText,
} from './lib/onebot.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const ME = '3063567044'

/** 造一条私聊消息事件 */
function priv(from, text, extra) {
  const ev = {
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: from,
    time: 1800000000,
    message_id: 1001,
    message: [{ type: 'text', data: { text: text } }],
    sender: { user_id: from, nickname: 'Ailler' },
  }
  return Object.assign(ev, extra || {})
}

/** 造一条群聊消息事件 */
function group(from, text, extra) {
  const ev = {
    post_type: 'message',
    message_type: 'group',
    self_id: ME,
    user_id: from,
    group_id: '999',
    time: 1800000000,
    message_id: 2002,
    message: [{ type: 'text', data: { text: text } }],
    sender: { user_id: from, nickname: '老王', card: '老王', role: 'member' },
  }
  return Object.assign(ev, extra || {})
}

// ── 1. 基本解析 ───────────────────────────────────────────────────────────
{
  const p = parseMessageEvent(priv('1802352763', '在吗'))
  ok('解析出私聊消息', p !== null && p.kind === 'message')
  ok('type 正确', p.type === 'private')
  ok('text 正确', p.text === '在吗', p.text)
  ok('peer 是对方账号', p.peer === '1802352763', p.peer)
  ok('timeMs 由秒转毫秒', p.timeMs === 1800000000000, String(p.timeMs))
  ok('messageId 转成字符串', p.messageId === '1001', String(p.messageId))
}

// ── 2. 群聊的 peer 必须是群号，不是发消息的人 ────────────────────────────
{
  const p = parseMessageEvent(group('1802352763', '大家好'))
  ok('群聊 type 正确', p.type === 'group')
  ok('群聊 peer 是群号', p.peer === '999', p.peer)
  ok('群聊 groupId 有值', p.groupId === '999')
  ok('userId 仍是发消息的人', p.userId === '1802352763')
  ok('card 取到了', p.card === '老王')
}

// ── 3. 自消息判定：活消息路径 ────────────────────────────────────────────
{
  const mine = parseMessageEvent(priv(ME, '我说的'))
  ok('sender == self_id → isSelf', mine.isSelf === true)

  const theirs = parseMessageEvent(priv('1802352763', '他说的'))
  ok('sender != self_id → 不是自己', theirs.isSelf === false)
}

// ── 4. 自消息判定：历史回包路径（关键坑）─────────────────────────────────
{
  // 历史回包：post_type=message_sent，message_sent_type='self' 表示是自己发的
  const ownHistory = parseMessageEvent({
    post_type: 'message_sent',
    message_sent_type: 'self',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    message: [{ type: 'text', data: { text: '我以前说的话' } }],
    sender: { user_id: ME },
  })
  ok('历史里自己发的被识别为 isSelf（忽略它会全当成对方说的）',
    ownHistory !== null && ownHistory.isSelf === true,
    ownHistory === null ? 'null' : String(ownHistory.isSelf))

  const peerHistory = parseMessageEvent({
    post_type: 'message_sent',
    message_sent_type: 'other',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    message: [{ type: 'text', data: { text: '他以前说的话' } }],
    sender: { user_id: '1802352763' },
  })
  ok('历史里对方发的不是 isSelf',
    peerHistory !== null && peerHistory.isSelf === false)
}

// ── 5. 自消息判定：回落到兜底 selfId ─────────────────────────────────────
{
  const ev = {
    post_type: 'message',
    message_type: 'private',
    user_id: '1802352763',
    time: 1800000000,
    message: [{ type: 'text', data: { text: 'x' } }],
    sender: { user_id: ME }, // 事件里没有 self_id，靠参数兜底
  }
  const p = parseMessageEvent(ev, ME)
  ok('事件无 self_id 时用传入的兜底值判自消息', p.isSelf === true)
}

// ── 6. 不回应的情形 ──────────────────────────────────────────────────────
{
  const self = parseMessageEvent(priv(ME, '我自己的话'))
  ok('自己的消息不该处理（防死循环）',
    shouldHandle(self).ok === false && shouldHandle(self).reason === 'self-message',
    JSON.stringify(shouldHandle(self)))

  const empty = parseMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    message: [],
    sender: { user_id: '1802352763' },
  })
  ok('空消息不该处理', shouldHandle(empty).ok === false && shouldHandle(empty).reason === 'empty')

  ok('正常消息该处理', shouldHandle(parseMessageEvent(priv('1802352763', '你好'))).ok === true)
  ok('畸形输入安全', shouldHandle(null).ok === false)
}

// ── 7. 只有图片没有文字，仍该处理（多模态）──────────────────────────────
{
  const p = parseMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    message: [{ type: 'image', data: { file: 'abc.jpg', url: 'http://x/y.jpg' } }],
    sender: { user_id: '1802352763' },
  })
  ok('纯图片消息被解析出 images', p.images.length === 1)
  ok('纯图片消息仍该处理（交给多模态模型看）', shouldHandle(p).ok === true)
}

// ── 8. 各类消息段抽取 ────────────────────────────────────────────────────
{
  const p = parseMessageEvent({
    post_type: 'message',
    message_type: 'group',
    self_id: ME,
    user_id: '1802352763',
    group_id: '999',
    time: 1800000000,
    message: [
      { type: 'at', data: { qq: ME } },
      { type: 'text', data: { text: ' 帮我看看' } },
      { type: 'image', data: { file: 'a.jpg' } },
      { type: 'face', data: { id: 14 } },
      { type: 'reply', data: { id: '555' } },
      { type: 'record', data: { file: 'r.silk' } },
    ],
    sender: { user_id: '1802352763' },
  })
  ok('@ 被记录', p.ats.length === 1 && p.ats[0] === ME)
  ok('@ 也进文本', p.text.indexOf('@' + ME) >= 0, p.text)
  ok('图片被记录', p.images.length === 1)
  ok('表情 id 被记录', p.faces.length === 1 && String(p.faces[0]) === '14')
  ok('回复 id 被记录', p.replies.length === 1 && String(p.replies[0]) === '555')
  ok('语音有占位符', p.text.indexOf('[语音]') >= 0, p.text)
}

// ── 9. raw_message 兜底 ─────────────────────────────────────────────────
{
  const p = parseMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    raw_message: '只有 raw 的情况',
    sender: { user_id: '1802352763' },
  })
  ok('无 message 段时用 raw_message 兜底', p.text === '只有 raw 的情况', p.text)
}

// ── 10. 非消息事件返回 null ──────────────────────────────────────────────
{
  ok('notice 事件返回 null', parseMessageEvent({ post_type: 'notice' }) === null)
  ok('meta_event 返回 null', parseMessageEvent({ post_type: 'meta_event' }) === null)
  ok('message_type 非法返回 null',
    parseMessageEvent({ post_type: 'message', message_type: 'channel' }) === null)
  ok('null 安全', parseMessageEvent(null) === null)
}

// ── 11. 健康检查：四层判定，关键在"能读不能发" ──────────────────────────
{
  const good = healthVerdict({ http: true, login: true, core: true, canSend: true })
  ok('四层全通判健康', good.ok === true, good.why)

  const readOnly = healthVerdict({ http: true, login: true, core: true, canSend: false })
  ok('能读不能发 → 判不健康（旧的"只看接口"会误判为健康）',
    readOnly.ok === false && readOnly.why.indexOf('能读不能发') >= 0, readOnly.why)

  const noHttp = healthVerdict({ http: false, login: false, core: false, canSend: null })
  ok('HTTP 不通 → 不健康', noHttp.ok === false && noHttp.why.indexOf('HTTP') >= 0, noHttp.why)

  const noLogin = healthVerdict({ http: true, login: false, core: false, canSend: null })
  ok('未登录 → 不健康', noLogin.ok === false && noLogin.why.indexOf('登录') >= 0, noLogin.why)

  const untested = healthVerdict({ http: true, login: true, core: true, canSend: null })
  ok('读侧健康、未测发送 → 判健康但说明未测',
    untested.ok === true && untested.why.indexOf('未测') >= 0, untested.why)

  const empty = healthVerdict(null)
  ok('空输入 → 不健康', empty.ok === false)
}

// ── 12. 发送目标：一条 send_msg 覆盖两种场景 ─────────────────────────────
{
  const g = sendTarget(parseMessageEvent(group('1802352763', 'x')))
  ok('群聊目标是群号', g.method === 'send_msg' && g.params.message_type === 'group'
    && g.params.group_id === '999', JSON.stringify(g))

  const p = sendTarget(parseMessageEvent(priv('1802352763', 'x')))
  ok('私聊目标是对谈者', p.method === 'send_msg' && p.params.message_type === 'private'
    && p.params.user_id === '1802352763', JSON.stringify(p))
}

// ── 13. toPromptText 不试图理解图片 ─────────────────────────────────────
{
  const p = parseMessageEvent({
    post_type: 'message',
    message_type: 'private',
    self_id: ME,
    user_id: '1802352763',
    time: 1800000000,
    message: [
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { file: 'a.jpg' } },
    ],
    sender: { user_id: '1802352763', nickname: 'Ailler' },
  })
  const t = toPromptText(p)
  ok('提示文本含说话人', t.indexOf('Ailler') >= 0, t)
  ok('提示文本含正文', t.indexOf('看这个') >= 0, t)
  ok('图片只留占位、不自行描述', t.indexOf('[发了 1 张图]') >= 0, t)
}

console.log('\nonebot 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
