/**
 * 主动心跳 —— 纯逻辑（定时与起轮由宿主侧驱动）。
 *
 * ## 图上的位置
 *
 * 「主动心跳 → 思考模型」那条线与「重要节点 → 记忆」。
 * 它的作用不是"定时发消息"，而是**让她在没人说话时也可能开口**。
 *
 * ## 三段分离（这是防刷屏的关键）
 *
 *   触发（定时器）  → 只产生"该评估了"的信号，**绝不调模型**
 *   决策（本模块）  → 纯逻辑：读状态 + 计数器 + 时段，输出 allow/deny + 理由
 *   内容（宿主侧）  → 仅 allow 之后才起一轮
 *
 * 前两段是纯函数、可单测、不花钱。GPT 那条方案的警告是对的：
 *   > 不要简单地让定时器周期性地调用大模型，再把模型生成的每句话发出去，
 *   > 否则非常容易形成刷屏或自我循环。
 *
 * ## 放行条件（全部满足才主动开口）
 *
 *   时段许可 · 冷却已过 · 今日预算未超 · 概率通过 · 用户已沉默够久 ·
 *   当前没有进行中的轮次 · 她自己的状态还撑得住
 *
 * 「状态撑得住」这一条是拟人的关键：**累了/没耐心就不主动找话说**。
 * 它不是安全阀，是性格的一部分。
 */

/** 默认策略。刻意保守 —— 主动开口是唯一会"无中生有"发消息的机制。 */
export const DEFAULT_POLICY = {
  /** 默认关。开启才会自主说话（避免装完就被"她突然找我"吓到）。 */
  enabled: false,
  /** 多久检查一次（毫秒）。**这是粒度上限** —— 她排的时机不可能比它更细。 */
  tickMs: 10000,
  /** 默认多久评估一次（毫秒）。她自己没给节奏时用。 */
  intervalMs: 10 * 60 * 1000,
  /** 距上次主动开口的最小间隔 */
  cooldownMs: 30 * 60 * 1000,
  /** 用户沉默多久才考虑主动 */
  silenceMs: 5 * 60 * 1000,
  /** 每天最多主动几次 */
  dailyBudget: 6,
  /** 每次评估通过后的概率（不是每次必发） */
  probability: 0.3,
  /** 不允许主动的时段（本地小时，左闭右开）。默认 0:00–7:00 不打扰 */
  quietHours: [[0, 7]],
  /** 精力低于此值就不主动（累了不想说话） */
  minEnergy: 3.0,
  /** 耐心低于此值就不主动 */
  minPatience: 2.5,
  /** 心情低于此值也不主动 */
  minMood: 2.5,
}

/** 本地日期键，用于每日预算的滚动重置。 */
export function dayKeyOf(now) {
  const d = new Date(now)
  const m = d.getMonth() + 1
  const day = d.getDate()
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day)
}

/** 本地小时。 */
export function hourOf(now) {
  return new Date(now).getHours()
}

/**
 * 当前小时是否在"不打扰"时段内。
 * @param {number} hour 0-23
 * @param {Array<[number, number]>} quietHours
 */
export function inQuietHours(hour, quietHours) {
  const ranges = Array.isArray(quietHours) ? quietHours : DEFAULT_POLICY.quietHours
  for (let i = 0; i < ranges.length; i += 1) {
    const r = ranges[i]
    if (!Array.isArray(r) || r.length < 2) continue
    const from = Number(r[0])
    const to = Number(r[1])
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    if (from <= to) {
      if (hour >= from && hour < to) return true
    } else {
      // 跨零点，如 [23, 7]
      if (hour >= from || hour < to) return true
    }
  }
  return false
}

/** 每日计数器。跨天自动归零。 */
export class DailyCounter {
  constructor() {
    this.day = ''
    this.count = 0
  }

  /** 读取今天的计数（跨天则归零后返回 0）。 */
  today(now) {
    const key = dayKeyOf(now)
    if (key !== this.day) { this.day = key; this.count = 0 }
    return this.count
  }

  bump(now) {
    this.today(now)
    this.count += 1
    return this.count
  }

  restore(day, count) {
    this.day = typeof day === 'string' ? day : ''
    this.count = typeof count === 'number' && count > 0 ? count : 0
  }

  snapshot() {
    return { day: this.day, count: this.count }
  }
}

/**
 * 决策：现在该不该主动开口。
 *
 * @param {object} input
 * @param {object} input.state       当前状态（state.js 的形状）
 * @param {number} input.now         当前毫秒时间戳
 * @param {number} input.lastUserAt  用户最后一次说话的时刻
 * @param {number} input.lastProactiveAt 她最后一次**主动**说话的时刻（没有则 0）
 * @param {number} input.todayCount  今天已主动几次
 * @param {boolean} input.busy       当前是否有进行中的轮次
 * @param {boolean} [input.explicitWake] 这次评估是**她自己排的时机到了**
 *   （或用户明确要求的）。为 true 时跳过"用户刚说过话"与"概率"两道闸 ——
 *   否则用户说"15 秒后跟我说话"，她会因为"用户刚说过话"被拦下，
 *   而概率闸还会让她有 60% 概率装死。那两条闸是给**自主**开口用的，
 *   不适用于被明确要求的时机。留着的只有安全性的两条：不打扰时段与每日预算。
 * @param {object} [input.policy]
 * @param {() => number} [input.rng] 均匀随机数，测试注入
 * @returns {{allow: boolean, reason: string}}
 */
