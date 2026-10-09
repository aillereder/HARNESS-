/**
 * 内部状态变量的演化 —— 纯逻辑，无 IO、无时钟依赖。
 *
 * ## 为什么这一层不能交给模型
 *
 * 图上的「内部模拟变量」（耐心/活力/困意/专注）如果由模型输出 delta，
 * 状态机就等于交给了模型：它可以一句话让关系值暴涨，也可以自己宣布不困了。
 * 所以所有权是反的 —— **变量由事件与经过时间驱动，模型只能读**。
 *
 * 这也是「变量是 DSH 观察输出的」那句话的落地：我们不额外调一次模型去
 * 推断她的状态，而是从 DSH 已经发生的事实里算出来
 * （她说了多长、工具失败几次、多久没人理她）。
 *
 * ## 为什么漂移必须按真实时间成比例
 *
 * 老实现（probe/env_layer.py）踩过这个坑，注释原文：
 *
 *   > 第一版每次 drift() 都加一步噪声、拉一下基线、罚一次疲劳，而 drift()
 *   > 每轮会被调好几次（心跳一次、回忆重想一次、看图重想一次）……结果 3
 *   > 分钟里跑了 30 步，"三条没回音"的惩罚被计了十几遍，耐心从 5.5 一路
 *   > 砸到 0.5 的地板，所有状态永久趴在底部。
 *
 * 所以这里用**指数衰减**形式（而不是逐分钟循环）：
 *
 *     retention = exp(-elapsedMin / HALF_LIFE_MIN)
 *     x' = baseline + (x - baseline) * retention + sigma * sqrt(1 - retention^2) * N(0,1)
 *
 * 这样同时满足三件事：
 *   1. 按经过时间成比例（跑得快不会加速漂移，跑得慢也不会停滞）
 *   2. 单次调用即可，长空闲不必循环（老实现按 sqrt(分钟) 缩放，长间隔要分块）
 *   3. 噪声幅度按 sqrt(1-r^2) 缩放 —— 短间隔噪声小、长间隔趋向基线附近的稳态
 *      分布，这是均值回归随机游走（OU 过程）的精确离散解，不是近似。
 */

/** 各变量基线。不是"设定人格"，是"这个人的常态在哪"。 */
export const BASELINE = { mood: 6.0, energy: 6.5, patience: 5.5, focus: 5.0 }

/** 取值下限/上限。下限不取 0，避免出现"完全没有耐心"的绝对态。 */
export const CLAMP = [0.5, 9.8]

/**
 * 软性地板的两个端点。
 *
 * `FLOOR_LOW`：低于此值开始阻尼。`FLOOR_MIN`：理论上趋近但不越过。
 * 只作用于 `energy` / `focus`（体力与专注）—— **耐心不在其列**，
 * 因为被连续晾着时耐心就该能被压到地板，那是有意义的表达。
 */
export const FLOOR_LOW = 3.2
export const FLOOR_MIN = 1.8

/** 回归半衰期（分钟）。越小回得越快。 */
export const HALF_LIFE_MIN = 90

/** 每个变量每分钟的噪声幅度（在无回归极限下）。 */
export const SIGMA_PER_MIN = { mood: 0.55, energy: 0.7, patience: 0.5, focus: 0.65 }

/**
 * 事件权重。
 *
 * ## 为什么长度项必须有上限（实测教训）
 *
 * 第一版权重把长消息罚得很重：`assistantMessageEnergyPer200 = -0.1`，
 * 于是一段 1600 字的回复要扣 `-0.15 - 0.8 = -0.95` 活力。在线实测 17 轮
 * 后活力从 6.5 掉到 3.7，`generationBias` 已经把 `maxTokens` 压到 320 ——
 * 表现成"她越聊越像快没电"，而这是**参数错**不是机制错。
 *
 * 修法三条：
 *   1. 长度惩罚**封顶**（LENGTH_UNITS_CAP），长回复不该无底洞地扣
 *   2. 单条基础成本下调
 *   3. 安静时给正向恢复（SILENCE_RECOVER_*）——人歇一会儿是会回血的
 *
 * 注意消耗的**作用面**：`apply()` 只在事件发生时扣一次（不是每轮重复扣），
 * 而 `drift()` 每轮都把值往基线拉。所以这些负数不累积成永久低位。
 */
