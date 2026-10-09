/**
 * 最小 WebSocket 客户端 —— 网络层。
 *
 * 帧编解码在 `ws-frame.js`（纯逻辑、已单测）；这里只负责：
 *   · TCP 连接与 HTTP Upgrade 握手（含 Sec-WebSocket-Accept 校验）
 *   · 增量收包（粘包/半包都要对）
 *   · 发文本帧（客户端必须 mask）
 *   · ping → 自动回 pong
 *   · **重连与半死检测**
 *
 * ## 为什么需要"半死检测"
 *
 * 旧实现实测记录（`napcat_api.py` 的 listen 注释）：
 *
 *   > 重连不是可有可无的 —— WS 卡在一个半死状态时（TCP 还在、对端不再推事件）
 *   > 它自己**永远不会**发现，因为没有任何错误发生。
 *
 * 所以需要一个**基于静默的 tick**：socket 读超时不是错误，而是"这一段时间
 * 没有事件"。宿主侧可以在这个时机做健康检查，必要时主动重连。
 *
 * ## 为什么手写而不引 `ws`
 *
 * `ws` 只是 `dsh` 的**传递依赖**（不在其直接依赖列表里），版本随上游变。
 * 本插件的目标是零依赖、装完即用。RFC6455 客户端的实际需求很小，
 * 而少一个依赖就少一处"装不上"的可能。
 */

import net from 'node:net'
import tls from 'node:tls'
import crypto from 'node:crypto'

import {
  OPCODE, WS_GUID, acceptKeyInput, decodeFrame, decodeText,
  encodeFrame, encodeText, handshakeAccepted, handshakeRequest,
} from './ws-frame.js'

/** 重连退避的上下限（毫秒）。 */
export const BACKOFF_MIN_MS = 2000
export const BACKOFF_MAX_MS = 60000

/**
 * 解析 ws/wss URL。
 * @param {string} url
 * @returns {{secure: boolean, host: string, port: number, path: string, hostHeader: string}|null}
 */
export function parseWsUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null
  let rest
  let secure
  if (url.indexOf('wss://') === 0) { secure = true; rest = url.slice(6) }
  else if (url.indexOf('ws://') === 0) { secure = false; rest = url.slice(5) }
  else return null

  const slash = rest.indexOf('/')
  const authority = slash >= 0 ? rest.slice(0, slash) : rest
  const path = slash >= 0 ? rest.slice(slash) : '/'
  if (authority.length === 0) return null

  const colon = authority.lastIndexOf(':')
  let host = authority
  let port = secure ? 443 : 80
  if (colon > 0) {
    const p = Number(authority.slice(colon + 1))
    if (!Number.isFinite(p) || p <= 0 || p > 65535) return null
    host = authority.slice(0, colon)
    port = p
  }
  if (host.length === 0) return null
  return { secure: secure, host: host, port: port, path: path, hostHeader: authority }
}

/** 计算并校验 Sec-WebSocket-Accept。 */
export function expectedAccept(key) {
  return crypto.createHash('sha1').update(acceptKeyInput(key)).digest('base64')
}

/**
 * 一个 OneBot 事件流连接。
 *
 * 用法：
 *   const c = new OneBotSocket({ url, token, onEvent, onTick })
 *   c.start()
 *   ...
 *   c.stop()
 */