export function evaluate(input) {
  const i = input === undefined || input === null ? {} : input
  const policy = Object.assign({}, DEFAULT_POLICY, i.policy === undefined ? {} : i.policy)
  const now = typeof i.now === 'number' ? i.now : Date.now()
  const rand = typeof i.rng === 'function' ? i.rng : Math.random

  if (policy.enabled !== true) return { allow: false, reason: '未启用' }

  // 有人正在说话 → 不插话
  if (i.busy === true) return { allow: false, reason: '有进行中的轮次' }

  if (inQuietHours(hourOf(now), policy.quietHours)) {
    return { allow: false, reason: '不打扰时段' }
  }

  const explicit = i.explicitWake === true

  if (!explicit) {
    const lastUserAt = typeof i.lastUserAt === 'number' ? i.lastUserAt : 0
    if (lastUserAt > 0 && now - lastUserAt < policy.silenceMs) {
      return { allow: false, reason: '用户刚说过话' }
    }
  }

  const lastProactiveAt = typeof i.lastProactiveAt === 'number' ? i.lastProactiveAt : 0
  if (lastProactiveAt > 0 && now - lastProactiveAt < policy.cooldownMs) {
    return { allow: false, reason: '还在冷却期' }
  }

  const todayCount = typeof i.todayCount === 'number' ? i.todayCount : 0
  if (todayCount >= policy.dailyBudget) return { allow: false, reason: '今日预算已用完' }

  // 状态撑不撑得住 —— 这是性格，不是安全阀
  const st = i.state === undefined || i.state === null ? {} : i.state
  if (typeof st.energy === 'number' && st.energy < policy.minEnergy) {
    return { allow: false, reason: '精力太低（累了不想说话）' }
  }
  if (typeof st.patience === 'number' && st.patience < policy.minPatience) {
    return { allow: false, reason: '耐心太低' }
  }
  if (typeof st.mood === 'number' && st.mood < policy.minMood) {
    return { allow: false, reason: '心情太低' }
  }

  // 概率闸只用于**自主**开口。被明确要求的时机（她自己排的、
  // 或用户让她"15 秒后说话"）不该靠掷骰子决定 —— 否则 60% 概率装死。
  if (!explicit && rand() > policy.probability) {
    return { allow: false, reason: '概率没过' }
  }

  return { allow: true, reason: explicit ? '她排的时机到了' : '可以主动开口' }
}

/**
 * 节奏由她自己给 —— 「主动引导自己的心跳」。
 *
 * ## 为什么必须有这一条
 *
 * 固定节奏 + 策略裁决只是"代码决定她什么时候可以说话"。
 * 真正的主动是**她自己决定多久之后再想一次** —— 原实现就是这么做的
 * （`brain.py`：`BEAT_SECONDS = 60 # 兜底心跳（秒）。只在模型自己没给节奏时用。`，
 * 配套 `_parse_wait(text)` 解析她给出的等待时长）。
 *
 * 没有这一条，她只能"被允许开口"，不能"自己安排下一次"。
 *
 * ## 三种结果
 *
 *   一个秒数  → 她要求这么久之后再考虑（覆盖默认间隔）
 *   0         → 她明确说"别叫我"（此后不再主动，直到用户说话）
 *   没给      → 用策略里的默认间隔
 */

/** 兜底心跳（秒）。她没给节奏时用。 */
export const DEFAULT_WAIT_SECONDS = 300

/**
 * 允许她给的最小/最大等待。
 *
 * 下限从 30 秒降到 5 秒，原因是实测：她按用户要求排了 15 秒，被夹成 30 秒。
 * 而夹还不是主要问题 —— **定时器的频率才是粒度上限**：
 * 定时器每 3 分钟才响一次时，她给 5 秒还是 30 秒都一样，都得等下一次 tick。
 * 所以这条下限必须和 `tickMs` 一起看（见 DEFAULT_POLICY.tickMs）。
 */
export const WAIT_MIN_SECONDS = 5
export const WAIT_MAX_SECONDS = 24 * 3600

function clampWait(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return WAIT_MIN_SECONDS
  if (seconds < WAIT_MIN_SECONDS) return WAIT_MIN_SECONDS
  if (seconds > WAIT_MAX_SECONDS) return WAIT_MAX_SECONDS
  return Math.round(seconds)
}

