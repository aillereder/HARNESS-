/**
 * NapCat / OneBot 11 HTTP 客户端。
 *
 * ## 与旧实现的关系
 *
 * 接口能力面照搬 `qqbot/probe/napcat_api.py`（那份是踩过坑的清单）：
 * 撤回、贴表情、戳一戳、OCR、历史拉取、正在输入、群管理、媒体。
 * 但用 Node 原生 `fetch` 实现，零依赖。
 *
 * ## 为什么不用 `ctx.web`
 *
 * DSH 的 `web` 服务只有 GET 且**不支持自定义 header**，而 OneBot 需要
 * POST + `Authorization: Bearer` + JSON body。所以走 Node 原生 fetch。
 *
 * ## 三条纪律（都是实测换来的）
 *
 * 1. **`soft` 只用于"预期会缺失且无所谓"的能力**（群里戳一戳、这个构建
 *    没实现的接口）。**发送必须非 soft** —— 旧版静默返回 None
 *    会把发送失败变成"已发送"日志。
 * 2. **每次发送返回 `message_id`，那是唯一可信的送达凭证。**
 * 3. **健康检查分四层**，因为存在"读通写不通"：只读接口全绿，但
 *    `send_private_msg` 一直报 `EventChecker Failed ... 网络连接异常!`
 *    —— 一个字都发不出去，而只读探针看不出来。
 */

import { healthVerdict } from './onebot.js'

/** 默认端口。NapCat 的 HTTP 与 WS 通常同端口（enableWebsocket=true）。 */
export const DEFAULT_HTTP = 'http://127.0.0.1:3000'

export class OneBotError extends Error {
  constructor(action, payload) {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    super(action + ' 失败：' + String(text).slice(0, 200))
    this.name = 'OneBotError'
    this.action = action
    this.payload = payload
  }
}

export class NapCatClient {
  /**
   * @param {object} [options]
   * @param {string} [options.http]  形如 http://127.0.0.1:3000
   * @param {string} [options.token] access_token
   * @param {number} [options.timeout]
   * @param {typeof fetch} [options.fetchImpl] 注入用（测试里换成假实现）
   */
  constructor(options) {
    const o = options === undefined || options === null ? {} : options
    this.http = (typeof o.http === 'string' && o.http.length > 0 ? o.http : DEFAULT_HTTP).replace(/\/+$/, '')
    this.token = typeof o.token === 'string' ? o.token : ''
    this.timeout = typeof o.timeout === 'number' && o.timeout > 0 ? o.timeout : 30000
    this.fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
    this.selfId = null
  }

  headers() {
    const h = { 'Content-Type': 'application/json' }
    if (this.token.length > 0) h.Authorization = 'Bearer ' + this.token
    return h
  }

  /**
   * 调一个 action。
   *
   * @param {string} action
   * @param {object} [params]
   * @param {{soft?: boolean, timeout?: number}} [opts]
   * @returns {Promise<any>} 成功时返回 data；soft 失败返回 null
   */
  async call(action, params, opts) {
    const p = params === undefined || params === null ? {} : params
    const o = opts === undefined || opts === null ? {} : opts
    const soft = o.soft === true
    const timeout = typeof o.timeout === 'number' && o.timeout > 0 ? o.timeout : this.timeout

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    let out
    try {
      const res = await this.fetchImpl(this.http + '/' + action, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(p),
        signal: controller.signal,
      })
      const text = await res.text()
      try {
        out = JSON.parse(text)
      } catch (error) {
        if (soft) return null
        throw new OneBotError(action, '响应不是 JSON：' + text.slice(0, 120))
      }
    } catch (error) {
      if (soft) return null
      if (error instanceof OneBotError) throw error
      throw new OneBotError(action, String(error && error.message ? error.message : error))
    } finally {
      clearTimeout(timer)
    }