export const WEIGHT = {
  /** 每说一条助手消息：耗活力 */
  assistantMessageEnergy: -0.08,
  /** 助手消息越长越耗，按每 200 字折算，但**封顶** */
  assistantMessageEnergyPer200: -0.05,
  /** 每说一条：掉一点耐心（话说多了本来就会烦） */
  assistantMessagePatience: -0.02,
  /** 工具失败：掉耐心，连续失败再叠 */
  toolErrorPatience: -0.5,
  toolErrorEnergy: -0.1,
  toolErrorPatienceRepeat: -0.25,
  /** 一轮走很多步：耗专注 */
  stepFocus: -0.02,
  stepEnergy: -0.01,
  /** 用户回来了：心情回升、unanswered 清零 */
  userReturnMood: 0.6,
  userReturnPatience: 0.3,
  /** 连发没回音：每个积累的 unanswered **每分钟**扣（是压，不是抹） */
  unansweredPatience: -0.20,
  unansweredEnergy: -0.12,
  /** 她说得越多（单位时间条数）越耗活力 */
  burstEnergy: -0.05,
  /** burst 惩罚封顶：超过几条之后不再累加（防缺 turn 边界时无限增长） */
  burstPenaltyCap: 3,
  /** 安静恢复：距上次她说话超过阈值后，每分钟回一点 */
  silenceRecoverEnergy: 0.06,
  silenceRecoverFocus: 0.05,
  silenceRecoverAfterMin: 10,
  /** 安静恢复的总上限（避免久不说话直接回满） */
  silenceRecoverCap: 2.0,
}

/** 长度惩罚的折算单位上限：超过这个倍数不再多扣。 */
export const LENGTH_UNITS_CAP = 3

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return (lo + hi) / 2
  return v < lo ? lo : v > hi ? hi : v
}

/** 标准正态。Box-Muller，只用 Math.random，不依赖任何全局。 */
export function gaussian() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/**
 * 新建一个状态。now 由调用方注入，便于测试。
 * @param {number} now 毫秒时间戳
 */
export function createState(now) {
  return {
    mood: BASELINE.mood,
    energy: BASELINE.energy,
    patience: BASELINE.patience,
    focus: BASELINE.focus,
    /** 连发了几轮没回音。是事实不是随机变量 —— 不可由模型修改。 */
    unanswered: 0,
    /** 本轮她已说了几条（用于 burst 惩罚与分段上限） */
    burst: 0,
    /** 上一次演化到的时刻 */
    at: now,
    /** 她最后一次说话的时刻（安静恢复用）。未说过则为 undefined。 */
    lastSpeakAt: undefined,
    /** 值不值得记的累计观察，留给决策层 */
    lastUserAt: now,
  }
}

/**
 * 按经过时间演化（纯函数）。
 *
 * @param {object} state 当前状态（不被修改）
 * @param {number} now 毫秒时间戳
 * @param {number} [rng] 可选注入的均匀随机数（测试用）
 * @returns {object} 新状态
 */
