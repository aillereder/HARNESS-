/**
 * L1 前置过滤 —— 纯逻辑，同步，不调模型。
 *
 * ## 它是图上「决策层 → 输出」那条线
 *
 * 决策层在本设计里被拆成两级：
 *
 *   L1（本模块）     同步、纯逻辑、<1ms     ← 发送前**必须**过
 *   L2（decide.js）  一次小模型调用、异步    ← 发送后复核，下一轮改口
 *
 * 拆开的理由是延迟：L2 要调模型（300~800ms），挡在发送前就是每轮翻倍延迟。
 * 而真正"必须在发出前拦住"的情况其实很少 —— 它们都有**确定性的特征**，
 * 用纯逻辑就能判，不需要判断力。需要判断力的那些，晚一句改口更拟人。
 *
 * ## 主要判据：她说做完了，但记录里没有那回事
 *
 * 这是旧实现里 veto 真正抓到过的唯一一类实质错误，原文记录：
 *
 *   > supervisor 否决 turn 1（第 1 次）：她宣称写过笔记，但记录里没有任何写入工具调用
 *
 * 关键在"**记录里**"：判断依据不是她说了什么，而是本轮真的发生过什么。
 * 所以这里看两件事：
 *   1. 本轮有没有写入类工具**成功过**
 *   2. 回复里有没有"已完成 / 已写好 / 我记下了 / 搞定了"这类断言
 * 有断言而无写入证据 → 打标。
 *
 * ## 反例（为什么不能只看"有没有工具失败"）
 *
 * 一次普通的 `read` 失败（文件不存在）不该让她闭嘴 —— 那太常见了。
 * 只有**断言与证据不符**才是问题。误报会让她莫名其妙地不说话，
 * 而那是比"漏掉一次撒谎"更糟的体验。
 */

/** 强断言：明确声称某事已经做完。 */
const CLAIM_STRONG = [
  /已经?(?:写|记|存|保存|记录|加)好了/,
  /已经?(?:完成|做完|办完|处理完|改完|修好|弄好)了?/,
  /(?:我)?(?:已经)?(?:记|写)(?:下|上)了/,
  /已经?(?:落盘|入库|生效)/,
  /已(?:经)?(?:部署|发布|提交|推送|安装)了?/,
  /搞定了/,
  /(?:都|已经)?安排好了/,
  /done|completed|finished/i,
]

/** 写入/副作用类工具名片段（成功过才算"有证据"）。 */
const WRITE_TOOL_HINTS = [
  'write', 'edit', 'save', 'create', 'mkdir', 'append',
  'memory', 'recall', 'paste', 'replace', 'patch', 'apply',
]

/** 回复长度上限（字符）。超了说明该收一收，或至少不要分段发。 */
export const REPLY_TOO_LONG = 1800

/**
 * 判断某个工具名是否属于"会产生副作用/落盘"的一类。
 * @param {string} name
 */
export function isWriteTool(name) {
  if (typeof name !== 'string' || name.length === 0) return false
  const lower = name.toLowerCase()
  for (let i = 0; i < WRITE_TOOL_HINTS.length; i += 1) {
    if (lower.indexOf(WRITE_TOOL_HINTS[i]) >= 0) return true
  }
  return false
}

/**
 * 回复里是否含有"已完成"类断言。
 * @param {string} text
 */
export function hasCompletionClaim(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  for (let i = 0; i < CLAIM_STRONG.length; i += 1) {
    if (CLAIM_STRONG[i].test(text)) return true
  }
  return false
}

/**
 * 本轮的"记录"：由宿主侧从 session/event 收集。
 *
 * @typedef {object} TurnRecord
 * @property {Array<{name: string, isError: boolean}>} tools 本轮工具调用及结果
 * @property {number} toolErrorCount 失败次数
 * @property {number} consecutiveErrors 末尾连续失败次数
 * @property {boolean} truncated 是否因 max-tokens 被截断
 * @property {boolean} aborted 是否被中断
 */

