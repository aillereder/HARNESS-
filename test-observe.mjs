// 阶段 1b 验证：lib/observe.js 的事件翻译。
//
// 字段形状**照 SessionEventMap 类型声明抄**，不凭印象造。
// dsh-herta 在这点栽过最狠的一次：mock 用错形状（event.payload?.message?.content，
// 真值是 event.data.message），24 项测试全绿而真实会话 100% 失败。

import {
  TurnRecorder, assistantText, assistantTextLength, composeContext,
  toolResultIsError, userMessageText,
} from './lib/observe.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const T = 1800000000000

/** 造一条 assistant/message 事件 —— 严格照类型：{ type, data:{ turn, step, message:{ content:[...] } } } */
function evAssistant(turn, step, texts) {
  return {
    type: 'assistant/message',
    time: T,
    data: {
      turn: turn,
      step: step,
      message: {
        id: 'm1',
        role: 'assistant',
        content: texts.map((t) => ({ type: 'text', text: t })),
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      stream: [],
    },
  }
}

// ── 1. 正文长度与文本提取（用真实形状）──────────────────────────────────
{
  const ev = evAssistant(1, 1, ['你好', '，世界'])
  ok('assistantTextLength 从 data.message.content 取长度',
    assistantTextLength(ev.data) === 5, String(assistantTextLength(ev.data)))
  ok('assistantText 拼接文本块', assistantText(ev.data) === '你好，世界', assistantText(ev.data))

  // 反面：用旧实现那个错的形状必须取不到（证明测试确实在测真形状）
  const wrongShape = { payload: { message: { content: [{ type: 'text', text: 'x'.repeat(99) }] } } }
  ok('错误形状取不到（证明断言测的是真字段）', assistantTextLength(wrongShape) === 0,
    String(assistantTextLength(wrongShape)))

  ok('非文本块被忽略', assistantTextLength({
    message: { content: [{ type: 'reasoning', text: 'x'.repeat(50) }, { type: 'text', text: 'ab' }] },
  }) === 2)
  ok('畸形输入安全', assistantTextLength(null) === 0 && assistantTextLength({}) === 0
    && assistantText(null) === '')
}

// ── 2. 工具成败判定：关键语义（命令失败 ≠ 工具失败）─────────────────────
{
  // 有 error 字段 → 失败
  ok('有 error 字段判为失败', toolResultIsError({ error: { name: 'E', code: 'C' } }) === true)

  // content[0].isError === true → 失败
  ok('content 里 isError 判为失败', toolResultIsError({
    message: { content: [{ type: 'tool-result', toolCallId: 't', content: [], isError: true }] },
  }) === true)

  // 无 error 且 isError 未置 → **成功**（即使命令 exit code 非 0）
  ok('无 error 字段判为成功（即使命令 exit code 非 0）', toolResultIsError({
    message: { content: [{ type: 'tool-result', toolCallId: 't', content: [], isError: false }] },
  }) === false)

  ok('空 data 不为失败', toolResultIsError({}) === false && toolResultIsError(null) === false)
}

// ── 3. TurnRecorder：把 tool/call 的名字配到 tool/result ────────────────
{
  const r = new TurnRecorder()
  r.feed({ type: 'turn/start', time: T, data: { turn: 1 } })
  r.feed({ type: 'tool/call', time: T, data: { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' } })
  const res1 = r.feed({
    type: 'tool/result', time: T,
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [], isError: false }] } },
  })
  ok('工具调用产出 tool-result 信号', res1.signal !== null && res1.signal.kind === 'tool-result')
  ok('  成功时 isError=false', res1.signal.isError === false)
  const snap = r.snapshot()
  ok('记录里工具名来自配对的 tool/call', snap.tools.length === 1 && snap.tools[0].name === 'read',
    JSON.stringify(snap.tools))
  ok('  成功不计错误数', snap.toolErrorCount === 0)
}

// ── 4. 连续失败计数（决策层要用）─────────────────────────────────────────
{
  const r = new TurnRecorder()
  r.feed({ type: 'turn/start', time: T, data: { turn: 1 } })
  for (let i = 0; i < 3; i += 1) {
    r.feed({ type: 'tool/call', time: T, data: { turn: 1, step: i, callId: 'c' + i, name: 'write', arguments: '{}' } })
    r.feed({
      type: 'tool/result', time: T,
      data: { turn: 1, step: i, message: { content: [{ type: 'tool-result', toolCallId: 'c' + i, content: [], isError: true }] } },
    })
  }
  const snap = r.snapshot()
  ok('三次失败都记下', snap.toolErrorCount === 3, String(snap.toolErrorCount))
  ok('连续失败计数为 3', snap.consecutiveErrors === 3, String(snap.consecutiveErrors))

  // 一次成功 → 连续计数归零，但累计仍为 3
  r.feed({ type: 'tool/call', time: T, data: { turn: 1, step: 9, callId: 'c9', name: 'read', arguments: '{}' } })
  r.feed({
    type: 'tool/result', time: T,
    data: { turn: 1, step: 9, message: { content: [{ type: 'tool-result', toolCallId: 'c9', content: [], isError: false }] } },
  })
  const snap2 = r.snapshot()
  ok('成功后连续计数归零', snap2.consecutiveErrors === 0, String(snap2.consecutiveErrors))
  ok('  累计失败数保留', snap2.toolErrorCount === 3, String(snap2.toolErrorCount))
}

