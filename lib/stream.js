/**
 * 实时分句与发送节奏 —— 纯逻辑，无 IO、无时钟。
 *
 * ## 这个模块解决的是"拟人"与"延迟"的冲突
 *
 * 两者本来是对立的：等全文写完再发 → 慢；一个字一个字发 → 像机器。
 * 解法是**首段零延迟 + 后续段按对数间隔**：
 *
 *     首句写完（1~2s）──► 立刻发第一段        ← 感知延迟由它决定
 *     全文写完（3~8s）──► 余下各段按间隔发    ← 像人一样分几条
 *
 * 所以 `intervalFor` 的返回值**只用于非首段**。首段的间隔永远是 0。
 * 这条如果写反（首段也等一个间隔），秒回就没了 —— 那是最容易犯的错。
 *
 * ## 间隔公式来自 AstrBot 的实测值
 *
 * `respond/stage.py` 里 `_calc_comp_interval` 用的是
 * `uniform(log(词数+1, 2.6), log(词数+1, 2.6) + 0.5)`。
 * 换成可读的秒数：5 字 → 1.7~2.2s，15 字 → 2.9~3.4s，40 字 → 3.8~4.3s。
 * 也就是**段越长、停顿越久**，读起来像"想了一下接着说"，而不是固定节拍。
 *
 * ## 分句规则（为什么逗号不能切）
 *
 * 切在逗号上会得到"嗯，" / "我觉得吧，" / "这事" 这种碎片 —— 每一条单独看
 * 都不像人说的话。AstrBot 的做法是**长段反而不切**（超过阈值整段发），
 * 本模块沿用：切碎长段落比不切更假。
 */

/** 只在这些位置切：句末标点或换行。**绝不在逗号切。** */
const SENTENCE_END = /[。！？!?…\n]/

/** 首段最短长度：太短像敷衍，太长就没有秒回了。 */
export const FIRST_MIN_CHARS = 12

/** 非首段最短长度。 */
export const NEXT_MIN_CHARS = 10

/** 超过这个长度就不切了，整段发（照 AstrBot）。 */
export const NO_SPLIT_OVER = 120

/** 单段最长：到这里即使没句末标点也切，避免一段无限长。 */
export const SEG_MAX_CHARS = 140

/** 每轮最多几段。防刷屏。 */
export const MAX_SEGMENTS = 5

/** 对数间隔的底数（AstrBot 实测值）。 */
export const LOG_BASE = 2.6

/** 抖动量（秒）。AstrBot 用 0.5；降到 0.35 让节奏更贴合中文短句。 */
export const JITTER_SECONDS = 0.35

