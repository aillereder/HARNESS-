/**
 * OneBot 11 事件解析 —— 纯逻辑，与网络无关。
 *
 * ## 两条踩过的坑，必须照搬
 *
 * ### 1. 自消息判定（否则 bot 会跟自己说话）
 *
 * 本部署 `reportSelfMessage` 应保持**关闭** —— 打开就是"bot 自己跟自己说话"。
 * 但历史回包（`get_friend_msg_history` / `get_group_msg_history`）走的是
 * `post_type === 'message_sent'`，需要靠 `message_sent_type === 'self'` 判定归属。
 * 旧实现的注释记录了这个坑：忽略它会让**每一条历史消息都看起来像对方发的**。
 *
 * 判定优先级（照旧实现，顺序不能变）：
 *   1. `message_sent_type === 'self'` → 是我的
 *   2. `message_sent_type` 有值但不是 self → 不是我的
 *   3. `sender.user_id === event.self_id` → 是我的
 *   4. `sender.user_id === event.user_id` → 不是我发的（活消息）
 *
 * ### 2. `peer` 与 `user_id` 不是一回事
 *
 * 群聊里"这次对话的另一方"是**群**，不是发消息的人。
 * 拿 `user_id` 当 peer 会让同一个群里每个人各开一份记忆 —— 那是错的。
 */

/** 需要从消息段里抽取的文本类片段。 */
const TEXT_PLACEHOLDER = {
  record: '[语音]',
  file: '[文件]',
  json: '[卡片]',
  video: '[视频]',
  music: '[音乐]',
  forward: '[合并转发]',
  node: '[合并转发]',
  rps: '[猜拳]',
  dice: '[骰子]',
  shake: '[窗口抖动]',
  poke: '[戳一戳]',
}

function readNumberString(v) {
  if (typeof v === 'string' && v.length > 0) return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return ''
}

/**
 * 解析一条消息事件。
 *
 * @param {object} ev OneBot 事件对象
 * @param {string} [selfId] 由启动时的 get_login_info 提供的自身账号（兜底用）
 * @returns {object|null} 不是消息事件则返回 null
 */
export function parseMessageEvent(ev, selfId) {
  if (ev === null || ev === undefined || typeof ev !== 'object') return null
  const postType = ev.post_type
  if (postType !== 'message' && postType !== 'message_sent') return null

  const messageType = ev.message_type
  if (messageType !== 'private' && messageType !== 'group') return null

  const sid = readNumberString(ev.self_id)
  const uid = readNumberString(ev.user_id)
  const groupId = readNumberString(ev.group_id)

  // 消息段：某些构建只填 raw_message
  let segs = ev.message
  if (!Array.isArray(segs) || segs.length === 0) {
    if (typeof ev.raw_message === 'string' && ev.raw_message.length > 0) {
      segs = [{ type: 'text', data: { text: ev.raw_message } }]
    } else {
      segs = []
    }
  }

  const textParts = []
  const images = []
  const faces = []
  const ats = []
  const replies = []

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i]
    if (seg === null || seg === undefined || typeof seg !== 'object') continue
    const type = seg.type
    const data = seg.data === null || seg.data === undefined ? {} : seg.data

    if (type === 'text') {
      if (typeof data.text === 'string') textParts.push(data.text)
    } else if (type === 'image') {
      images.push({
        file: data.file,
        url: data.url,
        summary: data.summary,
        subType: data.sub_type,
      })
    } else if (type === 'face' || type === 'mface') {
      faces.push(data.id === undefined ? data.emoji_id : data.id)
    } else if (type === 'at') {
      const qq = readNumberString(data.qq)
      ats.push(qq)
      if (qq.length > 0) textParts.push('@' + qq)
    } else if (type === 'reply') {
      replies.push(data.id)
    } else if (typeof TEXT_PLACEHOLDER[type] === 'string') {
      textParts.push(TEXT_PLACEHOLDER[type])
    }
  }

  const sender = ev.sender === null || ev.sender === undefined ? {} : ev.sender
  const senderUserId = readNumberString(sender.user_id)

  // 自消息判定（顺序即优先级，不要重排）
  let isSelf
  const sentKind = ev.message_sent_type
  if (sentKind === 'self') {
    isSelf = true
  } else if (typeof sentKind === 'string' && sentKind.length > 0) {
    isSelf = false
  } else if (sid.length > 0 && senderUserId.length > 0) {
    isSelf = senderUserId === sid
  } else if (typeof selfId === 'string' && selfId.length > 0 && senderUserId.length > 0) {
    isSelf = senderUserId === selfId
  } else {
    isSelf = sid.length > 0 && uid.length > 0 && uid === sid
  }

  // peer：群聊是群号，私聊是对方账号
  let peer
  if (messageType === 'group' && groupId.length > 0) peer = groupId
  else peer = uid

  const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : Math.floor(Date.now() / 1000)

  return {
    kind: 'message',
    messageId: ev.message_id === undefined ? undefined : String(ev.message_id),
    timeMs: time * 1000,
    type: messageType,
    userId: uid,
    groupId: groupId.length > 0 ? groupId : undefined,
    peer: peer,
    selfId: sid.length > 0 ? sid : selfId,
    isSelf: isSelf,
    senderId: senderUserId,
    nickname: typeof sender.nickname === 'string' ? sender.nickname : '',
    card: typeof sender.card === 'string' ? sender.card : '',
    role: typeof sender.role === 'string' ? sender.role : '',
    text: textParts.join('').trim(),
    images: images,
    faces: faces,
    ats: ats,
    replies: replies,
  }
}