    const code = out.retcode
    const failed = (code !== undefined && code !== null && code !== 0) || out.status === 'failed'
    if (failed) {
      if (soft) return null
      throw new OneBotError(action, out)
    }
    return out.data
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  async getLoginInfo() {
    const d = await this.call('get_login_info')
    if (d !== null && d !== undefined && d.user_id !== undefined) this.selfId = String(d.user_id)
    return d
  }

  async getStatus() {
    return this.call('get_status', {}, { soft: true })
  }

  async getVersionInfo() {
    return this.call('get_version_info', {}, { soft: true })
  }

  /**
   * 显示"正在输入"。纯装饰，失败无所谓 —— 但它是**感知延迟**的关键：
   * 用户看到她在打字，而模型还在生成。
   */
  async setInputStatus(userId, eventType) {
    return this.call('set_input_status', {
      user_id: String(userId),
      event_type: typeof eventType === 'number' ? eventType : 1,
    }, { soft: true })
  }

  // ── 消息 ──────────────────────────────────────────────────────────────

  /**
   * 发消息。**非 soft** —— 发送失败必须让调用方知道。
   *
   * 一条 `send_msg` 覆盖私聊与群聊（`message_type` 决定），比分开调少一次往返。
   *
   * @returns {Promise<number|undefined>} message_id（唯一可信凭证）
   */
  async sendMsg(message, target) {
    const t = target === undefined || target === null ? {} : target
    const params = { message: message }
    if (t.messageType) params.message_type = t.messageType
    if (t.userId !== undefined) params.user_id = String(t.userId)
    if (t.groupId !== undefined) params.group_id = String(t.groupId)
    const d = await this.call('send_msg', params)
    if (d !== null && d !== undefined && d.message_id !== undefined) return d.message_id
    return undefined
  }