// ── 5. 无配对 call 的 result 不猜名字 ───────────────────────────────────
{
  const r = new TurnRecorder()
  r.feed({ type: 'turn/start', time: T, data: { turn: 1 } })
  r.feed({
    type: 'tool/result', time: T,
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'orphan', content: [], isError: false }] } },
  })
  const snap = r.snapshot()
  ok('无配对时名字留空（不猜）', snap.tools.length === 1 && snap.tools[0].name === '',
    JSON.stringify(snap.tools))
}

// ── 6. turn/start 重置本轮记录 ──────────────────────────────────────────
{
  const r = new TurnRecorder()
  r.feed({ type: 'turn/start', time: T, data: { turn: 1 } })
  r.feed({ type: 'tool/call', time: T, data: { turn: 1, step: 1, callId: 'x', name: 'write', arguments: '{}' } })
  r.feed({
    type: 'tool/result', time: T,
    data: { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'x', content: [], isError: true }] } },
  })
  ok('重置前有记录', r.snapshot().tools.length === 1)
  r.feed({ type: 'turn/start', time: T, data: { turn: 2 } })
  ok('新 turn 开始后记录清空', r.snapshot().tools.length === 0 && r.snapshot().toolErrorCount === 0)
}

// ── 7. turn/end 产出快照并识别截断/中断 ─────────────────────────────────
{
  const r = new TurnRecorder()
  r.feed({ type: 'turn/start', time: T, data: { turn: 1 } })
  r.feed({ type: 'step/end', time: T, data: { turn: 1, step: 1 } })
  r.feed({ type: 'step/end', time: T, data: { turn: 1, step: 2 } })
  const end = r.feed({ type: 'turn/end', time: T, data: { turn: 1, reason: { kind: 'completed' } } })
  ok('turn/end 产出状态信号', end.signal !== null && end.signal.kind === 'turn-end')
  ok('  步数被带出', end.signal.steps === 2, String(end.signal.steps))
  ok('  带出本轮快照', end.snapshot !== undefined && end.snapshot.steps === 2)
  ok('  reasonKind 可读', end.reasonKind === 'completed', end.reasonKind)

  const r2 = new TurnRecorder()
  const end2 = r2.feed({ type: 'turn/end', time: T, data: { turn: 1, reason: { kind: 'max-tokens' } } })
  ok('max-tokens 被识别为截断', end2.snapshot.truncated === true)
  ok('  并出现在 reasonKind', end2.reasonKind === 'max-tokens')

  const r3 = new TurnRecorder()
  const end3 = r3.feed({ type: 'turn/end', time: T, data: { turn: 1, reason: { kind: 'interrupted' } } })
  ok('interrupted 被识别为中断', end3.snapshot.aborted === true)

  // assistant/message 带 interrupted 标记也要认
  const r4 = new TurnRecorder()
  r4.feed({ type: 'assistant/message', time: T, data: { turn: 1, step: 1, message: { content: [] }, stream: [], interrupted: true } })
  ok('assistant/message 的 interrupted 也认', r4.snapshot().aborted === true)
}

// ── 8. assistant/message 信号（状态演化用）──────────────────────────────
{
  const r = new TurnRecorder()
  const out = r.feed(evAssistant(1, 1, ['这是一段回复']))
  ok('assistant/message 产出信号', out.signal !== null && out.signal.kind === 'assistant-message')
  ok('  长度正确', out.signal.length === 6, String(out.signal.length))
  ok('  带时间戳', typeof out.signal.at === 'number')
}

// ── 9. 用户消息文本 ─────────────────────────────────────────────────────
{
  ok('从 UserMessage 取文本', userMessageText({
    id: 'u', role: 'user', content: [{ type: 'text', text: '在吗' }], source: { kind: 'user' },
  }) === '在吗')
  ok('畸形安全', userMessageText(null) === '' && userMessageText({}) === '')
}

// ── 10. 未知事件与畸形输入 ──────────────────────────────────────────────
{
  const r = new TurnRecorder()
  const out = r.feed({ type: 'some/unknown', time: T, data: {} })
  ok('未知事件返回空信号', out.signal === null && out.kind === null)
  ok('feed(null) 安全', r.feed(null).signal === null)
}

// ── 11. 上下文拼装只陈述事实 ────────────────────────────────────────────
{
  const c = composeContext('心情 4.2/10、连发 4 条没回音', '他喜欢冰美式')
  ok('含状态段', c.indexOf('【当前状态】') >= 0, c)
  ok('含记忆段', c.indexOf('【相关记忆】') >= 0)
  ok('状态文本原样带入（不加工）', c.indexOf('心情 4.2/10') >= 0)
  ok('空输入不产生空段', composeContext('', '') === '')
  ok('  只有状态时不带记忆标题', composeContext('心情 5.0/10', '').indexOf('相关记忆') < 0)
  ok('  只有记忆时不带状态标题', composeContext('', 'x').indexOf('当前状态') < 0)
  ok('null 安全', composeContext(null, null) === '')
}

console.log('\nobserve 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