/**
 * 消息是否值得起一轮处理。
 *
 * 过滤规则（都是必须的）：
 *   · 自己的消息 → 丢弃（防自回声死循环）
 *   · 空内容且无图 → 丢弃（纯表情/系统提示不回应）
 *   · @了别人但没 @我 → 另说（本函数不判，交给宿主侧的策略）
 *
 * @param {object} parsed parseMessageEvent 的结果
 * @returns {{ok: boolean, reason?: string}}
 */
export function shouldHandle(parsed) {
  if (parsed === null || parsed === undefined) return { ok: false, reason: 'not-a-message' }
  if (parsed.isSelf === true) return { ok: false, reason: 'self-message' }
  const hasText = typeof parsed.text === 'string' && parsed.text.length > 0
  const hasImage = Array.isArray(parsed.images) && parsed.images.length > 0
  if (!hasText && !hasImage) return { ok: false, reason: 'empty' }
  return { ok: true }
}

/**
 * 把消息转成给模型看的文本。
 *
 * 图片不在这里"理解" —— 多模态模型直接吃 image block（`deepseek-flash`
 * 的 `inputModalities` 含 image），所以这里只留一个占位说明，
 * 真正的理解交给模型。这也是图上「视觉模型」不需要额外代码的原因。
 */
export function toPromptText(parsed, displayName) {
  if (parsed === null || parsed === undefined) return ''
  const who = typeof displayName === 'string' && displayName.length > 0
    ? displayName
    : (parsed.card.length > 0 ? parsed.card : (parsed.nickname.length > 0 ? parsed.nickname : parsed.senderId))
  const parts = []
  if (parsed.type === 'group') parts.push('在群 ' + parsed.groupId + ' 里，' + who + ' 说：')
  else parts.push(who + ' 说：')
  if (parsed.text.length > 0) parts.push(parsed.text)
  const imgCount = Array.isArray(parsed.images) ? parsed.images.length : 0
  if (imgCount > 0) parts.push('[发了 ' + imgCount + ' 张图]')
  const faceCount = Array.isArray(parsed.faces) ? parsed.faces.length : 0
  if (faceCount > 0) parts.push('[表情 x' + faceCount + ']')
  return parts.join(' ')
}

/**
 * 健康检查结果判定 —— **三层，不能只看接口通不通**。
 *
 * 旧实现实测踩过的坑（注释原文）：
 *   > 有一段时间 get_login_info、get_friend_list 全部正常返回，coreReady 也是
 *   > true，但 send_private_msg 一直报 `EventChecker Failed ... "网络连接异常!"`
 *   > —— 那 QQ 客户端自己的网络层坏了。如果健康检查只看"接口通不通"，
 *   > 这种情况会被判成健康的，而 bot 实际上一个字都发不出去。
 *
 * 所以分四层，任何一层挂了都要能看出来。
 *
 * @param {{http: boolean, login: boolean, core: boolean, canSend: boolean|null}} probe
 * @returns {{ok: boolean, why: string}}
 */
export function healthVerdict(probe) {
  const p = probe === null || probe === undefined ? {} : probe
  if (p.http !== true) return { ok: false, why: 'HTTP 不通（NapCat 没起来或端口不对）' }
  if (p.login !== true) return { ok: false, why: 'QQ 未登录（需要扫码）' }
  if (p.core !== true) return { ok: false, why: 'NapCat 核心未就绪' }
  if (p.canSend === false) return { ok: false, why: '能读不能发：QQ 客户端网络层异常，重启 QQ 可解决' }
  if (p.canSend === null || p.canSend === undefined) {
    return { ok: true, why: '读侧健康；发送链路未测（深度自检才测）' }
  }
  return { ok: true, why: '四层全通' }
}

/**
 * 由解析结果构造发送目标。
 *
 * 一条 `send_msg` 就能覆盖两种场景，不必分开调 ——
 * 少一次 HTTP 往返，对延迟有实际意义。
 *
 * @param {object} parsed
 * @returns {{method: 'send_msg', params: object}}
 */
export function sendTarget(parsed) {
  if (parsed !== null && parsed !== undefined && parsed.type === 'group' && parsed.groupId) {
    return { method: 'send_msg', params: { message_type: 'group', group_id: parsed.groupId } }
  }
  const userId = parsed !== null && parsed !== undefined ? (parsed.userId || parsed.peer) : undefined
  return { method: 'send_msg', params: { message_type: 'private', user_id: userId } }
}