/** 代码块/表格一类不该切的痕迹。命中则整段不切。 */
const NO_SPLIT_HINT = /```|^\s*\|.*\|\s*$/m

/**
 * 数"词数"。中文按字符数算（没有词边界），英文按空白分词。
 * 与 AstrBot `_word_cnt` 同思路。
 */
export function wordCount(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let ascii = true
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break }
  }
  if (ascii) {
    const parts = text.split(/\s+/)
    let n = 0
    for (let i = 0; i < parts.length; i += 1) if (parts[i].length > 0) n += 1
    return n
  }
  let n = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i)
    if (/\s/.test(c)) continue
    n += 1
  }
  return n
}

/**
 * 一段文本之后应当停顿多久（秒）。
 *
 * @param {string} text 已完成的那一段
 * @param {number} [rng] 均匀随机数，测试注入用
 * @returns {number} 秒
 */
export function intervalFor(text, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random
  const words = wordCount(text)
  const base = Math.log(words + 1) / Math.log(LOG_BASE)
  const jitter = rand() * JITTER_SECONDS
  const seconds = base + jitter
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return seconds
}

/** 段内是否含不该切的内容（代码块等）。 */
export function hasNoSplitHint(text) {
  return NO_SPLIT_HINT.test(text)
}

/**
 * 从缓冲里取出一段可以立刻发出去的文本，没有则返回 null。
 *
 * @param {string} buffer 已累积但未发出的文本
 * @param {boolean} isFirst 是否为首段
 * @param {boolean} final 生成是否已结束（结束后允许把残余发出去）
 * @returns {{text: string, rest: string} | null}
 */
export function takeSegment(buffer, isFirst, final) {
  if (typeof buffer !== 'string' || buffer.length === 0) return null
  const minChars = isFirst ? FIRST_MIN_CHARS : NEXT_MIN_CHARS

  // 不该切的内容：整段不动，只在生成结束时发
  if (hasNoSplitHint(buffer)) {
    if (final) return { text: buffer, rest: '' }
    return null
  }

  // 超过不切阈值：整段发（AstrBot 同款判断）
  if (buffer.length > NO_SPLIT_OVER) {
    return { text: buffer, rest: '' }
  }

  // 找**第一个**句末标点。
  //
  // 这里曾经取的是最后一个（循环不 break），后果是首段把整段话全吞了 ——
  // 永远只切出一段，节奏整个消失。而代码"看起来能切"，所以这个 bug
  // 只有靠 test-stream 的"段数 > 1"断言才抓得住。
  // 取第一个也更符合人的节奏：先说出第一句，后面的过一会儿再说。
  let cut = -1
  for (let i = 0; i < buffer.length; i += 1) {
    if (SENTENCE_END.test(buffer.charAt(i))) { cut = i + 1; break }
  }

  // 尾部是"少于下限、且没有句末标点"的残句时，本轮连同它一起发出去。
  //
  // 规则不该只活在 final 分支里：一块碎片（如"开头……。尾"里的"尾"）
  // 无论生成是否结束，都不该单独立一条消息 —— 那看起来像人说到一半断气。
  // 而它若被推迟到"以后"，那个以后不会再来（实测踩过：第二句只有 7 字，
  // 低于非首段下限，于是永远发不出去）。
  if (cut !== -1) {
    const tail = buffer.slice(cut)
    const tailHasEnd = tail.length > 0 && SENTENCE_END.test(tail.charAt(tail.length - 1))
    if (tail.length > 0 && tail.length < NEXT_MIN_CHARS && !tailHasEnd) {
      return { text: buffer, rest: '' }
    }
  }

  // 生成已结束：仍按句边界切，不要一把全发（那会一次性刷出全部内容，
  // 把"分几条说"的节奏整个抹掉）。
  //
  // 回填规则要窄：**只回填"没有句末标点的半句话"**（长度也受限）。
  // 不能只按长度判断 —— 否则尾部一个完整的短句（如"还有别的事吗？"）
  // 会被并进上一段，等于那句话永远发不出去。
  if (final) {
    if (cut === -1) return { text: buffer, rest: '' }
    const rest = buffer.slice(cut)
    const restHasEnd = rest.length > 0 && SENTENCE_END.test(rest.charAt(rest.length - 1))
    if (rest.length > 0 && rest.length < NEXT_MIN_CHARS && !restHasEnd) {
      return { text: buffer, rest: '' }
    }
    return { text: buffer.slice(0, cut), rest: rest }
  }

  if (cut === -1) {
    // 没有句末标点：只有长到一定地步才硬切，避免碎片
    if (buffer.length >= SEG_MAX_CHARS) return { text: buffer, rest: '' }
    return null
  }

  // 有句末标点，但首段太短就再等等（除非已经很长了）
  //
  // ⚠️ 这个"再等等"**只在生成还没结束时成立**。
  // 生成结束后绝不能因为短就继续留 —— 那是一条真的要发出去的话，
  // 而被推迟到"以后"的以后不会再来。实测踩过：第二句是"还有别的事吗？"
  // （7 字，低于非首段下限 10），于是那一句永远发不出去。
  const candidate = buffer.slice(0, cut)
  if (candidate.length < minChars && buffer.length < SEG_MAX_CHARS) {
    if (!final) return null
  }

  return { text: candidate, rest: buffer.slice(cut) }
}

/**
 * 一轮的分段状态机。
 *
 * 用法（宿主侧）：
 *   const seg = new Segmenter()
 *   // 每来一个 text-delta：
 *   seg.push(text)
 *   // 每次循环：
 *   const next = seg.pull()          // { text, isFirst, delayMs, index } 或 null
 *   if (next) { await sleep(next.delayMs); await send(next.text) }
 *   // 生成结束：
 *   seg.finish()
 *
 * 互斥：`sent` 计数是唯一真相。宿主侧的终局发送**必须先问 `alreadySent()`**，
 * 否则一次回复会发两遍（AstrBot 用 `_streaming_finished` 标记防的正是这个）。
 */
export class Segmenter {
  constructor() {
    this.buffer = ''
    this.sent = 0
    this.finished = false
    /**
     * 是否已把**本次生成的完整正文**发出过。
     *
     * 与 `sent > 0` 是两件事，混淆会出两种相反的 bug：
     *   · 拿 `sent > 0` 当"完整发过" → 残余被误拦、永久丢失（少话）
     *   · 完全不记这个标记        → 流式发一遍、终局再发一遍（重复回复）
     * AstrBot 用 `_streaming_finished` 防的正是后者。
     */
    this.sentComplete = false
    /** 已发出的段，供宿主侧去重 */
    this.sentTexts = []
  }

  push(text) {
    if (typeof text !== 'string' || text.length === 0) return
    this.buffer += text
  }

  finish() {
    this.finished = true
  }

  /**
   * 是否已经完整发过（宿主侧据此**跳过**终局发送）。
   * 只发过一部分时返回 false —— 残余还得发。
   */
  alreadySentComplete() {
    return this.sentComplete
  }

  /** 是否已发过任何内容（宿主侧据此决定是否进入分段模式）。 */
  anySent() {
    return this.sent > 0
  }

  /**
   * 取出下一段。
   * @param {number} [rng] 均匀随机数，测试注入用
   * @returns {{text: string, isFirst: boolean, delayMs: number, index: number} | null}
   */
  pull(rng) {
    if (this.sent >= MAX_SEGMENTS) return null
    const isFirst = this.sent === 0
    const got = takeSegment(this.buffer, isFirst, this.finished)
    if (got === null) return null

    this.buffer = got.rest
    const text = got.text
    if (typeof text !== 'string' || text.length === 0) return null

    // 首段零延迟 —— 这是"秒回"的全部来源
    const delaySec = isFirst ? 0 : intervalFor(text, rng)
    this.sent += 1
    // 生成已结束、缓冲也空了 → 本次生成的正文已经全部发出去
    if (this.finished && this.buffer.length === 0) this.sentComplete = true
    this.sentTexts.push(text)

    return {
      text: text,
      isFirst: isFirst,
      delayMs: Math.round(delaySec * 1000),
      index: this.sent,
    }
  }

  /** 生成结束后把残余一并取出（可能还有多段）。 */
  drain(rng) {
    const out = []
    for (;;) {
      const s = this.pull(rng)
      if (s === null) break
      out.push(s)
    }
    return out
  }
}