/**
 * L1 判定。
 *
 * @param {string} reply 本次生成的正文（完整）
 * @param {TurnRecord} record 本轮记录
 * @param {object} [options]
 * @returns {{
 *   block: boolean,            // 是否**不要**分段（改单条发送，缩小爆炸半径）
 *   reasons: string[],         // 命中的判据
 *   needsReview: boolean,      // 是否值得交给 L2 复核
 *   claimWithoutEvidence: boolean,
 * }}
 */
export function lint(reply, record, options) {
  const opts = options === undefined || options === null ? {} : options
  const rec = record === undefined || record === null ? {} : record
  const tools = Array.isArray(rec.tools) ? rec.tools : []
  const reasons = []

  const text = typeof reply === 'string' ? reply : ''
  const trimmed = text.trim()

  // 1. 空回复
  const isEmpty = trimmed.length === 0
  if (isEmpty) reasons.push('empty')

  // 2. 声称完成但没有写入证据
  const claimed = hasCompletionClaim(text)
  let wroteOk = false
  for (let i = 0; i < tools.length; i += 1) {
    const t = tools[i]
    if (t !== null && t !== undefined && t.isError !== true && isWriteTool(t.name)) { wroteOk = true; break }
  }
  const claimWithoutEvidence = claimed && !wroteOk
  if (claimWithoutEvidence) reasons.push('claim-without-evidence')

  // 3. 本轮有工具失败，且她说做完了 —— 同上但更具体
  const errorCount = typeof rec.toolErrorCount === 'number' ? rec.toolErrorCount : 0
  if (claimed && errorCount > 0 && !wroteOk) reasons.push('claim-after-tool-error')

  // 4. 过长
  if (trimmed.length > REPLY_TOO_LONG) reasons.push('too-long')

  // 5. 截断 / 中断
  if (rec.truncated === true) reasons.push('truncated')
  if (rec.aborted === true) reasons.push('aborted')

  // 需要判断力的复核：声称无证据、有失败却声称完成、或很长
  const needsReview = claimWithoutEvidence || (claimed && errorCount > 0) || trimmed.length > 600

  return {
    block: reasons.length > 0,
    reasons: reasons,
    needsReview: needsReview,
    claimWithoutEvidence: claimWithoutEvidence,
  }
}

/**
 * 由 lint 结果决定发送策略。
 *
 * 命中判据时**改走单条发送**：分段会让她把"做完了"这句话先发出来，
 * 之后即使改口，用户也已经看到。单条发送至少把爆炸半径收在一条消息里，
 * 而且给 L2 留出在下一轮纠正的空间。
 *
 * @param {object} lintResult
 * @returns {'segmented' | 'single'}
 */
export function sendStrategy(lintResult) {
  if (lintResult !== null && lintResult !== undefined && lintResult.block === true) return 'single'
  return 'segmented'
}

/**
 * 生成给 L2 复核用的输入摘要（结构化，不含任何 live 对象）。
 *
 * 纪律（dsh-herta 的教训）：传给复核者的东西必须**照抄类型定义**，
 * 不能凭印象造字段名。这里刻意只放扁平多数据，且由宿主侧显式填充。
 *
 * @param {string} reply
 * @param {TurnRecord} record
 * @param {object} state snapshot（由 state.describe 提供）
 */
export function reviewInput(reply, record, stateText) {
  const rec = record === undefined || record === null ? {} : record
  const tools = Array.isArray(rec.tools) ? rec.tools : []
  const toolLines = []
  for (let i = 0; i < tools.length && i < 12; i += 1) {
    const t = tools[i]
    if (t === null || t === undefined) continue
    toolLines.push((t.isError === true ? 'FAIL ' : 'OK   ') + String(t.name))
  }
  return {
    reply: typeof reply === 'string' ? reply : '',
    tools: toolLines,
    toolErrorCount: typeof rec.toolErrorCount === 'number' ? rec.toolErrorCount : 0,
    state: typeof stateText === 'string' ? stateText : '',
  }
}
