/**
 * 观察层 —— 把 DSH 已发生的事实翻译成状态信号与本轮记录。
 *
 * ## 为什么变量是"观察"出来的
 *
 * 不额外调一次模型去推断她的状态，而是从 DSH 已经发生的事实里算：
 * 她说了多长、工具失败几次、一轮走了几步、多久没人理她。
 * 这样状态机归程序，模型只能读 —— 正是「模型负责理解与生成，
 * 程序负责执行流程与维护状态」那条边界。
 *
 * ## 事件形状（照类型定义抄，不凭印象造）
 *
 * dsh-herta 栽过最狠的一次就是这个：单测 mock 用了错的字段形状
 * （`event.payload?.message?.content`，真值是 `event.data.message`），
 * **24 项测试全绿而真实会话 100% 失败**。所以下面每个字段都对着
 * `SessionEventMap` 的类型声明写，注释里标出出处。
 */

/**
 * 从 `assistant/message` 事件里取正文长度。
 *
 * 类型：`'assistant/message' → { turn, step, message: AssistantMessage, stream, usage?, interrupted? }`
 * 正文在 `data.message.content` 里，是 `ContentBlock[]`，取 type==='text' 的。
 *
 * @param {object} data
 * @returns {number}
 */
export function assistantTextLength(data) {
  if (data === null || data === undefined) return 0
  const message = data.message
  if (message === null || message === undefined) return 0
  const blocks = message.content
  if (!Array.isArray(blocks)) return 0
  let len = 0
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]
    if (b === null || b === undefined) continue
    if (b.type === 'text' && typeof b.text === 'string') len += b.text.length
  }
  return len
}

/**
 * 把 `assistant/message` 的正文取成纯文本（给 filter 与决策层用）。
 * @param {object} data
 * @returns {string}
 */
export function assistantText(data) {
  if (data === null || data === undefined) return ''
  const message = data.message
  if (message === null || message === undefined) return ''
  const blocks = message.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]
    if (b === null || b === undefined) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

/**
 * 判断 `tool/result` 是不是失败。
 *
 * 类型：`'tool/result' → { turn, step, message: ToolResultMessage, error?: {name, code}, meta? }`
 *
 * ⚠️ 关键语义（实测踩过）：**命令失败 ≠ 工具失败**。
 * `node -e "process.exit(3)"` 返回 exit code 1，但工具判定为**成功**
 * —— 那是命令的正常结果。所以判据只能是 `error` 字段或
 * `content[0].isError`，**不能看命令退出码**。
 * 否则会把"命令正常报错"误判成"她在撒谎"。
 *
 * @param {object} data
 * @returns {boolean}
 */
export function toolResultIsError(data) {
  if (data === null || data === undefined) return false
  if (data.error !== null && data.error !== undefined) return true
  const message = data.message
  if (message !== null && message !== undefined && Array.isArray(message.content)) {
    const blocks = message.content
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i]
      if (b !== null && b !== undefined && b.type === 'tool-result' && b.isError === true) return true
    }
  }
  return false
}

/**
 * 本轮记录器 —— 供 filter.lint 判断"她说做完了，但记录里有没有那回事"。
 *
 * 只记工具名与成败，不存消息体（避免把 live 数据留在长生命周期状态里）。
 */
export class TurnRecorder {
  constructor() {
    this.reset()
  }

  reset() {
    this.tools = []
    this.toolErrorCount = 0
    this.consecutiveErrors = 0
    this.steps = 0
    /** 未配对的 tool/call（用于把 name 关联到结果） */
    this.pendingCalls = []
    this.truncated = false
    this.aborted = false
  }

  /** 取当前快照给 filter 用。 */
  snapshot() {
    return {
      tools: this.tools.slice(),
      toolErrorCount: this.toolErrorCount,
      consecutiveErrors: this.consecutiveErrors,
      steps: this.steps,
      truncated: this.truncated,
      aborted: this.aborted,
    }
  }

  /**
   * 喂入一条会话事件。
   *
   * @param {object} event `{ type, data }`
   * @returns {{signal: object|null, kind: string|null}}
   *   signal 给 state.apply；kind 便于宿主侧分支
   */
  feed(event) {
    if (event === null || event === undefined) return { signal: null, kind: null }
    const type = event.type
    const data = event.data
    const now = typeof event.time === 'number' ? event.time : Date.now()

    if (type === 'tool/call') {
      const name = data !== null && data !== undefined && typeof data.name === 'string' ? data.name : ''
      this.pendingCalls.push(name)
      return { signal: null, kind: 'tool-call' }
    }

    if (type === 'tool/result') {
      const isError = toolResultIsError(data)
      // 结果可能没有配对的 call（重启/续跑），那就记成未知名 —— 不猜
      const name = this.pendingCalls.length > 0 ? this.pendingCalls.shift() : ''
      this.tools.push({ name: name, isError: isError })
      if (isError) {
        this.toolErrorCount += 1
        this.consecutiveErrors += 1
      } else {
        this.consecutiveErrors = 0
      }
      return { signal: { kind: 'tool-result', isError: isError, consecutiveErrors: this.consecutiveErrors, at: now }, kind: 'tool-result' }
    }

    if (type === 'assistant/message') {
      const len = assistantTextLength(data)
      const interrupted = data !== null && data !== undefined && data.interrupted === true
      if (interrupted) this.aborted = true
      return { signal: { kind: 'assistant-message', length: len, at: now }, kind: 'assistant-message' }
    }

    if (type === 'step/end') {
      this.steps += 1
      if (data !== null && data !== undefined && data.step !== undefined) {
        if (data.step > this.steps) this.steps = data.step
      }
      return { signal: null, kind: 'step-end' }
    }

    if (type === 'turn/start') {
      this.reset()
      return { signal: null, kind: 'turn-start' }
    }

    if (type === 'turn/end') {
      const reason = data !== null && data !== undefined ? data.reason : undefined
      const kindOfReason = reason !== null && reason !== undefined && typeof reason.kind === 'string' ? reason.kind : ''
      if (kindOfReason === 'max-tokens') this.truncated = true
      if (kindOfReason === 'aborted' || kindOfReason === 'interrupted') this.aborted = true
      const steps = this.steps
      const snapshot = this.snapshot()
      return { signal: { kind: 'turn-end', steps: steps, at: now }, kind: 'turn-end', snapshot: snapshot, reasonKind: kindOfReason }
    }

    return { signal: null, kind: null }
  }
}

/**
 * 从用户消息事件里取纯文本（用于"隔了多久回来"与记忆召回）。
 * 类型：`'user/message' → UserMessage`（data 就是 UserMessage 本身）
 */
export function userMessageText(data) {
  if (data === null || data === undefined) return ''
  const blocks = data.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (let i = 0; i < blocks.length; i += 1) {
    const b = blocks[i]
    if (b === null || b === undefined) continue
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

/**
 * 把状态文本与记忆摘要拼成给提示词的动态上下文。
 *
 * 纪律：**只陈述事实，不做解读**。代码说"心情 4.2/10、连发 4 条没回音"，
 * 至于这意味着一句话都不想说是还是只回两个字，那是模型的事。
 *
 * @param {string} stateText state.describe 的输出
 * @param {string} memoryText memory.embed 的输出
 * @returns {string}
 */
export function composeContext(stateText, memoryText) {
  const parts = []
  const s = typeof stateText === 'string' ? stateText.trim() : ''
  const m = typeof memoryText === 'string' ? memoryText.trim() : ''
  if (s.length > 0) parts.push('【当前状态】' + s)
  if (m.length > 0) parts.push('【相关记忆】\n' + m)
  return parts.join('\n')
}
