// 阶段 4 验证：lib/ws-frame.js 的 RFC6455 编解码。
//
// 自编 WebSocket 客户端的理由是"零依赖"（`ws` 只是 dsh 的传递依赖，
// 版本会随上游变）。代价是必须自己保证帧格式正确 —— 所以这一套测试
// 要覆盖长度分档、mask、分片、以及"数据不够时不误判"。

import {
  OPCODE, WS_GUID, acceptKeyInput, applyMask, decodeFrame, decodeText,
  encodeFrame, encodeText, handshakeAccepted, handshakeRequest,
} from './lib/ws-frame.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const FIXED = () => 0.5 // 固定 mask 键，便于断言

// ── 1. mask 是自反的 ────────────────────────────────────────────────────
{
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
  const key = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd])
  const masked = applyMask(data, key)
  const back = applyMask(masked, key)
  ok('mask 两次还原原文', Array.from(back).join(',') === Array.from(data).join(','),
    Array.from(back).join(','))
  ok('mask 后确实变了', Array.from(masked).join(',') !== Array.from(data).join(','))
}

// ── 2. 短帧往返（len < 126）────────────────────────────────────────────
{
  const text = 'hello'
  const frame = encodeFrame(OPCODE.text, encodeText(text), { mask: true, rng: FIXED })
  ok('短帧头是 2+4 字节 + 负载', frame.length === 2 + 4 + text.length, String(frame.length))
  ok('FIN 位已置', (frame[0] & 0x80) !== 0)
  ok('opcode 是 text', (frame[0] & 0x0f) === OPCODE.text)
  ok('MASK 位已置', (frame[1] & 0x80) !== 0)
  ok('长度字段就是负载长度', (frame[1] & 0x7f) === text.length, String(frame[1] & 0x7f))

  const dec = decodeFrame(frame)
  ok('解回来有帧', dec.frame !== null)
  ok('consumed 等于整帧长', dec.consumed === frame.length, String(dec.consumed))
  ok('负载文本一致', decodeText(dec.frame.payload) === text, decodeText(dec.frame.payload))
}

// ── 3. 中帧往返（126 <= len <= 65535，2 字节长度）────────────────────────
{
  const text = 'x'.repeat(200)
  const frame = encodeFrame(OPCODE.text, encodeText(text), { mask: true, rng: FIXED })
  ok('中帧用 126 标记', (frame[1] & 0x7f) === 126, String(frame[1] & 0x7f))
  const dec = decodeFrame(frame)
  ok('中帧负载长度正确', dec.frame !== null && dec.frame.payload.length === 200,
    dec.frame === null ? 'null' : String(dec.frame.payload.length))
  ok('中帧文本一致', decodeText(dec.frame.payload) === text)
}

// ── 4. 长帧（len > 65535，8 字节长度）──────────────────────────────────
{
  const text = 'y'.repeat(70000)
  const frame = encodeFrame(OPCODE.text, encodeText(text), { mask: true, rng: FIXED })
  ok('长帧用 127 标记', (frame[1] & 0x7f) === 127, String(frame[1] & 0x7f))
  const dec = decodeFrame(frame)
  ok('长帧负载长度正确', dec.frame !== null && dec.frame.payload.length === 70000,
    dec.frame === null ? 'null' : String(dec.frame.payload.length))
}

// ── 5. 服务端帧不带 mask（本实现必须能解）──────────────────────────────
{
  const text = 'server-says-hi'
  const frame = encodeFrame(OPCODE.text, encodeText(text), { mask: false })
  ok('无 mask 时头是 2 字节 + 负载', frame.length === 2 + text.length, String(frame.length))
  ok('MASK 位未置', (frame[1] & 0x80) === 0)
  const dec = decodeFrame(frame)
  ok('能解无 mask 的帧（服务端来的就是这种）',
    dec.frame !== null && decodeText(dec.frame.payload) === text,
    dec.frame === null ? 'null' : decodeText(dec.frame.payload))
}

// ── 6. 数据不够时必须返回 null 而不是错帧 ────────────────────────────────
{
  const full = encodeFrame(OPCODE.text, encodeText('incomplete'), { mask: true, rng: FIXED })
  ok('只有 1 字节 → null', decodeFrame(full.slice(0, 1)).frame === null)
  ok('只有 3 字节 → null（mask 键还没齐）', decodeFrame(full.slice(0, 3)).frame === null,
    JSON.stringify(decodeFrame(full.slice(0, 3))))
  ok('差点齐了 → null', decodeFrame(full.slice(0, full.length - 1)).frame === null)
  ok('全部到齐 → 有帧', decodeFrame(full).frame !== null)
  ok('空输入安全', decodeFrame(new Uint8Array(0)).frame === null)
  ok('null 安全', decodeFrame(null).frame === null)
}

