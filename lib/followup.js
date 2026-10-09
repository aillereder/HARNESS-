/**
 * 入站严格顺序 —— 纯逻辑（等待由可注入的调度器驱动）。
 *
 * ## 它防的是什么
 *
 * 她在说话的时候，用户又连发两条。如果每条都独立起一轮处理：
 *
 *   t0  消息A 进来 → 起处理 A
 *   t1  消息B 进来 → 起处理 B      ← 两个处理并发跑同一份上下文
 *   t2  B 先说完 → 先发出
 *   t3  A 才说完 → 后发出          ← **回复顺序反了，且两条都基于被污染的上下文**
 *
 * 这是自动回复类 bot 最典型的事故：用户看到的是答非所问 + 顺序颠倒。
 *
 * ## 做法（照 AstrBot 的 follow-up 状态机）
 *
 * 每条入站消息在**到达时**就分配一个单调递增的序号（到达顺序，不是唤醒顺序），
 * 进入四状态之一：
 *
 *   pending    已登记，还没被处理
 *   active     正在被处理（拿到"当前回合"）
 *   consumed   已被前面的处理顺带消化（不必单独回复）
 *   finished   自己处理完了
 *
 * 关键规则：**只有队首（nextTurn）能继续**。后面的必须等。
 * 队首清理掉已完成的槽位后向前推进。
 *
 * ## 与"静默窗合并"的关系
 *
 * 合并是把短时间内的多条合成一条；顺序是保证不颠倒。
 * 两者叠加：先按静默窗合并，再对合并后的批次走本状态机。
 * 本模块只管后者 —— 前者是宿主侧的定时器逻辑。
 */

/** 槽位状态。 */
export const PENDING = 'pending'
export const ACTIVE = 'active'
export const CONSUMED = 'consumed'
export const FINISHED = 'finished'

/**
 * 极简的异步信号量：`wait()` 返回一个 promise，`notify()` 唤醒所有等待者。
 *
 * 不用全局 setTimeout/Promise.race 之类的外部设施，只用 Promise，
 * 这样在纯逻辑测试里也能确定性地驱动。
 */
class Signal {
  constructor() {
    this.waiters = []
  }

  wait() {
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  notify() {
    const w = this.waiters
    this.waiters = []
    for (let i = 0; i < w.length; i += 1) w[i]()
  }
}

/**
 * 一个会话的入站顺序控制器。
 */
export class FollowUpQueue {
  constructor() {
    this.status = new Map()   // seq -> 状态
    this.nextOrder = 0        // 单调递增的分配器
    this.nextTurn = 0         // 当前允许继续的队首
    this.signal = new Signal()
    /** 去重用的已见 message_id */
    this.seen = new Set()
    /** 是否有一个"当前活跃回合"（她在说话） */
    this.active = false
  }

  /**
   * 登记一条入站消息。**在到达时调用**，以保证序号反映到达顺序。
   *
   * @param {string} [dedupKey] 幂等键（通常是 OneBot 的 message_id）
   * @returns {{seq: number, duplicate: boolean}}
   */
  begin(dedupKey) {
    if (typeof dedupKey === 'string' && dedupKey.length > 0) {
      if (this.seen.has(dedupKey)) return { seq: -1, duplicate: true }
      this.seen.add(dedupKey)
    }
    const seq = this.nextOrder
    this.nextOrder += 1
    this.status.set(seq, PENDING)
    return { seq: seq, duplicate: false }
  }

  /** 以"已被前面的处理消化"结束一个槽位。 */
  markConsumed(seq) {
    if (!this.status.has(seq)) return
    if (this.status.get(seq) === FINISHED) return
    this.status.set(seq, CONSUMED)
    this.advance()
    this.signal.notify()
  }

  /** 以"自己处理完了"结束一个槽位。 */
  finish(seq) {
    if (!this.status.has(seq)) return
    this.status.set(seq, FINISHED)
    this.advance()
    this.signal.notify()
  }

  /** 推进队首：跳过已结束的槽位，停在第一个未完成的。 */
  advance() {
    for (;;) {
      const cur = this.status.get(this.nextTurn)
      if (cur === CONSUMED || cur === FINISHED) {
        this.status.delete(this.nextTurn)
        this.nextTurn += 1
        continue
      }
      break
    }
    // 槽位全空 → 没有活跃回合
    if (this.status.size === 0) this.active = false
  }

