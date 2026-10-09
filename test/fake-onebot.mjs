/**
 * 假的 OneBot 11 服务 —— 测试夹具。
 *
 * 为什么必须有它：`lib/ws.js` 是第一个真正碰网络的模块，纯逻辑测试覆盖不到。
 * 更关键的是方案里那三条**可量化验收**必须在可控环境里跑：
 *   1. 自回声 = 0
 *   2. 发送顺序 === 到达顺序
 *   3. 首段延迟 < 2s
 * 这三条都用真实 NapCat 测不了（会打扰真人、且不可复现）。
 *
 * 实现要点（服务端与客户端相反）：
 *   · 握手要算 Sec-WebSocket-Accept = base64(sha1(key + GUID))
 *   · 服务端发出的帧**不带 mask**，收到的帧**带 mask**
 */

import http from 'node:http'
import crypto from 'node:crypto'

import {
  OPCODE, encodeFrame, decodeFrame, encodeText, decodeText, acceptKeyInput,
} from '../lib/ws-frame.js'

/**
 * @param {object} [options]
 * @param {string} [options.token] 需要的 access_token（空则不校验）
 */
export function createFakeOneBot(options) {
  const o = options === undefined || options === null ? {} : options
  const token = typeof o.token === 'string' ? o.token : ''
  const calls = []
  const wsClients = new Set()

  let loginInfo = { user_id: 3063567044, nickname: '测试机' }
  let statusGood = true
  let sendShouldFail = false
  let nextMessageId = 5000

  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const url = new URL(req.url, 'http://x')
      const action = url.pathname.replace(/^\//, '')
      let params = {}
      try { params = body.length > 0 ? JSON.parse(body) : {} } catch (error) { params = {} }

      const auth = req.headers.authorization || ''
      if (token.length > 0 && auth !== 'Bearer ' + token) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: 1403, data: null }))
        return
      }

      calls.push({ action: action, params: params })

      const ok = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: data }))
      }
      const fail = (retcode, msg) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: retcode, message: msg, data: null }))
      }

      if (action === 'get_login_info') return ok(loginInfo)
      if (action === 'get_status') return ok({ good: statusGood, online: statusGood })
      if (action === 'get_version_info') return ok({ app_name: 'fake-onebot' })
      if (action === 'send_msg') {
        if (sendShouldFail) return fail(1200, 'EventChecker Failed ... 网络连接异常!')
        const id = nextMessageId
        nextMessageId += 1
        return ok({ message_id: id })
      }
      if (action === 'delete_msg' || action === 'set_msg_emoji_like'
        || action === 'set_input_status' || action === 'mark_msg_as_read') {
        return ok(null)
      }
      if (action === 'get_friend_list') return ok([{ user_id: 1802352763, nickname: 'Ailler' }])
      if (action === 'get_group_list') return ok([{ group_id: 999, group_name: '测试群' }])
      return fail(1404, 'unknown action: ' + action)
    })
  })

  // ── WebSocket 升级 ─────────────────────────────────────────────────────
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x')
    if (token.length > 0 && url.searchParams.get('access_token') !== token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = crypto.createHash('sha1').update(acceptKeyInput(key)).digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + accept,
      '', '',
    ].join('\r\n'))

    const client = { socket: socket, buffer: new Uint8Array(0), alive: true }

    socket.on('data', (chunk) => {
      const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
      const merged = new Uint8Array(client.buffer.length + incoming.length)
      merged.set(client.buffer, 0)
      merged.set(incoming, client.buffer.length)
      client.buffer = merged
      for (;;) {
        const d = decodeFrame(client.buffer)
        if (d.frame === null) break
        client.buffer = client.buffer.slice(d.consumed)
        // 客户端来的帧必须带 mask；带不带都接受，但不做额外断言
        if (d.frame.opcode === OPCODE.close) { client.alive = false; wsClients.delete(client); socket.destroy(); return }
        if (d.frame.opcode === OPCODE.ping) {
          socket.write(encodeFrame(OPCODE.pong, d.frame.payload, { mask: false }))
        }
      }
    })
    socket.on('close', () => { client.alive = false; wsClients.delete(client) })
    socket.on('error', () => { client.alive = false; wsClients.delete(client) })
    wsClients.add(client)
  })

  return {
    server: server,
    calls: calls,

    /** 推一条事件给所有已连的客户端（服务端帧**不带 mask**）。 */
    pushEvent(ev) {
      const frame = encodeFrame(OPCODE.text, encodeText(JSON.stringify(ev)), { mask: false })
      let n = 0
      for (const c of wsClients) {
        if (!c.alive) continue
        try { c.socket.write(frame); n += 1 } catch (error) { /* 忽略 */ }
      }
      return n
    },

    /** 服务端主动 ping（验证客户端会不会自动回 pong）。 */
    pushPing(payload) {
      const frame = encodeFrame(OPCODE.ping, payload || new Uint8Array(0), { mask: false })
      for (const c of wsClients) {
        try { c.socket.write(frame) } catch (error) { /* 忽略 */ }
      }
    },

    /** 服务端发一个非 JSON 帧（验证客户端会安静忽略而不是崩）。 */
    pushGarbage() {
      const frame = encodeFrame(OPCODE.text, encodeText('not-json-at-all'), { mask: false })
      for (const c of wsClients) {
        try { c.socket.write(frame) } catch (error) { /* 忽略 */ }
      }
    },

    setLoginInfo(info) { loginInfo = info },
    setStatusGood(v) { statusGood = v === true },
    setSendShouldFail(v) { sendShouldFail = v === true },
    get connectedClients() { return wsClients.size },

    /** 主动踢掉所有客户端 —— 模拟 QQ 重启把 WS 掐断。 */
    kickClients() {
      let n = 0
      for (const c of wsClients) {
        try { c.socket.destroy(); n += 1 } catch (error) { /* 忽略 */ }
      }
      wsClients.clear()
      return n
    },

    callsOf(action) { return calls.filter((c) => c.action === action) },

    listen() {
      return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(server.address().port))
      })
    },

    close() {
      return new Promise((resolve) => {
        for (const c of wsClients) { try { c.socket.destroy() } catch (error) { /* 忽略 */ } }
        wsClients.clear()
        server.close(() => resolve())
      })
    },
  }
}
