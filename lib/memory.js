/**
 * 记忆 —— 分层 + 隔离 + 召回。纯逻辑（IO 由宿主侧适配）。
 *
 * ## 为什么隔离是这一层的头等要求
 *
 * 旧实现（probe/memory_layer.py）只有单一的 `peer` 键，没有任何可见性概念。
 * 后果是：私聊里说的个人信息会跟着进群聊的提示词 —— 在那个人的群里
 * 把他在私聊讲的事说出来，是所有社交型 bot 最容易犯、也最不可挽回的错误。
 *
 * 所以每次写入必须带一个**作用域**，每次读取必须过一遍作用域判定：
 *
 *   私聊（private）  scope = { platform, peer }           只有对谈的两个人看得见
 *   群聊（group）    scope = { platform, group, sender }  群内可见；但**只对该群**
 *
 * 读取时命中条件（这是本模块唯一不能写错的地方）：
 *   · 同作用域的记录          → 可见
 *   · 同平台的私聊记录，且对谈者正是发送者 → 可见（"他自己跟我说过的事"）
 *   · 别的人群里的记录        → **绝不可见**
 *   · 别人的私聊记录          → **绝不可见**
 *
 * ## 召回用词法而不是向量
 *
 * DSH 没有 embedding 服务（全仓无 `embed` 能力），而旧实现本来也不是向量：
 * `_terms()` 是中文 2-gram + 英文词。所以沿用词法召回**不是退化**，
 * 是维持原状；同时它零依赖，符合"最快安装"。
 *
 * ## 三种取法（照图）
 *
 *   embed()    嵌入 —— 按当下情形挑几条灌进提示词（同步、有 token 上限）
 *   recall()   回忆 —— 思考层主动按关键词查
 *   readonly() 只读 —— 决策层用的快照，**代码里看得见它不能写**
 */

/** 单条记忆在提示词里允许占的最大字符数（约 300 token 量级）。 */
export const EMBED_BUDGET_CHARS = 900

/** 召回默认条数。 */
export const RECALL_LIMIT = 5

/**
 * 单次召回/嵌入最多扫描多少条记录。
 *
 * ## 为什么必须有这个上限（防卡死）
 *
 * `embed()` 挂在 `systemPrompt.context` 上，而那东西**每一个模型步都求值**。
 * 它对每条记录算一次 2-gram，所以代价是 O(记录数) × 每步 —— 记忆攒到几千条
 * 就会把每一步都拖慢，表现为"越用越卡"，而且很难归因到记忆上。
 *
 * 上限之外只保留**最近的**记录：聊得越近的事越相关，这条取舍本身也合理。
 */
export const MAX_SCAN = 800

/** 中文 2-gram + 英文/数字词。中文没有词边界，bigram 是够用的近似。 */
export function terms(text) {
  const out = Object.create(null)
  if (typeof text !== 'string' || text.length === 0) return out
  const lower = text.toLowerCase()

  const words = lower.match(/[a-z0-9_]{2,}/g)
  if (words !== null) {
    for (let i = 0; i < words.length; i += 1) out[words[i]] = true
  }

  const han = lower.match(/[\u4e00-\u9fff]/g)
  if (han !== null) {
    for (let i = 0; i < han.length - 1; i += 1) out[han[i] + han[i + 1]] = true
    if (han.length === 1) out[han[0]] = true
  }
  return out
}