  /**
   * 等待轮到本序号，然后把它置为 active。
   *
   * @param {number} seq
   * @param {number} [timeoutMs] 可选的超时上限（防止头阻塞卡死）
   * @param {() => number} [clock] 注入的时钟，测试用
   * @returns {Promise<boolean>} true = 轮到你了；false = 槽位已消失（被消化/超时）
   */
  async awaitTurn(seq, timeoutMs, clock) {
    for (;;) {
      if (!this.status.has(seq)) return false
      const state = this.status.get(seq)
      if (state === CONSUMED || state === FINISHED) return false
      if (this.nextTurn === seq) {
        this.status.set(seq, ACTIVE)
        this.active = true
        return true
      }
      // 还没轮到：等被通知
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        const now = typeof clock === 'function' ? clock : Date.now
        const deadline = now() + timeoutMs
        let timedOut = false
        for (;;) {
          const remaining = deadline - now()
          if (remaining <= 0) { timedOut = true; break }
          const raced = await Promise.race([
            this.signal.wait().then(() => 'notified'),
            new Promise((r) => { setTimeout(() => r('timeout'), remaining) }),
          ])
          if (raced === 'notified') break
          timedOut = true
          break
        }
        if (timedOut) {
          // 超时释放：把自己当作可继续，避免整个队列卡死
          if (this.status.has(seq)) {
            this.status.set(seq, ACTIVE)
            this.active = true
            return true
          }
          return false
        }
      } else {
        await this.signal.wait()
      }
    }
  }

  /** 当前是否有一个活跃回合（她在说话）。 */
  isActive() {
    return this.active
  }

  /** 诊断用快照。 */
  snapshot() {
    const out = []
    for (const [seq, st] of this.status.entries()) out.push({ seq: seq, state: st })
    out.sort((a, b) => a.seq - b.seq)
    return { nextTurn: this.nextTurn, nextOrder: this.nextOrder, slots: out, active: this.active }
  }
}

/**
 * 静默窗合并器 —— 把短时间内到达的多条合成一批。
 *
 * 纯逻辑：只判断"这批该不该现在发"，定时由宿主侧驱动。
 * 与顺序控制器叠加使用：合并 → 再进 FollowUpQueue。
 */
export class Debouncer {
  /**
   * @param {number} [silenceMs] 静默窗；默认 200ms（依据：人看到连续几条
   *   消息的反应间隔通常在这个量级，太长会把"秒回"变成"迟钝"）
   */
  constructor(silenceMs) {
    this.silenceMs = typeof silenceMs === 'number' && silenceMs > 0 ? silenceMs : 200
    this.items = []
    this.lastAt = 0
    this.timer = null
  }

  /**
   * 推入一条。返回"是否应当立刻触发"（false 表示等静默窗）。
   * @param {*} item
   * @param {number} now 毫秒
   */
  push(item, now) {
    this.items.push(item)
    this.lastAt = now
    return false
  }

  /** 静默窗是否已过（宿主侧据此触发）。 */
  ready(now) {
    if (this.items.length === 0) return false
    return now - this.lastAt >= this.silenceMs
  }

  /** 取走并清空当前批次。 */
  take() {
    const batch = this.items.slice()
    this.items = []
    return batch
  }

  get size() {
    return this.items.length
  }
}

/**
 * 每会话频率上限 —— 超限**丢弃**而不是排队。
 *
 * 为什么丢弃：排队会雪崩。一旦处理速度追不上到达速度，队列只会越积越长，
 * 最后她把十分钟前的消息一起回出来 —— 那比不回更糟。
 * AstrBot 用 RateLimitStage 做同一件事。
 */
export class RateLimiter {
  /**
   * @param {number} [perMinute] 每分钟允许的回合数
   * @param {number} [burst] 允许的瞬时突发
   */
  constructor(perMinute, burst) {
    this.perMinute = typeof perMinute === 'number' && perMinute > 0 ? perMinute : 12
    this.burst = typeof burst === 'number' && burst > 0 ? burst : 4
    this.hits = []
  }

  /**
   * @param {number} now
   * @returns {boolean} true = 放行
   */
  allow(now) {
    const windowStart = now - 60000
    const kept = []
    for (let i = 0; i < this.hits.length; i += 1) {
      if (this.hits[i] > windowStart) kept.push(this.hits[i])
    }
    this.hits = kept
    if (this.hits.length >= this.perMinute) return false

    // 突发检查：最近 3 秒内不超过 burst
    let recent = 0
    for (let i = 0; i < this.hits.length; i += 1) {
      if (this.hits[i] > now - 3000) recent += 1
    }
    if (recent >= this.burst) return false

    this.hits.push(now)
    return true
  }
}