  /** 撤回。 */
  async deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: String(messageId) }, { soft: true })
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: String(messageId) }, { soft: true })
  }

  /** 给消息贴表情 —— 一个很"像人"的轻量动作。 */
  async setMsgEmojiLike(messageId, emojiId, setLike) {
    return this.call('set_msg_emoji_like', {
      message_id: String(messageId),
      emoji_id: String(emojiId),
      set: setLike !== false,
    }, { soft: true })
  }

  async markMsgAsRead(messageId) {
    const p = messageId === undefined ? {} : { message_id: String(messageId) }
    return this.call('mark_msg_as_read', p, { soft: true })
  }

  /** NapCat 自带的 OCR —— 可以用来读贴在表情包里的字。 */
  async ocrImage(image) {
    return this.call('ocr_image', { image: image }, { soft: true })
  }

  // ── 好友 ──────────────────────────────────────────────────────────────

  async getFriendList(noCache) {
    return this.call('get_friend_list', { no_cache: noCache === true })
  }

  async getFriendMsgHistory(userId, count, messageSeq) {
    return this.call('get_friend_msg_history', {
      user_id: String(userId),
      count: typeof count === 'number' ? count : 20,
      message_seq: typeof messageSeq === 'number' ? messageSeq : 0,
      reverse_order: false,
    }, { soft: true })
  }

  async friendPoke(userId) {
    return this.call('friend_poke', { user_id: String(userId) })
  }

  async sendPoke(userId, groupId) {
    const p = {}
    if (userId !== undefined) p.user_id = String(userId)
    if (groupId !== undefined) p.group_id = String(groupId)
    return this.call('send_poke', p, { soft: true })
  }

  async sendLike(userId, times) {
    return this.call('send_like', {
      user_id: String(userId),
      times: String(typeof times === 'number' ? times : 1),
    }, { soft: true })
  }

  // ── 群 ────────────────────────────────────────────────────────────────

  async getGroupList(noCache) {
    return this.call('get_group_list', { no_cache: noCache === true })
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', {
      group_id: String(groupId), user_id: String(userId), no_cache: false,
    }, { soft: true })
  }

  async getGroupMsgHistory(groupId, count, messageSeq) {
    return this.call('get_group_msg_history', {
      group_id: String(groupId),
      count: typeof count === 'number' ? count : 20,
      message_seq: typeof messageSeq === 'number' ? messageSeq : 0,
      reverse_order: false,
    }, { soft: true })
  }

  async groupPoke(groupId, userId) {
    return this.call('group_poke', {
      group_id: String(groupId), user_id: String(userId),
    }, { soft: true })
  }

  async setGroupCard(groupId, userId, card) {
    return this.call('set_group_card', {
      group_id: String(groupId), user_id: String(userId), card: card,
    }, { soft: true })
  }

  // ── 媒体 ──────────────────────────────────────────────────────────────

  async getImage(file) {
    return this.call('get_image', { file: file }, { soft: true })
  }

  async getRecord(file, outFormat) {
    return this.call('get_record', {
      file: file, out_format: typeof outFormat === 'string' ? outFormat : 'mp3',
    }, { soft: true })
  }

  async canSendImage() {
    return this.call('can_send_image', {}, { soft: true })
  }

  // ── 健康检查（四层）───────────────────────────────────────────────────

  /**
   * 四层健康检查。
   *
   * @param {boolean} [deep] 是否测发送链路。**默认关** —— 发消息有副作用，
   *   不能每次刷新都测；控制台里手动点"深度自检"才做。
   * @returns {Promise<object>} 诊断字典（含 ok 与 why），不抛异常
   */
  async health(deep) {
    const out = {
      http: false, login: false, core: false, canSend: null,
      nickname: '', userId: null, why: '', ms: null, ok: false,
    }
    const t0 = Date.now()
    let info
    try {
      info = await this.getLoginInfo()
    } catch (error) {
      out.why = 'HTTP 不通：' + String(error && error.message ? error.message : error).slice(0, 80)
      out.ms = Date.now() - t0
      const v = healthVerdict(out)
      out.ok = v.ok
      if (out.why.length === 0) out.why = v.why
      return out
    }
    out.http = true
    if (info !== null && info !== undefined) {
      out.userId = info.user_id === undefined ? null : String(info.user_id)
      out.nickname = typeof info.nickname === 'string' ? info.nickname : ''
      out.login = out.userId !== null && out.userId.length > 0
    }

    try {
      const st = await this.getStatus()
      const good = st === null || st === undefined || st.good === undefined ? true : st.good === true
      out.core = good
      if (!good) out.why = '核心未就绪'
    } catch (error) {
      out.why = '状态查询失败'
    }

    if (out.why.length === 0 && !out.login) out.why = 'QQ 未登录（要扫码）'

    if (deep === true && out.login) {
      // 发给自己：自己收自己不会打扰别人，而且能真实反映发送链路。
      // 用 can_send_image 之类只读探针**测不出**"发送链路坏"这件事。
      try {
        await this.sendMsg([{ type: 'text', data: { text: '[自检]' } }], {
          messageType: 'private', userId: out.userId,
        })
        out.canSend = true
      } catch (error) {
        out.canSend = false
        const msg = String(error && error.message ? error.message : error)
        if (msg.indexOf('网络连接异常') >= 0 || msg.indexOf('EventChecker') >= 0) {
          out.why = '能读不能发：QQ 客户端网络层异常，重启 QQ 可解决'
        } else {
          out.why = '发送失败：' + msg.slice(0, 70)
        }
      }
    }

    out.ms = Date.now() - t0
    const v = healthVerdict(out)
    out.ok = v.ok
    out.why = out.why.length > 0 ? out.why : v.why
    return out
  }
}

// ── 消息段构造 helper（与旧实现同名，便于对照）──────────────────────────

export const seg = {
  text: (text) => ({ type: 'text', data: { text: String(text) } }),
  image: (pathOrUrl) => ({ type: 'image', data: { file: String(pathOrUrl) } }),
  face: (faceId) => ({ type: 'face', data: { id: Number(faceId) } }),
  at: (qq) => ({ type: 'at', data: { qq: String(qq) } }),
  reply: (messageId) => ({ type: 'reply', data: { id: String(messageId) } }),
}
