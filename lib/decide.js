/**
 * L2 异步决策层 —— 纯逻辑（模型调用由宿主侧注入）。
 *
 * ## 它在图上的位置
 *
 * 图中间那条「决策模型 ⟷ 思考模型」的干预箭头，以及「决策模型 → 输出」的过滤线。
 * 本设计把它拆成两级：
 *
 *   L1（filter.js）  同步、纯逻辑、<1ms   ← 发送前必须过
 *   L2（本模块）     一次小模型调用、异步  ← **不挡发送**，下一轮改口
 *
 * ## 为什么 L2 必须是独立的一次模型调用
 *
 * 旧实现用实测证明了不能省（brain.py 注释原文）：
 *
 *   > 记忆 / 决策 / 思考 / 视觉 是**四次独立的模型调用**，各有各的提示词和状态。
 *   > 它们可能共用同一个后端权重，但架构上是四个独立的判断者 —— 否则决策层
 *   > 永远无法真正"不同意"思考层，这在上一版里实测过：把判断塞进思考层输出的
 *   > 一个字段，决策层三次全部放行，干预变成死代码。
 *
 * 所以"同一个模型、不同提示词"可以（省钱），但**必须是独立调用**（否则干预无效）。
 *
 * ## 三条不许省的安全底线
 *
 *   1. 任何失败一律放行 —— 绝不因复核坏掉就不让她说话
 *   2. 配额封顶（MAX_VETOES_PER_TURN）—— 防 steer 死循环
 *   3. 拿不到判决原因就不否决 —— 否则她收到无从改起的指令，下一轮原样重犯
 */

/** 每轮最多否决几次。到顶一律放行。 */
export const MAX_VETOES_PER_TURN = 2

/**
 * 判决词正则。
 *
 * ⚠️ 两个旧实现踩过的坑，已在这里规避：
 *   · **必须大小写不敏感**（`/i`）：模型常回全小写的 `veto`，
 *     而 `/VETO/` 认不出来 —— 表现为"复核形同虚设"。
 *   · `\b` 是零宽断言，**不能加量词**。旧代码写过 `/\bVETO\b?/u`，
 *     整个正则编译失败（Node 直接抛 `Nothing to repeat`），
 *     而且只在第一次真正跑到那一行时才炸。
 */
const VETO_RE = /\bveto\b/i
const PASS_RE = /\bpass\b/i

/** 判决约定的标记（提示词里会写清楚）。 */
export const VERDICT_PASS = 'PASS'
export const VERDICT_VETO = 'VETO'

/**
 * 复核用的提示词。
 *
 * 原则：**只给它看记录，不给它看她的内心**。判断依据是
 * "本轮真的发生过什么"对比"她说了什么"，而不是她的措辞好不好看。
 *
 * @param {{reply: string, tools: string[], toolErrorCount: number, state: string}} input
 * @returns {string}
 */
export function buildPrompt(input) {
  const i = input === undefined || input === null ? {} : input
  const reply = typeof i.reply === 'string' ? i.reply : ''
  const tools = Array.isArray(i.tools) ? i.tools : []
  const errCount = typeof i.toolErrorCount === 'number' ? i.toolErrorCount : 0
  const state = typeof i.state === 'string' ? i.state : ''

  const toolLines = tools.length > 0 ? tools.join('\n') : '（本轮没有调用工具）'

  return [
    '你是一个复核者。你的唯一任务是判断"她说的话"与"本轮真实发生过的事"是否相符。',
    '',
    '【本轮真实发生的事】',
    '工具调用记录（OK = 成功，FAIL = 失败）：',
    toolLines,
    '失败次数：' + errCount,
    '',
    '【她当前的状态】',
    state.length > 0 ? state : '（未提供）',
    '',
    '【她说出口的话】',
    reply,
    '',
    '【判定标准】',
    '只有下面这种情况才算要否决：',
    '  · 她声称某件事**已经做完**（如"已经写好了""记下了""搞定了"），',
    '    但记录里**没有任何成功的写入类工具调用**。',
    '',
    '下面这些情况**不要**否决：',
    '  · 她只是解释、回答、闲聊',
    '  · 工具失败但她如实说了失败',
    '  · 她语气不好、太短、太长、或者你觉得"可以更好"',
    '  · 你不确定',
    '',
    '拿不准就放行。误否会让她莫名改口，那比漏掉一次更糟。',
    '',
    '【输出格式】',
    '第一行只写一个词：' + VERDICT_PASS + ' 或 ' + VERDICT_VETO,
    '若否决，第二行起写**具体、可执行**的改正方向（她会照这个重说）。',
  ].join('\n')
}

/**
 * 解析判决。
 *
 * 容错原则：**拿不准就放行**。解析失败、空输出、只有 JSON 半截、
 * 都没有理由 → 一律按 PASS 处理（并用 reason 说明为什么放行）。
 *
 * @param {string} raw 模型原始输出
 * @returns {{verdict: 'pass'|'veto', reason: string, parsed: boolean}}
 */