export class OneBotSocket {
  /**
   * @param {object} options
   * @param {string} options.url            形如 ws://127.0.0.1:3000
   * @param {string} [options.token]        access_token
   * @param {(ev: object) => void} [options.onEvent]
   * @param {() => boolean} [options.onTick] 静默期回调；返回 true 表示请求重连
   * @param {(info: object) => void} [options.onState] 状态变化（连接/断开）
   * @param {number} [options.tickMs]       静默 tick 周期
   */
  constructor(options) {
    const o = options === undefined || options === null ? {} : options
    this.url = o.url
    this.token = typeof o.token === 'string' ? o.token : ''
    this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null
    this.onTick = typeof o.onTick === 'function' ? o.onTick : null
    this.onState = typeof o.onState === 'function' ? o.onState : null
    this.tickMs = typeof o.tickMs === 'number' && o.tickMs > 0 ? o.tickMs : 30000

    this.socket = null
    this.buffer = new Uint8Array(0)
    this.handshaken = false
    this.running = false
    this.backoff = BACKOFF_MIN_MS
    this.reconnectTimer = null
    /** 分片消息累加（RFC6455 continuation） */
    this.fragments = []
    this.fragmentOpcode = 0
  }

  /** 开始连接（失败会自动退避重连，直到 stop()）。 */
  start() {
    if (this.running) return
    this.running = true
    this.connect()
  }

  /** 停止并释放（不再重连）。 */
  stop() {
    this.running = false
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.closeSocket()
  }

  closeSocket() {
    const s = this.socket
    this.socket = null
    this.handshaken = false
    this.buffer = new Uint8Array(0)
    this.fragments = []
    if (s !== null && s !== undefined) {
      try { s.destroy() } catch (error) { /* 忽略 */ }
    }
  }

  emitState(kind, detail) {
    if (this.onState === null) return
    try { this.onState({ kind: kind, detail: detail }) } catch (error) { /* 宿主侧异常不影响连接 */ }
  }