/** 去掉空白与标点，用于短句包含判定。 */
function normChars(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/\s+/g, '').replace(/[。！？!?~～、，,.…·「」"'（）()【】[\]]/g, '')
}

/** 字符 2-gram 集合。 */
function bigrams(text) {
  const t = normChars(text)
  const set = Object.create(null)
  if (t.length === 0) return set
  if (t.length < 2) { set[t] = true; return set }
  for (let i = 0; i < t.length - 1; i += 1) set[t.slice(i, i + 2)] = true
  return set
}

/**
 * 主观前缀 —— 命中时不套用包含规则。
 *
 * 为什么需要这条护栏（实测踩出来的）：
 *   `'这事不对'` 确实是 `'我觉得这事不对'` 的子串，于是包含规则把
 *   一个完整短句和"带主观前缀的完整句"判成同一句 —— 但那恰恰是**正常承接**，
 *   不是同一个人在反复说同一句话。实测这一条会误判：
 *     '我觉得这事不对' | '这事不对'  → 被误判为重复
 *   而正确的判断是不该同句（这是对话里很常见的接话）。
 *
 * 加护栏而不是单纯收窄长度上限：收窄会丢掉这条规则的原意
 * （它对 `'滚'` vs `'滚你个废物'` 这类"同一个词反复刷"仍然必要）。
 */
const SUBJECTIVE_PREFIX = /^(?:我觉得|我认为|我看|我猜|我想|可能|应该|大概|也许|感觉)/

/**
 * 两条短文本是否在说同一件事。
 *
 * 四条规则缺一不可，前三条都是旧实现实测换来的（注释里保留原因）：
 *   · 归一后完全相同 → 同句（`哦` / `哦？` 靠它）
 *   · 短句是长句子串 → 同句，但**排除主观前缀**（见上）
 *   · Dice + 长度比双条件 → 抓改写，且不被"正常承接"误伤
 */
export function isSameStatement(a, b) {
  const ca = normChars(a)
  const cb = normChars(b)
  if (ca.length === 0 || cb.length === 0) return false

  // 规则 1：归一后相同
  if (ca === cb) return true

  // 规则 2：包含判定，只对**短的那条**（<= 6 字）且带主观前缀的不套
  const short = ca.length <= cb.length ? ca : cb
  const long = ca.length <= cb.length ? cb : ca
  if (short.length >= 1 && short.length <= 6 && long.indexOf(short) >= 0) {
    if (!SUBJECTIVE_PREFIX.test(short) && !SUBJECTIVE_PREFIX.test(long)) return true
  }

  // 规则 3：Dice + 长度比。
  // 实测数字（tmp-calib 量出）：
  //   `我觉得这事不对` | `这事不对`      Dice 0.667   ← 不该同句
  //   `他喜欢冰美式`   | `他喜欢喝冰美式` Dice 0.727   ← 应同句
  // 只差 0.06，单阈值太脆；长度比能拉开（改写 0.86 vs 承接 0.57）。
  const ba = bigrams(a)
  const bb = bigrams(b)
  const ka = Object.keys(ba)
  const kb = Object.keys(bb)
  if (ka.length === 0 || kb.length === 0) return false
  let inter = 0
  for (let i = 0; i < ka.length; i += 1) if (bb[ka[i]] === true) inter += 1
  if (inter === 0) return false
  const dice = (2 * inter) / (ka.length + kb.length)

  const ratio = ca.length <= cb.length ? ca.length / cb.length : cb.length / ca.length
  return dice >= 0.7 && ratio >= 0.6
}

/** 由关键词集合打分：命中的 query 词数 / query 总词数，再按长度轻微加权。 */
export function score(factText, queryTerms) {
  const ft = terms(factText)
  const keys = Object.keys(queryTerms)
  if (keys.length === 0) return 0
  let hit = 0
  for (let i = 0; i < keys.length; i += 1) if (ft[keys[i]] === true) hit += 1
  const base = hit / keys.length
  if (base === 0) return 0
  // 短事实命中同样词数时更相关（避免长文吸走所有权重）
  const len = typeof factText === 'string' ? factText.length : 0
  const brevity = 1 / (1 + len / 400)
  return base * (0.6 + 0.4 * brevity)
}

/**
 * 构造作用域键。
 * @param {{platform?: string, peer?: string, group?: string, sender?: string}} s
 */
export function scopeKey(s) {
  const platform = typeof s.platform === 'string' ? s.platform : 'dsh'
  if (typeof s.group === 'string' && s.group.length > 0) {
    return platform + '|group:' + s.group
  }
  return platform + '|private:' + (typeof s.peer === 'string' ? s.peer : 'unknown')
}

/**
 * 这条记录对这次读取是否可见 —— **本模块的安全核心**。
 *
 * @param {object} record { scope: {platform, peer?, group?, sender?}, visibility }
 * @param {object} reader {platform, peer?, group?, sender?}
 * @returns {boolean}
 */
export function visibleTo(record, reader) {
  if (record === null || record === undefined || reader === null || reader === undefined) return false
  const rs = record.scope
  if (rs === null || rs === undefined) return false

  const rPlatform = typeof rs.platform === 'string' ? rs.platform : 'dsh'
  const oPlatform = typeof reader.platform === 'string' ? reader.platform : 'dsh'
  // 跨平台不共享（QQ 的记忆不灌进 DSH 会话，反之亦然）
  if (rPlatform !== oPlatform) return false

  const rGroup = typeof rs.group === 'string' && rs.group.length > 0 ? rs.group : ''
  const oGroup = typeof reader.group === 'string' && reader.group.length > 0 ? reader.group : ''

  if (rGroup.length > 0) {
    // 群记忆：只对同一个群可见
    return oGroup.length > 0 && rGroup === oGroup
  }

  // 私聊记忆：只对同一个对谈者可见。
  // 群聊里即使发送者与私聊者是同一个人，也**不**自动可见 ——
  // 那是"他在私聊跟我说的事"，不该在他所在的群里被说出来。
  if (oGroup.length > 0) return false
  const rPeer = typeof rs.peer === 'string' ? rs.peer : ''
  const oPeer = typeof reader.peer === 'string' ? reader.peer : ''
  return rPeer.length > 0 && rPeer === oPeer
}

/**
 * 别名归一：昵称 / 账号 / 备注名指向同一个 peer。
 *
 * 旧实现踩过的坑（注释原文）：
 *   > memory.db 里七条事实的 peer 是 "Ailler"（昵称），而调用方拿的是
 *   > "1802352763"（QQ号），于是 embed() 查出来是空的 —— 记忆明明在库里，
 *   > 模型却什么都没看到，而**报错都没有**，这种沉默的丢失比崩溃难查得多。
 */
export class AliasTable {
  constructor() {
    this.map = Object.create(null)
  }

  /** 把一组名字绑到同一个 peer。 */
  link(peer, names) {
    if (typeof peer !== 'string' || peer.length === 0) return
    if (!Array.isArray(names)) return
    for (let i = 0; i < names.length; i += 1) {
      const n = names[i]
      if (typeof n !== 'string' || n.length === 0) continue
      this.map[n] = peer
    }
    this.map[peer] = peer
  }

  /** 归一到规范 peer；查不到就原样返回（不丢）。 */
  resolve(name) {
    if (typeof name !== 'string' || name.length === 0) return name
    const hit = this.map[name]
    return typeof hit === 'string' ? hit : name
  }
}

/**
 * 记忆库（纯逻辑）。IO 由宿主侧负责灌入 `load()` 与取走 `dump()`。
 */
export class MemoryStore {
  constructor(options) {
    const opts = options === undefined || options === null ? {} : options
    this.records = []
    this.aliases = opts.aliases instanceof AliasTable ? opts.aliases : new AliasTable()
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    this.pendingWrites = []
  }

  /** 从持久层灌入。畸形条目跳过，不让一条坏数据毁掉整个库。 */
  load(rows) {
    if (!Array.isArray(rows)) return 0
    let n = 0
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i]
      if (r === null || r === undefined) continue
      if (typeof r.text !== 'string' || r.text.length === 0) continue
      if (r.scope === null || r.scope === undefined) continue
      this.records.push(r)
      n += 1
    }
    return n
  }

  dump() {
    return this.records.slice()
  }

  /**
   * 写入一条记忆。去重规则：**同一作用域内**，内容与已有记录相同则不重复写。
   * @returns {{added: boolean, reason?: string, record?: object}}
   */
  write(input) {
    if (input === null || input === undefined) return { added: false, reason: 'bad-input' }
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (text.length === 0) return { added: false, reason: 'empty' }
    if (input.scope === null || input.scope === undefined) return { added: false, reason: 'no-scope' }

    const scope = {
      platform: input.scope.platform === undefined ? 'dsh' : input.scope.platform,
      group: input.scope.group,
      peer: input.scope.peer,
      sender: input.scope.sender,
    }
    const scopeId = scopeKey(scope)

    for (let i = 0; i < this.records.length; i += 1) {
      const r = this.records[i]
      if (scopeKey(r.scope) !== scopeId) continue
      if (isSameStatement(r.text, text)) return { added: false, reason: 'duplicate' }
    }

    const record = {
      text: text,
      scope: scope,
      kind: typeof input.kind === 'string' ? input.kind : 'fact',
      visibility: typeof input.visibility === 'string' ? input.visibility : 'scoped',
      at: this.now(),
      source: typeof input.source === 'string' ? input.source : 'tool',
    }
    this.records.push(record)
    return { added: true, record: record }
  }

  /**
   * 按作用域可见性过滤出候选，并**限制扫描条数**（取最近的 MAX_SCAN 条）。
   *
   * 这条上限是防卡死的关键：`embed()` 每个模型步都跑，
   * 不设上限的话代价随记忆条数线性增长。
   */
  visible(reader) {
    const out = []
    const all = this.records
    const start = all.length > MAX_SCAN ? all.length - MAX_SCAN : 0
    for (let i = start; i < all.length; i += 1) {
      if (visibleTo(all[i], reader)) out.push(all[i])
    }
    return out
  }

  /**
   * 嵌入：按当下情形挑记忆灌进提示词（图上的「嵌入 → 思考层」）。
   *
   * 与 recall 的区别：这条路是**系统主动**的，用的是当前对话的文本做 query，
   * 而且有硬预算 —— 绝不能把库里的东西一股脑塞进提示词。
   *
   * @param {object} reader 作用域
   * @param {string} situation 当前情形文本（通常是最近几条对话）
   * @param {number} [budgetChars]
   * @returns {{text: string, picked: number, chars: number}}
   */
  embed(reader, situation, budgetChars) {
    const budget = typeof budgetChars === 'number' ? budgetChars : EMBED_BUDGET_CHARS
    const q = terms(situation)
    const cands = this.visible(reader)
    const scored = []
    for (let i = 0; i < cands.length; i += 1) {
      const s = score(cands[i].text, q)
      if (s > 0) scored.push({ s: s, r: cands[i] })
    }
    scored.sort((a, b) => b.s - a.s)

    const lines = []
    let used = 0
    for (let i = 0; i < scored.length; i += 1) {
      const line = scored[i].r.text
      if (used + line.length > budget) break
      lines.push(line)
      used += line.length
    }
    return { text: lines.length === 0 ? '' : lines.join('\n'), picked: lines.length, chars: used }
  }

  /**
   * 回忆：思考层主动按关键词查（图上的「回忆 → 思考层」）。
   */
  recall(reader, query, limit) {
    const max = typeof limit === 'number' && limit > 0 ? limit : RECALL_LIMIT
    const q = terms(query)
    const cands = this.visible(reader)
    const scored = []
    for (let i = 0; i < cands.length; i += 1) {
      const s = score(cands[i].text, q)
      if (s > 0) scored.push({ s: s, r: cands[i] })
    }
    scored.sort((a, b) => b.s - a.s)
    const out = []
    for (let i = 0; i < scored.length && i < max; i += 1) out.push(scored[i].r)
    return out
  }

  /**
   * 只读快照 —— 决策层用（图上的「只读 → 决策层」）。
   *
   * 返回的数组刻意**不含**任何写入方法，让"这一份不能写"变成代码里
   * 看得见的事实，而不是一句约定（旧实现的注释就强调过这一点）。
   */
  readonly(reader, situation) {
    const picked = this.recall(reader, typeof situation === 'string' ? situation : '', 8)
    const texts = []
    for (let i = 0; i < picked.length; i += 1) texts.push(picked[i].text)
    return Object.freeze({
      texts: Object.freeze(texts),
      writable: false,
    })
  }
}