export function drift(state, now, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random
  const elapsedMin = Math.max(0, (now - state.at) / 60000)
  const next = Object.assign({}, state, { at: now })
  if (elapsedMin <= 0) return next

  const r = Math.exp(-elapsedMin / HALF_LIFE_MIN)
  // sqrt(1 - r^2)：OU 过程的精确噪声缩放，避免长间隔时噪声塌成 0
  const noiseScale = Math.sqrt(Math.max(0, 1 - r * r))

  for (const key of ['mood', 'energy', 'patience', 'focus']) {
    const sigma = SIGMA_PER_MIN[key] * Math.sqrt(elapsedMin)
    const boxMuller = typeof rng === 'function' ? rng() : gaussian()
    const pulled = BASELINE[key] + (state[key] - BASELINE[key]) * r
    next[key] = clamp(pulled + noiseScale * sigma * boxMuller, CLAMP[0], CLAMP[1])
  }

  // 连发没回音是持续性的压 —— 按经过时间成比例，而不是按调用次数
  if (state.unanswered > 0) {
    const factor = elapsedMin / 1.0
    next.patience = clamp(next.patience + WEIGHT.unansweredPatience * state.unanswered * factor, CLAMP[0], CLAMP[1])
    next.energy = clamp(next.energy + WEIGHT.unansweredEnergy * state.unanswered * factor, CLAMP[0], CLAMP[1])
  }

  // 安静恢复：她有一阵没说话了，活力与专注回一点。
  // 人被晾着会累，但单纯"什么都没发生"的时间是休息 —— 这两件事要分开。
  if (state.lastSpeakAt !== undefined && Number.isFinite(state.lastSpeakAt)) {
    const silentMin = (now - state.lastSpeakAt) / 60000
    if (silentMin > WEIGHT.silenceRecoverAfterMin) {
      const recoverMin = Math.min(elapsedMin, silentMin - WEIGHT.silenceRecoverAfterMin)
      const gain = Math.min(WEIGHT.silenceRecoverCap, recoverMin * WEIGHT.silenceRecoverEnergy)
      next.energy = clamp(next.energy + gain, CLAMP[0], CLAMP[1])
      next.focus = clamp(next.focus + Math.min(WEIGHT.silenceRecoverCap, recoverMin * WEIGHT.silenceRecoverFocus), CLAMP[0], CLAMP[1])
    }
  }

  // ── 软性地板：越低越难再掉 ──────────────────────────────────────────────
  //
  // 为什么必须有这一条（实测逼出来的）：
  // 一段密集长对话里，每轮只隔几十秒，指数回归根本来不及把值拉回来，
  // 于是纯累加的消耗会在二十来轮内把活力按到地板上 —— 表现成"她越聊越没电"。
  // 而这是任何"每轮扣一点"的参数都躲不掉的结构性结果：
  //   系数大到能改变行为 → 二十轮必然触底
  //   系数小到二十轮不塌 → 这个变量根本没在起作用
  //
  // 修法不是继续调小系数，而是承认**体力不该在一次聊天里被掏空**。
  // 形式：把"本应先落到的值 v"与"上一值 prev"按接近地板的程度插值 ——
  // 越接近地板，越靠近 prev（即这一轮几乎不再往下掉）。
  //
  // v' = FLOOR_MIN + (prev - FLOOR_MIN) * damp + (v - FLOOR_MIN) * (1 - damp)
  // 其中 damp = (FLOOR_LOW - prev) / (FLOOR_LOW - FLOOR_MIN)，夹在 0..1。
  //
  // 这样收敛到一个接近 FLOOR_MIN 的平衡点
  // （等于就说明没在聊 → 回到系数问题），既保住"累了她会变短"的表达力，
  // 又不会出现"聊到一半没电"。
  //
  // 注意：**耐心不套这条**。被连续晾着时耐心就该能被压到地板 ——
  // 那是有意义的表达，不是 bug（test-tuning 场景 E 钉住了这个差别）。
  for (const key of ['energy', 'focus']) {
    const prev = state[key]
    const v = next[key]
    if (v < prev && prev < FLOOR_LOW) {
      let damp = (FLOOR_LOW - prev) / (FLOOR_LOW - FLOOR_MIN)
      if (damp < 0) damp = 0
      if (damp > 1) damp = 1
      next[key] = clamp(
        FLOOR_MIN + (prev - FLOOR_MIN) * damp + (v - FLOOR_MIN) * (1 - damp),
        CLAMP[0], CLAMP[1])
    }
  }

  return next
}

/**
 * 施加一个观察信号（纯函数）。
 *
 * 信号由 observe.js 从 DSH 事件里提取，模型无法直接产生信号 ——
 * 它只能通过「说了话」「调了工具」这些**已经发生的动作**间接影响状态。
 *
 * @param {object} state
 * @param {object} signal { kind, ...payload }
 * @returns {object} 新状态
 */