/**
 * 解析她给的节奏。
 *
 * 刻意宽松：可能是 "60"、"60秒"、"2分钟"、"半小时"、"别叫我了"。
 * 解析不出就返回 null（= 用默认），**不猜**。
 *
 * @param {string|number} input
 * @returns {{kind:'wait',seconds:number}|{kind:'never'}|null}
 */
export function parseWait(input) {
  if (input === null || input === undefined) return null

  if (typeof input === 'number' && Number.isFinite(input)) {
    if (input <= 0) return { kind: 'never' }
    return { kind: 'wait', seconds: clampWait(input) }
  }
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (text.length === 0) return null

  if (/别(叫|打扰|喊)|不用(叫|提)|不要(叫|打扰)|先别/.test(text)) return { kind: 'never' }
  if (/半\s*(?:个)?\s*小时/.test(text)) return { kind: 'wait', seconds: clampWait(1800) }

  const hour = /(\d+(?:\.\d+)?)\s*(?:个)?\s*小时/.exec(text)
  if (hour !== null) return { kind: 'wait', seconds: clampWait(Number(hour[1]) * 3600) }

  const minute = /(\d+(?:\.\d+)?)\s*(?:分|分钟|min)/i.exec(text)
  if (minute !== null) return { kind: 'wait', seconds: clampWait(Number(minute[1]) * 60) }

  const second = /(\d+(?:\.\d+)?)\s*(?:秒|s\b)/i.exec(text)
  if (second !== null) return { kind: 'wait', seconds: clampWait(Number(second[1])) }

  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text)
  if (bare !== null) {
    const n = Number(bare[1])
    if (n <= 0) return { kind: 'never' }
    return { kind: 'wait', seconds: clampWait(n) }
  }
  return null
}

/**
 * 决定下一次评估她的时刻。
 *
 * ## `nextAt` 为 null 的含义（踩过的 bug）
 *
 * 第一版在"她没给节奏"时返回 `now + defaultIntervalMs`。但每次 tick 都会重新
 * 算一遍，于是 `now < now + interval` **永远成立 —— 心跳一次都不会触发**。
 *
 * 这是语义搞错了：**默认间隔由定时器本身管**（`timer.interval(tick, intervalMs)`），
 * `nextAt` 这个闸只在**她自己定了节奏**时才该生效。
 * 所以没给节奏时返回 `nextAt: null`（不设闸）。
 *
 * @param {object} input
 * @param {number} input.now
 * @param {number} input.lastUserAt 用户上次说话（他说了就撤销"别叫我"）
 * @param {object} [input.selfWake] 她的节奏：{kind:'wait',seconds,at} 或 {kind:'never',at}
 * @returns {{nextAt: number|null, source: string}}
 */
export function resolveNextWake(input) {
  const i = input === undefined || input === null ? {} : input
  const now = typeof i.now === 'number' ? i.now : Date.now()

  const wake = i.selfWake
  if (wake === null || wake === undefined || typeof wake !== 'object') {
    return { nextAt: null, source: '无自定节奏（由定时器间隔决定）' }
  }

  const lastUserAt = typeof i.lastUserAt === 'number' ? i.lastUserAt : 0
  const wakeAt = typeof wake.at === 'number' ? wake.at : 0
  // 用户在她"别叫我"之后又说话了 → 撤销（不理她是一回事，开口了是另一回事）
  const userSpokeAfter = lastUserAt > wakeAt

  if (wake.kind === 'never' && !userSpokeAfter) {
    return { nextAt: Number.POSITIVE_INFINITY, source: '她说了别叫她' }
  }
  if (wake.kind === 'wait' && typeof wake.seconds === 'number' && !userSpokeAfter) {
    return { nextAt: wakeAt + wake.seconds * 1000, source: '她自定节奏 ' + wake.seconds + 's' }
  }
  return { nextAt: null, source: '她的节奏已失效（用户说过话）' }
}

/**
 * 主动开口时注入的旁注。
 *
 * 它必须**允许沉默** —— 否则她每次评估都会硬找一句话，
 * 那就退化成"定时发消息"了。所以明确写着"没什么想说的就别说"。
 *
 * 同时告诉她**可以自己安排节奏** —— 能力不告知等于不存在。
 *
 * 用记录口吻（与 L2 的更正一致）：`steer` 只能注入 user 角色，
 * 第一人称内心话贴成别人的话会让模型读出错位。
 */
export function proactiveHint(stateText) {
  const s = typeof stateText === 'string' && stateText.trim().length > 0 ? stateText.trim() : ''
  const lines = [
    '【旁注·时间过去了】',
    '已经有一阵没人说话了。你可以主动起个话头（问问对方在做什么、',
    '接着之前聊过的事说、或者想到什么就说什么），也可以什么都不说。',
  ]
  if (s.length > 0) lines.push('你现在的状态：' + s)
  lines.push('没什么真想说的就别开口 —— 硬找话说比沉默更明显。')
  lines.push('想自己定节奏就调 heartbeat_wait：给秒数就是"这么久之后再想"，给 0 就是"别叫我"。')
  return lines.join('\n')
}
