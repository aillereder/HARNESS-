/**
 * WebSocket 帧编解码 —— 最小 RFC6455 实现，零依赖。
 *
 * ## 为什么不直接用 `ws` 包
 *
 * `ws` 只是 `dsh` 的**传递依赖**，不在 `dsh` 的直接依赖列表里 ——
 * 版本会随上游变动，而本插件的目标是"零依赖、装完即用"。
 * 真正需要的只是一小部分 RFC6455：
 *
 *   · 客户端发出的每一帧**必须 mask**（服务端则不能）—— 这是协议规定
 *   · 服务端发来的帧**不带 mask**
 *   · 握手就是一次 HTTP Upgrade，带 Sec-WebSocket-Key 的 base64(sha1) 校验值
 *   · 控制帧（ping/pong/close）要能回
 *
 * 分片消息（continuation）在 OneBot 事件流里基本不出现，但依然处理 ——
 * 一行累加而已，漏了会偶发解析失败，那种 bug 极难查。
 *
 * ## 为什么这里不用 Buffer
 *
 * 用 `Uint8Array` + `DataView`，这样整套编解码可以在**任何** JS 环境里
 * 单测，不绑定 Node。真正的 socket 读写由上层用 Node 内置模块完成。
 */

/** 操作码。 */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** 一个固定窗口的 [min, max) 随机数，用于 mask 键。可注入以便测试。 */
function randomMaskKey(rng) {
  const rand = typeof rng === 'function' ? rng : Math.random
  const key = new Uint8Array(4)
  for (let i = 0; i < 4; i += 1) key[i] = Math.floor(rand() * 256) & 0xff
  return key
}

/** 按 RFC 逐字节异或（解码与编码是同一个操作，因为异或是自反的）。 */
export function applyMask(payload, maskKey) {
  const out = new Uint8Array(payload.length)
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i] ^ maskKey[i % 4]
  }
  return out
}

/**
 * 编一帧。
 *
 * @param {number} opcode
 * @param {Uint8Array} payload
 * @param {{mask?: boolean, fin?: boolean, rng?: () => number}} [opts]
 *   mask 默认 true（客户端必须 mask）
 * @returns {Uint8Array}
 */
export function encodeFrame(opcode, payload, opts) {
  const o = opts === undefined || opts === null ? {} : opts
  const mask = o.mask === undefined ? true : o.mask === true
  const fin = o.fin === undefined ? true : o.fin === true
  const data = payload === undefined || payload === null ? new Uint8Array(0) : payload
  const len = data.length

  // 头部：1 字节（FIN+opcode）+ 1 字节（MASK+长度）+ 扩展长度 + [mask key]
  let headerLen = 2
  let lenField = len
  if (len >= 126 && len <= 0xffff) { headerLen += 2; lenField = 126 }
  else if (len > 0xffff) { headerLen += 8; lenField = 127 }
  if (mask) headerLen += 4

  const out = new Uint8Array(headerLen + len)
  out[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  out[1] = (mask ? 0x80 : 0x00) | (lenField & 0x7f)

  let offset = 2
  if (lenField === 126) {
    out[offset] = (len >>> 8) & 0xff
    out[offset + 1] = len & 0xff
    offset += 2
  } else if (lenField === 127) {
    // JS 数字安全范围内，高 32 位写 0
    out[offset] = 0; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0
    out[offset + 4] = (len >>> 24) & 0xff
    out[offset + 5] = (len >>> 16) & 0xff
    out[offset + 6] = (len >>> 8) & 0xff
    out[offset + 7] = len & 0xff
    offset += 8
  }

  if (mask) {
    const key = randomMaskKey(o.rng)
    out[offset] = key[0]; out[offset + 1] = key[1]; out[offset + 2] = key[2]; out[offset + 3] = key[3]
    offset += 4
    const masked = applyMask(data, key)
    out.set(masked, offset)
  } else {
    out.set(data, offset)
  }
  return out
}

/**
 * 解一帧。
 *
 * @param {Uint8Array} buf 累计收到的字节
 * @returns {{frame: object|null, consumed: number}} 数据不够时 frame 为 null
 */
export function decodeFrame(buf) {
  if (buf === undefined || buf === null || buf.length < 2) {
    return { frame: null, consumed: 0 }
  }

  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2

  if (len === 126) {
    if (buf.length < offset + 2) return { frame: null, consumed: 0 }
    len = (buf[offset] << 8) | buf[offset + 1]
    offset += 2
  } else if (len === 127) {
    if (buf.length < offset + 8) return { frame: null, consumed: 0 }
    // 高 32 位必须为 0，否则超出可表示范围
    const hi = (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]
    const lo = ((buf[offset + 4] << 24) | (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7]) >>> 0
    if (hi !== 0) return { frame: null, consumed: 0, tooLarge: true }
    len = lo
    offset += 8
  }

  let maskKey = null
  if (masked) {
    if (buf.length < offset + 4) return { frame: null, consumed: 0 }
    maskKey = new Uint8Array([buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]])
    offset += 4
  }

  if (buf.length < offset + len) return { frame: null, consumed: 0 }

  let payload = buf.slice(offset, offset + len)
  if (masked && maskKey !== null) payload = applyMask(payload, maskKey)

  return {
    frame: {
      fin: fin,
      opcode: opcode,
      masked: masked,
      payload: payload,
    },
    consumed: offset + len,
  }
}

/**
 * 握手请求文本。
 * @param {string} host 形如 '127.0.0.1:3000'
 * @param {string} path 形如 '/?access_token=xxx'
 * @param {string} key base64 的 16 字节随机值
 */
export function handshakeRequest(host, path, key) {
  const p = typeof path === 'string' && path.length > 0 ? path : '/'
  return [
    'GET ' + p + ' HTTP/1.1',
    'Host: ' + host,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: ' + key,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n')
}

/** 握手响应是否成功（101 + Upgrade 头）。 */
export function handshakeAccepted(headerText) {
  if (typeof headerText !== 'string') return false
  const firstLine = headerText.split('\r\n')[0]
  if (firstLine === undefined || firstLine.indexOf(' 101') < 0) return false
  const lower = headerText.toLowerCase()
  return lower.indexOf('upgrade: websocket') >= 0
}

/**
 * 校验值计算所需的输入：key + 固定 GUID。
 * 实际 sha1 由上层用 node:crypto 完成（这里只拼字符串，保持零依赖可测）。
 */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKeyInput(key) {
  return String(key) + WS_GUID
}

/** 文本帧 → 字符串。 */
export function decodeText(payload) {
  return decoder.decode(payload)
}

/** 字符串 → 文本帧负载。 */
export function encodeText(text) {
  return encoder.encode(typeof text === 'string' ? text : String(text))
}