export function apply(state, signal) {
  if (signal === undefined || signal === null || typeof signal.kind !== 'string') return state
  const next = Object.assign({}, state, { at: signal.at !== undefined ? signal.at : state.at })

  switch (signal.kind) {
    case 'assistant-message': {
      const len = typeof signal.length === 'number' ? signal.length : 0
      // 长度折算封顶：长回复不该无底洞地扣活力（见 WEIGHT 注释里的实测教训）
      const chunks = Math.min(LENGTH_UNITS_CAP, len / 200)
      next.energy = clamp(next.energy
        + WEIGHT.assistantMessageEnergy
        + WEIGHT.assistantMessageEnergyPer200 * chunks, CLAMP[0], CLAMP[1])
      next.patience = clamp(next.patience + WEIGHT.assistantMessagePatience, CLAMP[0], CLAMP[1])
      next.burst = state.burst + 1
      // burst 惩罚**封顶**。没有这个上限时，burst 一旦因缺少 turn 边界而不归零，
      // 惩罚会随轮次线性增长（实测第 20 轮已达 -0.9/轮）并把活力压穿地板 ——
      // 那正是 trace 里 energy 从 6.5 掉到 0.50 的根因。
      const burstOver = Math.min(WEIGHT.burstPenaltyCap, Math.max(0, next.burst - 2))
      next.energy = clamp(next.energy + WEIGHT.burstEnergy * burstOver, CLAMP[0], CLAMP[1])
      // 记住"她最后一次说话的时刻"，安静恢复要用
      next.lastSpeakAt = signal.at !== undefined ? signal.at : state.lastSpeakAt
      break
    }
    case 'tool-result': {
      const repeat = typeof signal.consecutiveErrors === 'number' ? signal.consecutiveErrors : 0
      if (signal.isError === true) {
        next.patience = clamp(next.patience
          + WEIGHT.toolErrorPatience
          + WEIGHT.toolErrorPatienceRepeat * Math.max(0, repeat - 1), CLAMP[0], CLAMP[1])
        next.energy = clamp(next.energy + WEIGHT.toolErrorEnergy, CLAMP[0], CLAMP[1])
      }
      break
    }
    case 'turn-end': {
      const steps = typeof signal.steps === 'number' ? signal.steps : 0
      next.focus = clamp(next.focus + WEIGHT.stepFocus * steps, CLAMP[0], CLAMP[1])
      next.energy = clamp(next.energy + WEIGHT.stepEnergy * steps, CLAMP[0], CLAMP[1])
      next.burst = 0
      break
    }
    case 'user-message': {
      const silentMin = typeof signal.silentMin === 'number' ? signal.silentMin : 0
      // 隔得越久回来，心情回升越明显（但设上限，避免长时间没说话一次回满）
      const gain = Math.min(1.5, WEIGHT.userReturnMood * (1 + silentMin / 30))
      next.mood = clamp(next.mood + gain, CLAMP[0], CLAMP[1])
      next.patience = clamp(next.patience + WEIGHT.userReturnPatience, CLAMP[0], CLAMP[1])
      next.unanswered = 0
      next.burst = 0
      next.lastUserAt = signal.at !== undefined ? signal.at : state.lastUserAt
      break
    }
    case 'no-reply-turn': {
      next.unanswered = state.unanswered + 1
      break
    }
    default:
      break
  }
  return next
}

/**
 * 状态 → 供提示词使用的短文本。
 *
 * 纪律（老实现的注释）：**演化由代码做，解读由模型做**。
 * 代码只说"心情 4.2/10、连发 4 条没回音"，至于这意味着一句话都不想说、
 * 还是只回两个字、还是阴阳一下，那是模型的事。
 */
export function describe(state) {
  const f = (v) => (Math.round(v * 10) / 10).toFixed(1)
  const parts = [
    '心情 ' + f(state.mood) + '/10',
    '精力 ' + f(state.energy) + '/10',
    '耐心 ' + f(state.patience) + '/10',
    '专注 ' + f(state.focus) + '/10',
  ]
  if (state.unanswered > 0) parts.push('连发 ' + state.unanswered + ' 条没回音')
  return parts.join('、')
}

/**
 * 状态 → 生成参数偏移。
 *
 * 这是「内部变量 → 思考模型」最直接的落点：困了、没耐心就说得短、答得快。
 * 既拟人（累了惜字），也是真实的速度收益。
 *
 * @returns {{maxTokens: number, temperature: number}}
 */
export function generationBias(state) {
  let maxTokens = 800
  let temperature = 0.9
  // 档位刻意留得宽：长对话后精力 2.4 左右是**正常的累**，
  // 该表现成"回得短一点"，而不是"说不出话"。早期把低档压到 160，
  // 实测表现为她突然只会蹦几个字 —— 那是参数过激，不是拟人。
  if (state.patience < 3.5) { maxTokens = 600; temperature -= 0.05 }
  if (state.patience < 2.2) { maxTokens = 400; temperature -= 0.05 }
  if (state.energy < 2.5) maxTokens = Math.min(maxTokens, 500)
  if (state.energy < 1.8) maxTokens = Math.min(maxTokens, 400)
  if (state.focus < 3.5) { temperature += 0.05 }
  if (state.mood < 3.5) { temperature -= 0.05 }
  if (temperature < 0.5) temperature = 0.5
  if (temperature > 1.2) temperature = 1.2
  return { maxTokens: maxTokens, temperature: temperature }
}