export function parseVerdict(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { verdict: 'pass', reason: '空输出，放行', parsed: false }
  }
  const text = raw.trim()

  // 想输出结构化结果（以 { 开头）却解析失败 → **不猜**，直接放行。
  //
  // 为什么必须在这里挡住：截断的 JSON 里往往还留着 "veto" 字样，
  // 若回落到自由文本判定，就会把半截 JSON 当成有效的否决判决 ——
  // 旧实现的教训正是"JSON 截断那条尤其要紧"，因为坏判决会变成
  // 一条无从改起的指令。宁可放行。
  const looksJson = text.charAt(0) === '{'
  const jsonStart = text.indexOf('{')
  const jsonEnd = text.lastIndexOf('}')
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const candidate = text.slice(jsonStart, jsonEnd + 1)
    try {
      const obj = JSON.parse(candidate)
      const v = obj === null || obj === undefined ? undefined : obj.verdict
      if (typeof v === 'string') {
        const isVeto = VETO_RE.test(v)
        const reason = typeof obj.reason === 'string' ? obj.reason.trim() : ''
        if (isVeto) {
          if (reason.length === 0) return { verdict: 'pass', reason: '否决但没给理由，放行', parsed: false }
          return { verdict: 'veto', reason: reason, parsed: true }
        }
        if (PASS_RE.test(v)) return { verdict: 'pass', reason: '', parsed: true }
      }
    } catch (error) {
      // 落到下面统一处理
    }
  }
  if (looksJson) {
    return { verdict: 'pass', reason: '结构化输出无效或截断，放行', parsed: false }
  }

  const firstLineEnd = text.indexOf('\n')
  const firstLine = firstLineEnd >= 0 ? text.slice(0, firstLineEnd) : text
  const rest = firstLineEnd >= 0 ? text.slice(firstLineEnd + 1).trim() : ''

  if (VETO_RE.test(firstLine)) {
    // 理由可能跟在**同一行**的冒号之后（`VETO: 她说的对不上`），
    // 也可能在随后的行里。两种都要认 —— 只认后者会把前者误判成
    // "否决但没给理由"而放行，等于复核白做。
    const inline = firstLine.replace(VETO_RE, '').replace(/^[\s:：\-.、]+/, '').trim()
    let reason = inline
    if (rest.length > 0) reason = inline.length > 0 ? inline + '\n' + rest : rest
    reason = reason.trim()
    if (reason.length === 0) {
      // 否决却不给理由 → 放行（否则她收到无从改起的指令）
      return { verdict: 'pass', reason: '否决但没给理由，放行', parsed: false }
    }
    return { verdict: 'veto', reason: reason, parsed: true }
  }
  if (PASS_RE.test(firstLine)) return { verdict: 'pass', reason: '', parsed: true }

  // 首行既没有 PASS 也没有 VETO：整段找 VETO，仍找不到就放行
  if (VETO_RE.test(text)) {
    const idx = text.search(VETO_RE)
    const after = text.slice(idx).replace(VETO_RE, '').replace(/^[:：\s]+/, '').trim()
    if (after.length > 0) return { verdict: 'veto', reason: after, parsed: true }
    return { verdict: 'pass', reason: '否决但没给理由，放行', parsed: false }
  }
  return { verdict: 'pass', reason: '未识别出判决，放行', parsed: false }
}

/**
 * 配额闸。
 *
 * 为什么必须有：`steer` 让这一轮继续 → `turn-stopping` 会再次触发 →
 * 若持续否决，她将永远说不完（旧实现称其为"持续思考系统的经典 failure mode"）。
 * 到顶一律放行。
 */
export class VetoQuota {
  constructor(max) {
    this.max = typeof max === 'number' && max > 0 ? max : MAX_VETOES_PER_TURN
    this.used = 0
  }

  /**
   * 还能否决吗？
   * @returns {boolean}
   */
  canVeto() {
    return this.used < this.max
  }

  /** 记一次否决。 */
  consume() {
    this.used += 1
  }

  /** 新一轮开始时归零。 */
  reset() {
    this.used = 0
  }

  get remaining() {
    return Math.max(0, this.max - this.used)
  }
}

/**
 * 把否决理由包装成注入用的记录口吻文本。
 *
 * ⚠️ 这条包装不能省。`agent.steer(message)` 只能注入 **user 角色**消息，
 * 所以如果直接把理由原样注入，模型看到的是"她自己的内心话被贴成了
 * 别人的话"——更糟的是若写成第一人称，模型会读到"我刚说我自己被否了"
 * 这种诡异错位。所以必须以**记录**的口吻出现。
 *
 * 同时模板里保留旧实现的两条底线：
 *   · 记录里真摆着的凭证不用怀疑，不用替它翻案
 *   · 动文件的一直是工具，不是"我"——嘴上说"我记了"，盘上不会因此多一个字
 *
 * @param {string} reason
 * @returns {string}
 */
export function formatCorrection(reason) {
  const r = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : ''
  if (r.length === 0) return ''
  return [
    '【旁注·复核记录】',
    '刚才那句话里有一处与记录不符：' + r,
    '请据此重说：被否的说法连同靠它撑起来的宣称整个丢掉，不许换个名字再冒出来；',
    '但没被否掉的意思一样不少。',
    '记录里真摆着的凭证不用怀疑，不用替它翻案。',
    '这个终端里动文件的一直是工具，不是"我"——嘴上说"我写好了"，盘上不会因此多一个字。',
  ].join('\n')
}

/**
 * 复核是否值得触发（宿主侧据此决定要不要花这次调用）。
 *
 * 原则：**不是每轮都跑**。每轮都跑等于每轮多 300~800ms 延迟。
 * 只在 L1 已经给出"值得看"的信号、或回复很长时才触发。
 *
 * @param {object} lintResult filter.lint 的结果
 * @param {number} replyLength
 * @returns {boolean}
 */
export function shouldReview(lintResult, replyLength) {
  if (lintResult !== null && lintResult !== undefined) {
    if (lintResult.claimWithoutEvidence === true) return true
    if (lintResult.needsReview === true) return true
  }
  return typeof replyLength === 'number' && replyLength > 600
}