// ── 7. 粘连帧：一次收到两帧要能逐帧切分 ─────────────────────────────────
{
  const a = encodeFrame(OPCODE.text, encodeText('one'), { mask: true, rng: FIXED })
  const b = encodeFrame(OPCODE.text, encodeText('two'), { mask: true, rng: FIXED })
  const glued = new Uint8Array(a.length + b.length)
  glued.set(a, 0)
  glued.set(b, a.length)

  const d1 = decodeFrame(glued)
  ok('第一帧解出', d1.frame !== null && decodeText(d1.frame.payload) === 'one')
  const d2 = decodeFrame(glued.slice(d1.consumed))
  ok('第二帧解出（偏移正确）', d2.frame !== null && decodeText(d2.frame.payload) === 'two',
    d2.frame === null ? 'null' : decodeText(d2.frame.payload))
  ok('两帧消费量之和等于总长', d1.consumed + d2.consumed === glued.length)
}

// ── 8. 控制帧与分片标志 ─────────────────────────────────────────────────
{
  const ping = encodeFrame(OPCODE.ping, new Uint8Array(0), { mask: true, rng: FIXED })
  const d = decodeFrame(ping)
  ok('ping 帧可解', d.frame !== null && d.frame.opcode === OPCODE.ping)

  const close = encodeFrame(OPCODE.close, new Uint8Array([0x03, 0xe8]), { mask: true, rng: FIXED })
  const dc = decodeFrame(close)
  ok('close 帧可解', dc.frame !== null && dc.frame.opcode === OPCODE.close)

  const frag = encodeFrame(OPCODE.text, encodeText('part1'), { mask: true, fin: false, rng: FIXED })
  ok('分片帧 FIN=0', (frag[0] & 0x80) === 0)
  ok('分片帧可解且 fin=false', decodeFrame(frag).frame.fin === false)

  const cont = encodeFrame(OPCODE.continuation, encodeText('part2'), { mask: true, fin: true, rng: FIXED })
  ok('续帧 opcode=continuation', decodeFrame(cont).frame.opcode === OPCODE.continuation)
}

// ── 9. 握手请求格式 ─────────────────────────────────────────────────────
{
  const req = handshakeRequest('127.0.0.1:3000', '/?access_token=abc', 'dGhlIHNhbXBsZSBub25jZQ==')
  ok('第一行是 GET', req.indexOf('GET /?access_token=abc HTTP/1.1') === 0, req.split('\r\n')[0])
  ok('含 Host', req.indexOf('Host: 127.0.0.1:3000') >= 0)
  ok('含 Upgrade', req.indexOf('Upgrade: websocket') >= 0)
  ok('含 Key', req.indexOf('Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==') >= 0)
  ok('含版本 13', req.indexOf('Sec-WebSocket-Version: 13') >= 0)
  ok('以空行结尾', req.slice(-4) === '\r\n\r\n')
  ok('path 为空时用 /', handshakeRequest('h', '').indexOf('GET / HTTP/1.1') === 0)
}

// ── 10. 握手响应判定 ────────────────────────────────────────────────────
{
  const good = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
  ok('101 + Upgrade → 接受', handshakeAccepted(good) === true)

  const bad = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'
  ok('403 → 拒绝', handshakeAccepted(bad) === false)

  const noUpgrade = 'HTTP/1.1 101 Switching Protocols\r\nX-Other: 1\r\n\r\n'
  ok('101 但缺 Upgrade 头 → 拒绝', handshakeAccepted(noUpgrade) === false)

  ok('空输入安全', handshakeAccepted('') === false && handshakeAccepted(null) === false)
}

// ── 11. 标准 GUID 与 accept key 输入拼接 ────────────────────────────────
{
  ok('GUID 是 RFC 规定值', WS_GUID === '258EAFA5-E914-47DA-95CA-C5AB0DC85B11', WS_GUID)
  ok('acceptKeyInput 拼接正确',
    acceptKeyInput('abc') === 'abc258EAFA5-E914-47DA-95CA-C5AB0DC85B11', acceptKeyInput('abc'))
  // RFC 示例：key 'dGhlIHNhbXBsZSBub25jZQ==' 的 accept 应为
  // 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=' —— 由上层用 node:crypto 的 sha1 算出
}

// ── 12. UTF-8 往返（中文）──────────────────────────────────────────────
{
  const text = '你好，世界！这是一段中文测试。'
  const frame = encodeFrame(OPCODE.text, encodeText(text), { mask: true, rng: FIXED })
  const dec = decodeFrame(frame)
  ok('中文往返一致', decodeText(dec.frame.payload) === text, decodeText(dec.frame.payload))
}

console.log('\nws-frame 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