  connect() {
    const parsed = parseWsUrl(this.url)
    if (parsed === null) {
      this.emitState('error', { message: 'URL 无法解析：' + String(this.url) })
      this.scheduleReconnect()
      return
    }

    const key = crypto.randomBytes(16).toString('base64')
    this.expectedAcceptKey = expectedAccept(key)

    // token 走查询参数（NapCat 的 WS 用 access_token）
    let path = parsed.path
    if (this.token.length > 0) {
      path += (path.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(this.token)
    }

    const onConnect = () => {
      const req = handshakeRequest(parsed.hostHeader, path, key)
      sock.write(req)
    }

    let sock
    if (parsed.secure) {
      sock = tls.connect({ host: parsed.host, port: parsed.port, servername: parsed.host }, onConnect)
    } else {
      sock = net.connect({ host: parsed.host, port: parsed.port }, onConnect)
    }
    this.socket = sock
    sock.setNoDelay(true)

    sock.on('data', (chunk) => this.onData(chunk))
    sock.on('error', (err) => {
      this.emitState('error', { message: String(err && err.message ? err.message : err) })
    })
    sock.on('close', () => {
      const wasConnected = this.handshaken
      this.handshaken = false
      this.socket = null
      if (wasConnected) this.emitState('disconnected', {})
      if (this.running) this.scheduleReconnect()
    })

    // 静默 tick：读超时不是错误，而是"这段时间没有事件"
    sock.setTimeout(this.tickMs, () => {
      if (this.onTick === null) return
      let wantReconnect = false
      try { wantReconnect = this.onTick() === true } catch (error) { wantReconnect = false }
      if (wantReconnect) {
        this.emitState('reconnect-requested', {})
        this.closeSocket()
        if (this.running) this.scheduleReconnect()
      }
    })
  }

  scheduleReconnect() {
    if (!this.running) return
    if (this.reconnectTimer !== null) return
    const delay = this.backoff
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2)
    this.emitState('reconnect-scheduled', { delayMs: delay })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.running) return
      this.connect()
    }, delay)
  }

  onData(chunk) {
    // 追加到累计缓冲
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
    const merged = new Uint8Array(this.buffer.length + incoming.length)
    merged.set(this.buffer, 0)
    merged.set(incoming, this.buffer.length)
    this.buffer = merged

    if (!this.handshaken) {
      const text = new TextDecoder().decode(this.buffer)
      const end = text.indexOf('\r\n\r\n')
      if (end < 0) return // 头还没收全
      const headerText = text.slice(0, end)
      if (!handshakeAccepted(headerText)) {
        this.emitState('error', { message: '握手被拒：' + headerText.split('\r\n')[0] })
        this.closeSocket()
        if (this.running) this.scheduleReconnect()
        return
      }
      // 校验 accept（防中间人/接错端口）
      const m = /sec-websocket-accept:\s*(\S+)/i.exec(headerText)
      if (m !== null && m[1] !== this.expectedAcceptKey) {
        this.emitState('error', { message: 'Sec-WebSocket-Accept 不匹配' })
        this.closeSocket()
        if (this.running) this.scheduleReconnect()
        return
      }
      this.handshaken = true
      this.backoff = BACKOFF_MIN_MS // 连上就重置退避
      this.emitState('connected', {})
      this.buffer = this.buffer.slice(end + 4)
    }

    this.drainFrames()
  }

  drainFrames() {
    for (;;) {
      if (this.buffer.length === 0) return
      let decoded
      try {
        decoded = decodeFrame(this.buffer)
      } catch (error) {
        this.emitState('error', { message: '帧解析异常：' + String(error) })
        this.closeSocket()
        if (this.running) this.scheduleReconnect()
        return
      }
      if (decoded.frame === null) {
        if (decoded.tooLarge === true) {
          this.emitState('error', { message: '帧长度超出可表示范围' })
          this.closeSocket()
          if (this.running) this.scheduleReconnect()
        }
        return
      }
      this.buffer = this.buffer.slice(decoded.consumed)
      this.handleFrame(decoded.frame)
      if (this.socket === null) return // 处理过程中断开了
    }
  }

  handleFrame(frame) {
    const op = frame.opcode

    if (op === OPCODE.ping) {
      this.sendRaw(OPCODE.pong, frame.payload)
      return
    }
    if (op === OPCODE.pong) return
    if (op === OPCODE.close) {
      this.emitState('closed-by-peer', {})
      this.closeSocket()
      if (this.running) this.scheduleReconnect()
      return
    }

    if (op === OPCODE.continuation) {
      this.fragments.push(frame.payload)
      if (frame.fin) {
        this.finishFragments(this.fragmentOpcode)
      }
      return
    }

    if (!frame.fin) {
      // 分片消息的开始
      this.fragmentOpcode = op
      this.fragments = [frame.payload]
      return
    }

    this.deliver(op, frame.payload)
  }

  finishFragments(opcode) {
    let total = 0
    for (let i = 0; i < this.fragments.length; i += 1) total += this.fragments[i].length
    const merged = new Uint8Array(total)
    let at = 0
    for (let i = 0; i < this.fragments.length; i += 1) {
      merged.set(this.fragments[i], at)
      at += this.fragments[i].length
    }
    this.fragments = []
    this.deliver(opcode, merged)
  }

  deliver(opcode, payload) {
    if (opcode !== OPCODE.text) return // 本用途只关心文本
    if (this.onEvent === null) return
    let parsed = null
    try {
      parsed = JSON.parse(decodeText(payload))
    } catch (error) {
      // 非 JSON 帧直接忽略（NapCat 偶尔会推心跳等非事件帧）
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    // 只有带 post_type 的才是 OneBot 事件
    if (typeof parsed.post_type !== 'string') return
    try {
      this.onEvent(parsed)
    } catch (error) {
      this.emitState('error', { message: '事件处理异常：' + String(error) })
    }
  }

  sendRaw(opcode, payload) {
    const s = this.socket
    if (s === null || !this.handshaken) return false
    try {
      s.write(encodeFrame(opcode, payload, { mask: true }))
      return true
    } catch (error) {
      return false
    }
  }

  /** 发一段文本（JSON 字符串由调用方准备）。 */
  sendText(text) {
    return this.sendRaw(OPCODE.text, encodeText(text))
  }

  get connected() {
    return this.handshaken === true
  }
}
