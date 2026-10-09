/**
 * dsh-composite 宿主侧 —— 双平面接线。
 *
 * ## 两个平面各做什么
 *
 *   宿主面（profile 的 bundle 行）
 *     · NapCat 桥：入站事件 → DSH 会话；出站回复 → QQ
 *     · 跨会话共享的东西：状态库、记忆库、peer→会话 映射
 *     · 这些必须只有一个实例，所以放宿主面
 *
 *   preset 面（`plane: 'preset'`）
 *     · 人格段、状态上下文、记忆工具、L1/L2 决策挂载
 *     · 每个会话一份，随 preset 挂载/卸载
 *
 * ## 一条不能破的纪律：任何风险点都要包住
 *
 * dsh-herta 的教训原文：
 *   > 静态 import 的解析失败发生在模块求值阶段，会让**整个插件挂载失败**
 *   > —— 那会把记忆/语音/界面一起弄坏。
 *
 * 所以所有非核心依赖（NapCat、工具注册、决策模型）都用动态 import + try/catch，
 * 最坏情况只是那个功能缺席，其余照常。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryStore, AliasTable } from './memory.js'
import { NapCatClient } from './napcat.js'
import { OneBotSocket } from './ws.js'
import { TurnRecorder, assistantText, composeContext } from './observe.js'
import { VetoQuota, buildPrompt, formatCorrection, parseVerdict, shouldReview } from './decide.js'
import { lint, reviewInput, sendStrategy } from './filter.js'
import { Debouncer, FollowUpQueue, RateLimiter } from './followup.js'
import { DailyCounter, evaluate, parseWait, proactiveHint, resolveNextWake } from './heartbeat.js'
import { parseMessageEvent, sendTarget, shouldHandle, toPromptText } from './onebot.js'
import { Segmenter } from './stream.js'
import { apply as applySignal, createState, describe as describeState, drift, generationBias } from './state.js'

/** Cordis 插件名。必须与 cordis.patch.yml 与 loader 行 id 一致。 */
export const name = 'composite'

/** 核心硬依赖：没有它就没有提示词可选。 */
export const inject = ['systemPrompt']

/** 人格段的排序位：紧跟在部署人格前缀（0）之后。 */
const PERSONA_ORDER = 100

/** 状态/记忆上下文的排序位。 */
const CONTEXT_ORDER = 200

// ── 模块级共享（模块只求值一次，但 apply 会在两个平面上各跑一次）─────────

/** @type {Map<string, object>} 按 DSH_HOME 索引的数据目录 */
const dataDirs = new Map()

function resolveDataDir() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  // 纯 ASCII 路径要求：DSH 在 Windows 上对某些字符有截断 bug，这里不额外判断，
  // 只保证拼出来的路径与 DSH_HOME 一致（用户自己选择 DSH_HOME）。
  return path.join(home, 'composite')
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback
    const text = fs.readFileSync(file, 'utf8')
    if (text.trim().length === 0) return fallback
    return JSON.parse(text)
  } catch (error) {
    return fallback
  }
}

/** 原子写：先写临时文件再 rename，避免半截文件。 */
function writeJsonAtomic(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (error) {
    return false
  }
}

function readJsonlSafe(file) {
  try {
    if (!fs.existsSync(file)) return []
    const text = fs.readFileSync(file, 'utf8')
    const out = []
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      try { out.push(JSON.parse(line)) } catch (error) { /* 跳过坏行 */ }
    }
    return out
  } catch (error) {
    return []
  }
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/**
 * 共享运行时。两个平面都从这里取同一份。
 * 用一次 apply 建、后续 apply 复用。
 */
class Shared {
  constructor(dir) {
    this.dir = dir
    this.stateFile = path.join(dir, 'state.json')
    this.memoryFile = path.join(dir, 'memory.jsonl')
    this.pendingFile = path.join(dir, 'pending.jsonl')

    this.aliases = new AliasTable()
    this.memory = new MemoryStore({ aliases: this.aliases })

    /** peer → 状态 */
    this.states = new Map()
    /** peer → 入站顺序控制器 */
    this.queues = new Map()
    /** peer → 静默窗 */
    this.debouncers = new Map()
    /** peer → 限频 */
    this.limiters = new Map()
    /** peer → DSH 会话 id */
    this.sessions = new Map()
    /** 会话 id → 本轮记录器（观察/出站/决策共用同一份） */
    this.recorders = new Map()
    /** 会话 id → 状态采样环形缓冲（控制台画折线用） */
    this.history = new Map()
    /** 最近的决定与心跳（控制台显示） */
    this.decisions = []
    /** 会话 id → 她自己给的节奏 {kind,seconds,at}（引导自己的心跳） */
    this.selfWake = new Map()
    /** 最近一次主动 steer 的会话 —— heartbeat_wait 据此归属 */
    this.lastProactiveSession = null
    /** 挂载了 preset 面的会话（只对这些会话注入人格与状态） */
    this.presetSessions = new Set()
    /** 待注入的 L2 纠正（按会话） */
    this.corrections = new Map()

    this.log = []
    this.loaded = false
  }

  ensureLoaded() {
    if (this.loaded) return
    const raw = readJsonSafe(this.stateFile, {})
    if (raw !== null && typeof raw === 'object') {
      for (const key of Object.keys(raw)) {
        const s = raw[key]
        if (s === null || s === undefined || typeof s !== 'object') continue
        // 恢复时按当前时间漂移一次，避免"关机期间状态冻结"
        const restored = Object.assign(createState(Date.now()), s)
        this.states.set(key, restored)
      }
    }
    const rows = readJsonlSafe(this.memoryFile)
    this.memory.load(rows)
    this.loaded = true
  }

  persistState() {
    const out = {}
    for (const [key, value] of this.states.entries()) out[key] = value
    return writeJsonAtomic(this.stateFile, out)
  }

  stateFor(key) {
    if (!this.states.has(key)) this.states.set(key, createState(Date.now()))
    return this.states.get(key)
  }

  recorderFor(key) {
    if (!this.recorders.has(key)) this.recorders.set(key, new TurnRecorder())
    return this.recorders.get(key)
  }

  /** 环形缓冲：控制台折线用。上限 80 个采样点，避免无界增长。 */
  sample(key, state) {
    if (!this.history.has(key)) this.history.set(key, [])
    const ring = this.history.get(key)
    ring.push({
      at: Date.now(),
      mood: state.mood, energy: state.energy,
      patience: state.patience, focus: state.focus,
      unanswered: state.unanswered,
    })
    if (ring.length > 80) ring.shift()
    return ring
  }

  /** 记一条给人看的决定/事件（控制台显示，上限 60 条）。 */
  noteDecision(text) {
    this.decisions.push({ at: Date.now(), text: String(text) })
    if (this.decisions.length > 60) this.decisions.shift()
  }

  queueFor(key) {
    if (!this.queues.has(key)) this.queues.set(key, new FollowUpQueue())
    return this.queues.get(key)
  }

  debouncerFor(key) {
    if (!this.debouncers.has(key)) this.debouncers.set(key, new Debouncer())
    return this.debouncers.get(key)
  }

  limiterFor(key) {
    if (!this.limiters.has(key)) this.limiters.set(key, new RateLimiter())
    return this.limiters.get(key)
  }

  /**
   * 总开关：`${DSH_HOME}/composite/disabled` 存在就整体停用。
   *
   * ## 为什么需要它（不只是 YAML 的 disabled）
   *
   * `cordis.patch.yml` 里的 `disabled: true` 只停掉**宿主面那一行**；
   * 预设面那一行（`plane: preset`）照样加载 —— 人格段、状态上下文、
   * 主动心跳都还在跑。用户要的是"关掉这个插件"，不是"关掉它的一半"。
   *
   * 一个标记文件同时覆盖两个平面，而且比改两处 YAML 简单：
   *   停用： New-Item  "$env:USERPROFILE\.dsh\composite\disabled"
   *   启用： Remove-Item "$env:USERPROFILE\.dsh\composite\disabled"
   *
   * 探测失败一律当作"启用" —— 绝不因为读不到标记而静默失效。
   */
  isDisabled() {
    try {
      return fs.existsSync(path.join(this.dir, 'disabled'))
    } catch (error) {
      return false
    }
  }

  note(text) {
    this.log.push({ at: Date.now(), text: String(text) })
    if (this.log.length > 200) this.log.shift()
  }
}

/** @type {Shared|null} */
let shared = null

function getShared() {
  const dir = resolveDataDir()
  if (dataDirs.has(dir)) return dataDirs.get(dir)
  shared = new Shared(dir)
  shared.ensureLoaded()
  dataDirs.set(dir, shared)
  return shared
}

/**
 * 拿不到会话身份时的兜底键。
 *
 * 只在 `agents` 服务真的不可用时才会用到 —— 正常路径下每个会话都有自己的键。
 * 之所以要兜底而不是直接返回空：宁可所有会话共用一份状态（退化但可用），
 * 也不能让状态/记忆整块消失。
 */
const FALLBACK_SCOPE = 'dsh|session'

/** agent 对象 → 会话键。用 WeakMap 缓存，保证同一个 agent 永远得到同一个键。 */
const agentKeys = new WeakMap()

/**
 * 会话身份的唯一来源。
 *
 * ## 为什么必须有这一个函数（实测代价换来的）
 *
 * 0.1.0 的接线里，**观察**用的是 `session.id`（真实会话 id），
 * 而**注入**用的是写死的字符串 `'dsh|session'`。两者不是同一个键，
 * 于是：状态机一直在给 `session-xxxx` 记账，注入那行读的却是一个
 * 除了它自己以外没人写的键 —— 那行状态**永远不动**，
 * 而且各会话看到的还是同一份。用户看到的是"状态行不更新"，
 * 根因是键不一致（不是漂移算错，也不是注入没生效）。
 *
 * ## 怎么拿到当前会话（这条在 0.1.5 与 0.2.0 上都成立）
 *
 * 提示词段/上下文的求值发生在 agent 的 driver 链里，而
 * `ctx.agents` 用 AsyncLocalStorage 记着这条链的发起者
 * （`currentInitiator()` / `requireInitiator()`，见
 * `@deepseek-ai/dsh-agent` 的类型定义）。`agent.id` 就是
 * `agent.session.id` —— 与 `session/event` 回调里 `session.id`
 * 是同一个值。这是**已声明的公共 API**，不是猜的字段。
 *
 * @param {object} ctx cordis 上下文
 * @returns {string} 会话键
 */
function currentSessionKey(ctx) {
  try {
    const agents = ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
      ? ctx.get('agents')
      : undefined
    if (agents === undefined || agents === null) return FALLBACK_SCOPE

    let agent
    if (typeof agents.currentInitiator === 'function') agent = agents.currentInitiator()
    else if (typeof agents.requireInitiator === 'function') agent = agents.requireInitiator()
    if (agent === undefined || agent === null) return FALLBACK_SCOPE

    const cached = agentKeys.get(agent)
    if (cached !== undefined) return cached

    const id = agent.id !== undefined && agent.id !== null
      ? String(agent.id)
      : (agent.session !== undefined && agent.session !== null && agent.session.id !== undefined
        ? String(agent.session.id)
        : '')
    if (id.length === 0) return FALLBACK_SCOPE
    try { agentKeys.set(agent, id) } catch (error) { /* 不能缓存也不影响正确性 */ }
    return id
  } catch (error) {
    // 服务已销毁、或不在 initiator 边界内 —— 都退化为共享键，绝不抛
    return FALLBACK_SCOPE
  }
}

// ── 宿主面 ──────────────────────────────────────────────────────────────

/**
 * NapCat 桥。只有配置开启且有 url 时才启动。
 *
 * 入站：事件 → 解析 → 去重 → 顺序 → 映射到 DSH 会话 → 注入
 * 出站：会话产出的正文 → 分段发送（首段零延迟）
 */
function installNapCatBridge(ctx, config) {
  const nap = config !== null && config !== undefined && config.napcat !== undefined ? config.napcat : null
  if (nap === null || nap === undefined || nap.enabled !== true) {
    plog('[composite] NapCat 未启用（配置 napcat.enabled=true 才启动）')
    return
  }

  const s = getShared()
  const http = typeof nap.http === 'string' ? nap.http : 'http://127.0.0.1:3000'
  const token = typeof nap.token === 'string' ? nap.token : ''
  const enabledPeers = Array.isArray(nap.peers) ? nap.peers.map((x) => String(x)) : []
  const allowGroup = nap.allowGroup === true

  const client = new NapCatClient({ http: http, token: token })

  // 出站要用：preset 面的分段发送需要拿到客户端与 peer→会话 的反向映射。
  // 两个平面是同一个模块实例，所以挂在共享对象上是安全的。
  s.napcat = {
    client: client,
    enabled: true,
    /** 由出站接线填充：会话 id → peer */
    reverse: new Map(),
    /** peer → 最近一条入站的解析结果（出站用它决定私聊还是群） */
    peerParsed: new Map(),
  }

  // 自身账号：用于自消息判定兜底
  let selfId = null

  const socket = new OneBotSocket({
    url: typeof nap.ws === 'string' ? nap.ws : http.replace(/^http/, 'ws'),
    token: token,
    tickMs: typeof nap.tickMs === 'number' ? nap.tickMs : 30000,
    onState: (info) => {
      s.note('napcat ' + info.kind)
      if (info.kind === 'connected') {
        client.getLoginInfo().then((info2) => {
          if (info2 !== null && info2 !== undefined && info2.user_id !== undefined) {
            selfId = String(info2.user_id)
          }
        }).catch(() => {})
      }
    },
    onTick: () => {
      // 静默期做一次轻量健康检查；发送链路不测（有副作用）
      client.health(false).then((h) => {
        if (h.ok !== true) s.note('健康检查异常：' + h.why)
      }).catch(() => {})
      return false
    },
    onEvent: (ev) => {
      handleInbound(ctx, s, client, ev, selfId, enabledPeers, allowGroup)
    },
  })

  socket.start()
  ctx.effect(() => () => { socket.stop() }, 'composite:napcat-socket')

  ctx.effect(() => {
    return () => { /* 停时尽力落盘 */ s.persistState() }
  }, 'composite:persist-on-stop')

  plog('[composite] NapCat 桥已启动：' + http + '（群聊' + (allowGroup ? '允许' : '禁止') + '）')
}

/**
 * 一条入站消息的完整处理。
 *
 * 顺序即安全：解析 → 自消息过滤 → 白名单 → 入队分配序号 → 等轮次 → 注入会话。
 */
function handleInbound(ctx, s, client, ev, selfId, enabledPeers, allowGroup) {
  const parsed = parseMessageEvent(ev, selfId)
  const verdict = shouldHandle(parsed)
  if (verdict.ok !== true) return

  if (!allowGroup && parsed.type === 'group') return
  if (enabledPeers.length > 0 && enabledPeers.indexOf(String(parsed.peer)) < 0) return

  const peerKey = String(parsed.peer)

  // 记下最近一条入站：出站要按它决定发给私聊还是群
  if (s.napcat !== undefined && s.napcat !== null && s.napcat.peerParsed !== undefined) {
    s.napcat.peerParsed.set(peerKey, parsed)
  }

  // 限频：超限**丢弃**而不是排队（排队会雪崩）
  const limiter = s.limiterFor(peerKey)
  if (!limiter.allow(Date.now())) {
    s.note('限频丢弃：' + peerKey)
    return
  }

  const queue = s.queueFor(peerKey)
  const { seq, duplicate } = queue.begin(parsed.messageId)
  if (duplicate === true) return

  // 静默窗：把短时间内的多条合成一批（像人连看几条再回）
  const deb = s.debouncerFor(peerKey)
  deb.push({ seq: seq, parsed: parsed }, Date.now())

  const fire = () => {
    if (!deb.ready(Date.now())) {
      const t = setTimeout(fire, 60)
      if (t !== null && typeof t.unref === 'function') t.unref()
      return
    }
    const batch = deb.take()
    if (batch.length === 0) { queue.finish(seq); return }

    const state = s.stateFor(peerKey)
    const silentMin = Math.max(0, (Date.now() - (state.lastUserAt || Date.now())) / 60000)
    const applied = applySignal(state, { kind: 'user-message', silentMin: silentMin, at: Date.now() })
    s.states.set(peerKey, applied)

    const lines = []
    for (let i = 0; i < batch.length; i += 1) lines.push(toPromptText(batch[i].parsed))
    const text = lines.join('\n')

    queue.awaitTurn(seq, 30000).then((mine) => {
      if (mine !== true) return
      deliverToSession(ctx, s, client, peerKey, text, batch[batch.length - 1].parsed).then(() => {
        queue.finish(seq)
      }).catch(() => { queue.finish(seq) })
    }).catch(() => { queue.finish(seq) })
  }
  const timer = setTimeout(fire, 220)
  if (timer !== null && typeof timer.unref === 'function') timer.unref()
}

/**
 * 把消息送进对应的 DSH 会话。
 *
 * peer → 会话 的映射：优先用已绑定的；没有就用 agentLoop 建一个。
 * 会话一旦建立就常驻，后续消息走 `steer` 注入。
 */
async function deliverToSession(ctx, s, client, peerKey, text, parsed) {
  let sessionId = s.sessions.get(peerKey)
  let agent = null

  const agents = ctx.get('agents')
  if (agents !== undefined && sessionId !== undefined) {
    agent = agents.get(sessionId)
  }

  if (agent === null || agent === undefined) {
    const loop = ctx.get('agentLoop')
    const presets = ctx.get('agentPresets')
    if (loop === undefined) {
      s.note('agentLoop 不可用，无法建会话')
      return
    }
    let presetId
    try {
      if (presets !== undefined && typeof presets.resolve === 'function') {
        const p = await presets.resolve('composite')
        presetId = p !== undefined && p !== null ? p.id : undefined
      }
    } catch (error) { presetId = undefined }

    // 新会话需要一个明确的 id（CreateAgentOptions 要求 sessionId）
    const newId = crypto.randomUUID()
    try {
      const handle = await loop.createAgent(ctx, {
        sessionId: newId,
        meta: { origin: 'subagent', isSeeded: false, agentPreset: presetId },
      })
      if (handle !== null && handle !== undefined && handle.agent !== undefined) {
        agent = handle.agent
        sessionId = agent.id
        s.sessions.set(peerKey, sessionId)
        s.presetSessions.add(String(sessionId))
        // 反向映射：出站要按会话找到该发给哪个 peer
        if (s.napcat !== undefined && s.napcat !== null) s.napcat.reverse.set(String(sessionId), peerKey)
      }
    } catch (error) {
      s.note('建会话失败：' + String(error && error.message ? error.message : error))
      return
    }
  }

  if (agent === null || agent === undefined) return

  // 注入：steer 一条 user 角色的消息（OneBot 来的话本来就是用户说的，语义正确）
  try {
    const message = { content: [{ type: 'text', text: text }], source: { kind: 'user' } }
    if (typeof agent.steer === 'function') agent.steer(message)
    s.note('注入会话 ' + String(sessionId) + '：' + text.slice(0, 40))
  } catch (error) {
    s.note('注入失败：' + String(error && error.message ? error.message : error))
  }
}

// ── preset 面 ───────────────────────────────────────────────────────────

/**
 * 人格段 —— 只读，运行期不可改。
 *
 * 这是「稳定人格」与「动态状态」分家的落点：人格在预设里（不可运行期修改），
 * 状态在状态库里（模型只读）。旧的 think_layer 曾把"心情"写进自己的自由文本
 * 状态里，那等于人格的一部分活在模型手里 —— 模型抽风就带走人格。
 */
function installPersona(ctx, config) {
  const text = config !== null && config !== undefined && typeof config.persona === 'string'
    ? config.persona
    : DEFAULT_PERSONA
  if (text.length === 0) return
  // 显式检查而不是直接点属性：若 inject 没生效，静默失败会让"人设不出现"
  // 这种问题极难查（旧实现的教训：插件挂载失败往往是静默的）。
  if (ctx.systemPrompt === undefined || typeof ctx.systemPrompt.section !== 'function') {
    plog('[composite] systemPrompt 不可用，人格段缺席')
    return
  }
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'composite:persona',
    order: PERSONA_ORDER,
    text: text,
  }), 'composite:persona')
}

/** 默认人格（配置里没给就用这个占位，鼓励用户覆盖）。 */
const DEFAULT_PERSONA = [
  '你是「复合体」—— 一个用文字聊天的人，不是一个问答工具。',
  '',
  '说话方式：像普通人在 QQ 上聊天。短句为主，不写小作文，不用列表和标题，',
  '不解释自己在做什么。想到什么说什么，可以分几条发。',
  '',
  '判断依据永远是"记录里真的发生了什么"，不是"听起来应该发生了什么"。',
  '没有把握的事就说没把握，不要为了让回答完整而编造。',
].join('\n')

/**
 * 状态与记忆的动态上下文（图上的「嵌入 → 思考层」+ 内部/外部模拟变量）。
 */
function installContext(ctx, config) {
  const s = getShared()
  if (ctx.systemPrompt === undefined || typeof ctx.systemPrompt.context !== 'function') {
    plog('[composite] systemPrompt 不可用，状态上下文缺席')
    return
  }
  const getScope = () => {
    // 会话作用域：走唯一的身份来源（见 currentSessionKey 的注释）。
    // `config.scopeKey` 仍可强制指定，用于测试与单会话部署。
    if (config !== null && config !== undefined && typeof config.scopeKey === 'string') return config.scopeKey
    return currentSessionKey(ctx)
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'composite:state',
    order: CONTEXT_ORDER,
    text: (assembleContext) => {
      const key = getScope()
      const state = s.stateFor(key)
      const drifted = drift(state, Date.now())
      s.states.set(key, drifted)
      // 采样进环形缓冲：控制台的折线靠它
      try { s.sample(key, drifted) } catch (error) { /* 采样失败不影响注入 */ }

      let memoryText = ''
      try {
        const reader = { platform: 'dsh', peer: key }
        const embedded = s.memory.embed(reader, describeState(drifted), 900)
        memoryText = embedded.text
      } catch (error) { memoryText = '' }

      // L2 的改口：注入**一次**就消费掉，否则会每步重复出现。
      // 它刻意以"记录"口吻出现（见 decide.formatCorrection 的注释）——
      // steer 只能注入 user 角色，第一人称会读成"我刚说我自己被否了"。
      let correction = ''
      try {
        if (s.corrections.has(key)) {
          correction = s.corrections.get(key)
          s.corrections.delete(key)
        }
      } catch (error) { correction = '' }

      void assembleContext
      const base = composeContext(describeState(drifted), memoryText)
      return correction.length > 0 ? (base.length > 0 ? base + '\n\n' + correction : correction) : base
    },
  }), 'composite:state-context')
}

/**
 * 观察：把 DSH 已发生的事实喂给状态机。
 *
 * ⚠️ 这里不用 `agent/turn-stopping` 做主挂点。实测（本机 0.1.5-rc.2）：
 * 它只在 `turnEnds && inbox.nextStep.length === 0` 时触发 —— 也就是
 * **有工具调用的轮次里根本不触发**，而那正是最需要观察的场合。
 * 所以主挂点是 `session/event`（无条件），`turn-stopping` 只作为
 * "能及时否决就否决"的补充。
 */
function installObservation(ctx) {
  const s = getShared()

  ctx.on('session/event', (session, event) => {
    if (event === undefined || event === null) return
    let sessionKey
    try { sessionKey = session !== undefined && session !== null ? String(session.id) : FALLBACK_SCOPE }
    catch (error) { sessionKey = FALLBACK_SCOPE }

    const recorder = s.recorderFor(sessionKey)

    let out
    try { out = recorder.feed(event) } catch (error) { return }

    const state = s.stateFor(sessionKey)
    if (out.signal !== null) {
      const next = applySignal(state, out.signal)
      s.states.set(sessionKey, next)
    }

    // 用户消息：记下时长基准（状态回升已在 NapCat 侧做，这里补 DSH 侧的）
    if (event.type === 'user/message') {
      const silentMin = Math.max(0, (Date.now() - (state.lastUserAt || Date.now())) / 60000)
      const next = applySignal(s.stateFor(sessionKey), { kind: 'user-message', silentMin: silentMin, at: Date.now() })
      s.states.set(sessionKey, next)
    }

    // 本轮结束：完整记录交给 L1 判定，值得则排队给 L2
    if (event.type === 'turn/end' && out.snapshot !== undefined) {
      s.note('turn 结束 steps=' + out.snapshot.steps + ' err=' + out.snapshot.toolErrorCount)
      s.persistState()
    }
  })

  ctx.on('agent/inbox/inserted', () => { /* 被动心跳：只观察，不拦截 */ })
}

/**
 * 记忆工具（preset 面）。模型主动调用的两个入口。
 *
 * 注意：**工具注册失败不影响其余功能** —— 用动态 import 拿 defineTool，
 * 拿不到就整块跳过。
 */
async function installMemoryTools(ctx, config) {
  let defineTool
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    defineTool = mod.defineTool
  } catch (error) {
    plog('[composite] 未能加载 dsh-tools，记忆工具缺席（其余功能不受影响）')
    return
  }
  if (typeof defineTool !== 'function') return

  const tools = ctx.get('tools')
  if (tools === undefined) return

  const s = getShared()
  // 工具的 execute 跑在 agent 的 driver 链里，所以**调用时**能拿到确切会话 ——
  // 不要在装配时就把键定死（那会让所有会话共用一个记忆命名空间）。
  const scopeKeyOf = (args) => {
    void args
    if (config !== null && config !== undefined && typeof config.scopeKey === 'string') return config.scopeKey
    return currentSessionKey(ctx)
  }

  // 工具定义的两个形状要点（照抄本机**能工作**的包，不猜）：
  //   1. `parameters` 是「参数名 → 描述符」的映射，**不是** JSON Schema
  //      （不要写 type:'object' / properties / required 数组）
  //   2. `output.render` **必须有** —— 漏了会在注册期抛
  //      `Cannot read properties of undefined (reading 'render')`，
  //      结果是工具整个消失（实测踩过）
  const textOut = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }

  try {
    const save = defineTool({
      name: 'memory_save',
      description: '记下值得长期记住的事（关于对方的偏好、约定、身份等）。只在确实值得记时调用。',
      parameters: {
        text: { type: 'string', description: '要记住的内容，一句话说清', required: true },
        kind: { type: 'string', description: '类型：fact / moment' },
      },
      output: textOut,
      async execute(args) {
        const res = s.memory.write({
          text: args !== null && args !== undefined ? args.text : '',
          kind: args !== null && args !== undefined && typeof args.kind === 'string' ? args.kind : 'fact',
          scope: { platform: 'dsh', peer: scopeKeyOf(args) },
          source: 'tool',
        })
        if (res.added !== true) return '没有新增（' + String(res.reason) + '）'
        appendJsonl(s.memoryFile, res.record)
        return '记住了'
      },
    })
    ctx.effect(() => tools.register(save), 'composite:tool-memory-save')
  } catch (error) {
    plog('[composite] memory_save 注册失败：' + String(error && error.message ? error.message : error))
  }

  try {
    const recall = defineTool({
      name: 'memory_recall',
      description: '按关键词回忆以前记下的事。想知道"他以前说过什么"时调用。',
      parameters: {
        query: { type: 'string', description: '要回忆的关键词', required: true },
      },
      output: textOut,
      async execute(args) {
        const q = args !== null && args !== undefined && typeof args.query === 'string' ? args.query : ''
        const hits = s.memory.recall({ platform: 'dsh', peer: scopeKeyOf(args) }, q, 5)
        if (hits.length === 0) return '没想起来相关的。'
        const lines = []
        for (let i = 0; i < hits.length; i += 1) lines.push('- ' + hits[i].text)
        return lines.join('\n')
      },
    })
    ctx.effect(() => tools.register(recall), 'composite:tool-memory-recall')
  } catch (error) {
    plog('[composite] memory_recall 注册失败：' + String(error && error.message ? error.message : error))
  }

  // ── 心跳节奏：她引导自己的心跳 ─────────────────────────────────────────
  //
  // 没有这个工具，她只能"被允许开口"，不能**自己安排下一次**。
  // 原实现就有这条（brain.py 的 `_parse_wait`：只在模型自己没给节奏时才用兜底值）。
  try {
    const waitTool = defineTool({
      name: 'heartbeat_wait',
      description: '决定下一次"没人说话时她可能主动开口"的评估在多久之后。'
        + '给秒数就是"这么久之后再想一次"；给 0 表示"别叫我"，直到对方再说话为止。'
        + '不用每次都用 —— 不给就用默认间隔。',
      parameters: {
        seconds: { type: 'number', description: '多少秒之后再评估；0 = 别叫我', required: true },
      },
      output: textOut,
      async execute(args) {
        const raw = args !== null && args !== undefined ? args.seconds : undefined
        const parsed = parseWait(raw)
        if (parsed === null) return '没听懂这个节奏，保持默认。'
        // 归属优先用**当前会话**（工具执行时能确切拿到），
        // 再退到"最近一次主动开口的会话"，最后才是共享键。
        const here = currentSessionKey(ctx)
        const target = here !== FALLBACK_SCOPE
          ? here
          : (s.lastProactiveSession !== null && s.lastProactiveSession !== undefined
            ? String(s.lastProactiveSession)
            : FALLBACK_SCOPE)
        s.selfWake.set(target, {
          kind: parsed.kind,
          seconds: parsed.kind === 'wait' ? parsed.seconds : undefined,
          at: Date.now(),
        })
        if (parsed.kind === 'never') return '好，不叫你了 —— 等对方再说话我才会重新考虑。'
        return '好，' + parsed.seconds + ' 秒之后再想。'
      },
    })
    ctx.effect(() => tools.register(waitTool), 'composite:tool-heartbeat-wait')
  } catch (error) {
    plog('[composite] heartbeat_wait 注册失败：' + String(error && error.message ? error.message : error))
  }
}

/**
 * L2：异步复核。
 *
 * ## 为什么异步（延迟的关键取舍）
 *
 * 挡在发送前就是每轮多 300~800ms。改成发出后复核、下一轮改口 ——
 * 用户感知延迟 +0，而且**更拟人**：人也是说完才反应过来刚才那句不对。
 *
 * ## 为什么必须是独立的一次模型调用
 *
 * 旧实现证过：把判断塞进思考层输出的一个字段，决策层三次全放行，
 * **干预变成死代码**。所以这里单独发一次请求，走小 `maxTokens`、极短输入。
 *
 * 任何失败一律放行 —— 绝不因复核坏掉就不让她说话。
 */
async function reviewWithModel(ctx, session, prompt) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') return null

  let route
  try {
    route = session !== undefined && session !== null && typeof session.requestContext === 'function'
      ? session.requestContext()
      : undefined
  } catch (error) { route = undefined }
  if (route === undefined || route === null || typeof route.provider !== 'string') return null

  const text = [
    '你是一个复核者。只判断"她说的话"与"本轮真实发生过的事"是否相符。',
    '只有"她声称某事已做完、但记录里没有成功的写入类调用"才算要否决。',
    '拿不准就放行。第一行只写 PASS 或 VETO；若否决，第二行起写具体改正方向。',
    '',
    prompt,
  ].join('\n')

  try {
    const chunks = llm.stream({
      provider: route.provider,
      model: route.model,
      system: '你是严格的复核者，只按记录判断，不做风格评价。',
      messages: [{
        id: 'composite-review',
        role: 'user',
        content: [{ type: 'text', text: text }],
        source: { kind: 'plugin', plugin: 'composite', form: 'instructions' },
      }],
      maxTokens: 300,
    })
    let out = ''
    for await (const chunk of chunks) {
      if (chunk !== null && chunk !== undefined) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
        if (chunk.type === 'finish') break
      }
    }
    return parseVerdict(out)
  } catch (error) {
    return null // 任何失败一律放行
  }
}

/**
 * 决策层：L1 同步 + L2 异步。
 */
function installDecision(ctx, config) {
  const s = getShared()
  const quota = new VetoQuota()

  ctx.on('agent/turn-stopping', async (payload) => {
    let sessionKey = 'dsh|session'
    let agent = null
    try {
      agent = payload !== undefined && payload !== null ? payload.agent : undefined
      if (agent !== undefined && agent !== null) sessionKey = String(agent.id)
    } catch (error) { sessionKey = 'dsh|session' }

    const recorder = s.recorders.get(sessionKey)
    if (recorder === undefined) return

    // 取本轮最后一条助手正文
    let reply = ''
    let session = null
    try {
      session = agent !== undefined && agent !== null ? agent.session : undefined
      if (session !== undefined && session !== null && typeof session.snapshotEvents === 'function') {
        const events = session.snapshotEvents()
        for (let i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].type === 'assistant/message') { reply = assistantText(events[i].data); break }
        }
      }
    } catch (error) { reply = '' }

    const snapshot = recorder.snapshot()
    const result = lint(reply, snapshot)
    const stateText = describeState(s.stateFor(sessionKey))

    if (result.block === true) {
      // L1 命中：记一笔（出站那边已经据此改成单条发送）
      s.note('L1 判定：' + result.reasons.join(',') + ' → ' + sendStrategy(result))
    }

    // L2：只在值得时才花这次调用（不是每轮都跑）
    if (!shouldReview(result, reply.length)) return
    if (!quota.canVeto()) return

    const input = reviewInput(reply, snapshot, stateText)
    const prompt = buildPrompt(input)

    // **异步**：不 await，不挡边界提交
    reviewWithModel(ctx, session, prompt).then((verdict) => {
      if (verdict === null || verdict === undefined) return
      appendJsonl(s.pendingFile, { at: Date.now(), session: sessionKey, verdict: verdict.verdict, reason: verdict.reason })
      if (verdict.verdict !== 'veto') return
      const correction = formatCorrection(verdict.reason)
      if (correction.length === 0) return
      quota.consume()
      s.corrections.set(sessionKey, correction)
      s.note('L2 否决：' + verdict.reason.slice(0, 60) + '（下一轮改口）')
    }).catch(() => { /* 任何失败一律放行 */ })
  })

  // 新一轮清零配额
  ctx.on('session/event', (session, event) => {
    if (event !== undefined && event !== null && event.type === 'turn/start') quota.reset()
  })
}

/**
 * 出站：实时分段发送 —— 这是「拟人」与「延迟」两条线交汇的地方。
 *
 * ## 两次发送
 *
 *   首句写完（1~2s）──► 立刻发第一段        ← 感知延迟由它决定
 *   全文写完（3~8s）──► 余下各段按对数间隔   ← 像人一样分几条
 *
 * `Segmenter.pull()` 已经保证首段 `delayMs === 0` 且互斥标记可用；
 * 这里只负责"什么时候拉"与"按不按间隔等"。
 *
 * ## 为什么 L1 必须在**发出首段之前**评估
 *
 * 首段一旦发出去就无法收回。所以命中 L1（如"工具失败却声称完成"）
 * 时必须**在还没发任何段的时候就切成单条模式**：继续累积，
 * 等全文结束再一次性发出。这样爆炸半径收在一条消息里，
 * 也给 L2 留出下一轮纠正的空间。
 *
 * L1 可以增量评估 —— 它的判据是"有没有完成断言"（文本）+ "有没有写入证据"
 * （本轮记录），两者都不需要等全文。
 */
function installOutbound(ctx) {
  const s = getShared()
  /** 会话 id → { seg, chain, mode } */
  const streams = new Map()
  /** 每个会话的发送串行链，保证段序 */
  const chains = new Map()

  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    if (t !== null && typeof t.unref === 'function') t.unref()
  })

  function chainFor(sessionId) {
    if (!chains.has(sessionId)) chains.set(sessionId, Promise.resolve())
    return chains.get(sessionId)
  }

  function enqueue(sessionId, task) {
    const next = chainFor(sessionId).then(task).catch(() => {})
    chains.set(sessionId, next)
    return next
  }

  async function sendText(client, peer, parsed, text) {
    if (typeof text !== 'string' || text.trim().length === 0) return
    const target = sendTarget(parsed)
    const params = { messageType: target.params.message_type }
    if (target.params.group_id !== undefined) params.groupId = target.params.group_id
    if (target.params.user_id !== undefined) params.userId = target.params.user_id
    try {
      // 发送**非 soft**：message_id 是唯一可信的送达凭证
      await client.sendMsg([{ type: 'text', data: { text: text } }], params)
    } catch (error) {
      s.note('出站失败：' + String(error && error.message ? error.message : error))
    }
  }

  /** 拉取并发送一批待发段（按 Segmenter 给的间隔）。 */
  function pump(sessionId, peer, parsed, client) {
    const st = streams.get(sessionId)
    if (st === undefined) return
    if (st.mode === 'single') return // 单条模式：攒着，等结束一次性发
    for (;;) {
      const seg = st.seg.pull()
      if (seg === null) break
      enqueue(sessionId, async () => {
        if (seg.delayMs > 0) await sleep(seg.delayMs)
        await sendText(client, peer, parsed, seg.text)
      })
    }
  }

  /** 生成结束：把残余发出去；单条模式则一次性发全文。 */
  function finishStream(sessionId, peer, parsed, client) {
    const st = streams.get(sessionId)
    if (st === undefined) return
    st.seg.finish()

    if (st.mode === 'single') {
      const full = st.seg.sentTexts.join('') + st.seg.buffer
      st.seg.buffer = ''
      enqueue(sessionId, async () => { await sendText(client, peer, parsed, full) })
      return
    }

    const rest = st.seg.drain()
    for (let i = 0; i < rest.length; i += 1) {
      const seg = rest[i]
      enqueue(sessionId, async () => {
        if (seg.delayMs > 0) await sleep(seg.delayMs)
        await sendText(client, peer, parsed, seg.text)
      })
    }
  }

  ctx.on('agent/assistant-stream', (payload) => {
    const nap = s.napcat
    if (nap === undefined || nap === null || nap.enabled !== true) return
    if (payload === undefined || payload === null) return

    let sessionId
    try { sessionId = String(payload.agent.id) } catch (error) { return }
    const peer = nap.reverse.get(sessionId)
    if (peer === undefined) return // 不是 QQ 绑定的会话 → 不发到 QQ

    const parsed = nap.peerParsed !== undefined ? nap.peerParsed.get(peer) : undefined
    const frame = payload.frame
    if (frame === undefined || frame === null) return

    if (frame.type === 'start') {
      streams.set(sessionId, { seg: new Segmenter(), mode: 'segmented' })
      // "正在输入" —— 不省延迟但改感知：用户看到她在打字，而模型还在生成
      try { nap.client.setInputStatus(peer) } catch (error) { /* 装饰性，失败无所谓 */ }
      return
    }

    if (frame.type === 'end') {
      finishStream(sessionId, peer, parsed, nap.client)
      return
    }

    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk === undefined || chunk === null || chunk.type !== 'text-delta') return
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    if (text.length === 0) return

    const st = streams.get(sessionId)
    if (st === undefined) return
    st.seg.push(text)

    // 增量 L1：还没发过任何段时才有机会改道（发出去了就收不回）
    if (st.mode === 'segmented' && st.seg.anySent() === false) {
      const recorder = s.recorders.get(sessionId)
      const snapshot = recorder !== undefined ? recorder.snapshot() : { tools: [], toolErrorCount: 0 }
      const partial = st.seg.sentTexts.join('') + st.seg.buffer
      let verdict = null
      try { verdict = lint(partial, snapshot) } catch (error) { verdict = null }
      if (verdict !== null && verdict.block === true) {
        st.mode = 'single'
        s.note('L1 命中（' + verdict.reasons.join(',') + '）→ 改单条发送')
      }
    }

    pump(sessionId, peer, parsed, nap.client)
  })
}

/**
 * 状态 → 生成参数（图上的「内部模拟变量 → 思考模型」）。
 *
 * 挂在 `agent/request` 这个 waterfall 上：它替换冻结的调用配置。
 * 状态差（累/没耐心）就把 `maxTokens` 压低 —— 这既是拟人（累了惜字），
 * 也是**真实的延迟收益**：回得短就生成得快。
 */
function installGenerationBias(ctx) {
  const s = getShared()
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    try {
      let sessionKey = 'dsh|session'
      const agent = payload !== undefined && payload !== null ? payload.agent : undefined
      if (agent !== undefined && agent !== null) sessionKey = String(agent.id)

      const state = s.stateFor(sessionKey)
      const drifted = drift(state, Date.now())
      s.states.set(sessionKey, drifted)
      const bias = generationBias(drifted)

      // 只收紧、不放松：不让"状态好"把上限调得比用户/部署配的更高
      const base = config !== null && config !== undefined && typeof config.maxTokens === 'number'
        ? config.maxTokens
        : bias.maxTokens
      const capped = Math.min(base, bias.maxTokens)

      return Object.assign({}, config, {
        maxTokens: capped,
        temperature: typeof config.temperature === 'number' ? config.temperature : bias.temperature,
      })
    } catch (error) {
      return config
    }
  })
}

/**
 * 主动心跳 —— 「主动心跳 → 思考模型」那条线。
 *
 * ## 三段分离（防刷屏的根本）
 *
 *   触发（timer）    → 只调 evaluate()，**不调模型**
 *   决策（纯逻辑）    → 读状态 + 计数器 + 时段，输出 allow/deny
 *   内容（仅 allow）  → 这一次才 steer 起一轮
 *
 * 定时器**绝不直接调模型**，也绝不"评估了就发" —— 那会退化成
 * "定时发消息"，是刷屏与自我循环的经典成因。
 *
 * ## 只对挂载了本预设的会话生效
 *
 * 按 `session.header.agentPreset === 'composite'` 过滤，
 * 不去打扰别的预设的会话。
 *
 * ## 每会话独立计数
 *
 * 冷却、每日预算、上次主动时刻都按会话分开 —— 否则一个话痨会话
 * 会把别的会话的预算吃光。
 */
function installHeartbeat(ctx, config) {
  const hb = config !== null && config !== undefined && config.heartbeat !== undefined ? config.heartbeat : null
  if (hb === null || hb === undefined || hb.enabled !== true) {
    plog('[composite] 主动心跳未启用（配置 heartbeat.enabled=true 才启动）')
    return
  }

  const timer = ctx.get('timer')
  if (timer === undefined || timer === null || typeof timer.interval !== 'function') {
    plog('[composite] timer 服务不可用，主动心跳缺席（其余功能不受影响）')
    return
  }

  const s = getShared()
  const policy = Object.assign({}, hb)
  const file = path.join(s.dir, 'heartbeat.json')

  /** 每会话：{ lastProactiveAt, counter, nextEvalAt } */
  const perSession = new Map()
  const raw = readJsonSafe(file, {})
  if (raw !== null && typeof raw === 'object') {
    for (const key of Object.keys(raw)) {
      const v = raw[key]
      if (v === null || v === undefined || typeof v !== 'object') continue
      const counter = new DailyCounter()
      counter.restore(v.day, v.count)
      perSession.set(key, {
        lastProactiveAt: typeof v.lastProactiveAt === 'number' ? v.lastProactiveAt : 0,
        counter: counter,
        nextEvalAt: typeof v.nextEvalAt === 'number' ? v.nextEvalAt : 0,
      })
    }
  }

  function entryFor(key) {
    if (!perSession.has(key)) {
      perSession.set(key, { lastProactiveAt: 0, counter: new DailyCounter(), nextEvalAt: 0 })
    }
    return perSession.get(key)
  }

  function persist() {
    const out = {}
    for (const [key, v] of perSession.entries()) {
      const snap = v.counter.snapshot()
      const wake = s.selfWake.get(key)
      out[key] = {
        lastProactiveAt: v.lastProactiveAt,
        nextEvalAt: v.nextEvalAt,
        day: snap.day,
        count: snap.count,
        selfWake: wake === undefined ? null : wake,
      }
    }
    writeJsonAtomic(file, out)
  }

  /**
   * 每个 tick 都跑，但**每个会话各自过闸**。
   *
   * ## 为什么定时器要"高频 tick + 每会话过闸"，而不是"低频 tick"
   *
   * 第一版让定时器每 `intervalMs`（3 分钟）响一次。后果是实测出来的：
   * 用户说"15 秒后跟我说话"，她调 `heartbeat_wait({seconds:15})` 排在 15 秒后，
   * 但**定时器要等最多 3 分钟才响** —— 她排的时机永远不可能比定时器更细。
   *
   * 所以改成：定时器高频（默认 10 秒）响，**每个会话维护一个 `nextEvalAt`**
   * （持久化，评估后推后 `intervalMs`）。这样：
   *   · 默认节奏仍由 `intervalMs` 决定（不会被高频 tick 打扰）
   *   · 她排的 15 秒能真的在 ~10~20 秒内生效
   *
   * 注意 `nextEvalAt` 必须是**持久状态**。早期那版每次 tick 都用
   * `now + intervalMs` 现算，于是 `now < now + interval` 恒真、心跳永不触发。
   */
  function tick() {
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null || typeof agents.list !== 'function') return
    let list
    try { list = agents.list() } catch (error) { return }
    if (!Array.isArray(list)) {
      try {
        const arr = []
        for (const a of list) arr.push(a)
        list = arr
      } catch (error) { return }
    }

    const now = Date.now()
    const defaultInterval = typeof policy.intervalMs === 'number' && policy.intervalMs > 0
      ? policy.intervalMs
      : 600000

    for (let i = 0; i < list.length; i += 1) {
      const agent = list[i]
      let presetId
      let sessionKey
      let busy = false
      try {
        presetId = agent.session !== undefined && agent.session !== null
          ? agent.session.header.agentPreset
          : undefined
        sessionKey = String(agent.id)
        busy = agent.status === 'running'
      } catch (error) { continue }
      if (presetId !== 'composite') continue

      const state = s.stateFor(sessionKey)
      const entry = entryFor(sessionKey)

      // 状态定期打到宿主控制台。
      //
      // 为什么要有这个：`systemPrompt.context` 在 GUI 里被渲染成**折叠的
      // 「上下文注入」卡片**，用户不展开就看不到值（实测反馈"状态还是没有"）。
      // 控制台日志是唯一"不用点开就能看见"的地方，所以这里每会话每分钟打一行。
      if (now - (entry.lastLogAt === undefined ? 0 : entry.lastLogAt) >= 60000) {
        entry.lastLogAt = now
        plog('[composite] 状态 ' + sessionKey.slice(0, 20) + ' ' + describeState(state)
          + (busy ? '（正在说话）' : ''))
      }

      // 她排的时机到了没有？到了就是"被明确要求的"，
      // 那两道给自主开口用的闸（用户刚说过话 / 概率）必须让路。
      const selfWake = s.selfWake.get(sessionKey) === undefined ? null : s.selfWake.get(sessionKey)
      const wake = resolveNextWake({
        now: now,
        lastUserAt: typeof state.lastUserAt === 'number' ? state.lastUserAt : 0,
        selfWake: selfWake,
      })
      const explicitWake = selfWake !== null && wake.nextAt !== null && now >= wake.nextAt

      // 过闸：默认节奏由 nextEvalAt 控制
      if (!explicitWake && now < entry.nextEvalAt) continue
      if (explicitWake && Number.isFinite(wake.nextAt) === false) continue

      // 无论放行与否，都把下一次评估推后一个默认间隔（避免高频 tick 变成高频打扰）
      entry.nextEvalAt = now + defaultInterval
      if (selfWake !== null) s.selfWake.delete(sessionKey)
      persist()

      const verdict = evaluate({
        state: state,
        now: now,
        lastUserAt: typeof state.lastUserAt === 'number' ? state.lastUserAt : 0,
        lastProactiveAt: entry.lastProactiveAt,
        todayCount: entry.counter.today(now),
        busy: busy,
        // 她排的时机到了 → 让过那两道给"自主开口"用的闸
        explicitWake: explicitWake,
        policy: policy,
      })
      if (verdict.allow !== true) continue

      entry.counter.bump(now)
      entry.lastProactiveAt = now
      s.lastProactiveSession = sessionKey
      persist()
      s.note('主动心跳：向 ' + sessionKey + ' 起一轮（' + wake.source + '）')

      try {
        if (typeof agent.steer === 'function') {
          agent.steer({
            content: [{ type: 'text', text: proactiveHint(describeState(state)) }],
            source: { kind: 'plugin', plugin: 'composite', form: 'instructions' },
          })
        }
      } catch (error) {
        s.note('主动心跳 steer 失败：' + String(error && error.message ? error.message : error))
      }
    }
  }

  // 定时器**高频**响（默认 10 秒），默认节奏交给每会话的 nextEvalAt。
  // 这样她自己排的短时机（如 15 秒）才有意义 —— 低频定时器会让它永远失效。
  const tickMs = typeof policy.tickMs === 'number' && policy.tickMs > 0 ? policy.tickMs : 10000
  const intervalMs = typeof policy.intervalMs === 'number' && policy.intervalMs > 0 ? policy.intervalMs : 600000
  ctx.effect(() => timer.interval(tick, tickMs), 'composite:heartbeat')
  ctx.effect(() => () => persist(), 'composite:heartbeat-persist')

  plog('[composite] 主动心跳已启动（每 ' + Math.round(tickMs / 1000) + ' 秒查一次，'
    + '默认 ' + Math.round(intervalMs / 60000) + ' 分钟评估一次，'
    + '每日上限 ' + policy.dailyBudget + '，概率 ' + policy.probability + '）')
}

/**
 * 状态控制台 —— 挂在 DSH 自己的 web 层上。
 *
 * ## 为什么不做成 Client 插件
 *
 * DSH 的 client 半侧必须符合 `window.__ModuleLoader__.load({id, factory})`
 * 契约（预打包产物）。手写一个不符合契约的 client 会让**整个 profile 起不来**
 * （client-modules 在启动期抛 ClientPackageCompositionError）。
 * 而宿主侧的 `webServer.register` 是已核实、低风险的路径 ——
 * 浏览器插件（BrowserSkill）用的就是它。
 *
 * 代价：它是一个独立页面（需要开个标签），不是 GUI 里常驻的一条栏。
 * 换来的是：装完即用、坏不了 profile、而且能画折线。
 *
 * 地址：`http://127.0.0.1:<port>/composite/status`
 *
 * ## 响应契约（别改错）
 *
 * handler 是 **node:http 的 `(req, res)`**，自己 writeHead + end。
 * 返回 Fetch 的 `Response` 对象没人接，请求会**一直挂到超时**
 * —— 不是 404，所以看起来像路由没注册。详见 {@link sendBytes}。
 */
/**
 * 交回一个响应 —— **node:http 风格**，不是 Fetch 风格。
 *
 * ⚠️ 这里踩过一个极贵的坑，写下来免得再犯：
 * `webServer.register` 的 handler 签名是 `(req, res)`，由 handler
 * **自己 hold 住整个响应生命周期**（`dsh-host-webserver` 里就是
 * `await route.handler(req, res)`，之后什么都不做）。
 *
 * 早先写成 `return new Response(...)` —— 返回值没有人接，`res` 永远不 end，
 * 于是 socket 一直挂着。表现是**请求超时**、不是 404，
 * 看起来特别像"路由压根没注册上"，极易误诊成注册失败。
 * 实测证据：日志明明打了「状态控制台已挂：/composite/status」，
 * 但 `Invoke-WebRequest` 一路超时。
 *
 * 结论：handler 必须自己 `res.writeHead(...)` + `res.end(...)`。
 */
function sendBytes(res, status, contentType, body) {
  const buf = Buffer.from(body, 'utf8')
  try {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': String(buf.length),
      'cache-control': 'no-store',
    })
    res.end(buf)
  } catch (error) {
    plog('[composite] 控制台响应失败：' + (error && error.message ? error.message : String(error)))
  }
}

function installConsole(ctx, config) {
  const s = getShared()

  const register = (scoped) => {
    if (scoped === undefined || scoped === null) return
    const webServer = scoped.webServer !== undefined ? scoped.webServer : scoped.get('webServer')
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
      plog('[composite] 没有 webServer 服务，控制台页面缺席（桌面端通常如此）')
      return
    }
    scoped.effect(() => webServer.register({
      kind: 'prefix',
      path: '/composite',
      handler: (req, res) => {
        let pathname = '/composite'
        try {
          pathname = new URL(req.url === undefined ? '/composite' : req.url, 'http://127.0.0.1').pathname
        } catch (error) { pathname = '/composite' }

        if (pathname === '/composite/state.json' || pathname === '/composite/state') {
          sendBytes(res, 200, 'application/json; charset=utf-8', JSON.stringify(buildSnapshot(s), null, 1))
          return
        }
        if (pathname === '/composite/status' || pathname === '/composite' || pathname === '/composite/') {
          sendBytes(res, 200, 'text/html; charset=utf-8', renderConsole())
          return
        }
        sendBytes(res, 404, 'text/plain; charset=utf-8', 'not found')
      },
    }), 'composite:console')
    plog('[composite] 状态控制台已挂：/composite/status')
  }

  // 优先用 inject（服务可能还没就绪），没有 inject 就退回直接取
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], register)
  } else {
    register(ctx)
  }

  void config
}

/** 组装控制台读的纯数据快照（不含任何 live 对象）。 */
function buildSnapshot(s) {
  const sessions = []
  for (const [key, state] of s.states.entries()) {
    const ring = s.history.get(key)
    sessions.push({
      key: key,
      state: {
        mood: round2(state.mood),
        energy: round2(state.energy),
        patience: round2(state.patience),
        focus: round2(state.focus),
        unanswered: state.unanswered,
        burst: state.burst,
        at: state.at,
        lastUserAt: state.lastUserAt,
        lastSpeakAt: state.lastSpeakAt,
      },
      history: Array.isArray(ring) ? ring.map((p) => ({
        at: p.at, mood: round2(p.mood), energy: round2(p.energy),
        patience: round2(p.patience), focus: round2(p.focus),
      })) : [],
    })
  }
  sessions.sort((a, b) => (b.state.at || 0) - (a.state.at || 0))

  const hb = readJsonSafe(path.join(s.dir, 'heartbeat.json'), {})
  return {
    now: Date.now(),
    dataDir: s.dir,
    sessions: sessions,
    heartbeat: hb === null || typeof hb !== 'object' ? {} : hb,
    decisions: s.decisions.slice(-40),
    memoryCount: s.memory.records.length,
    log: s.log.slice(-40),
    napcat: s.napcat === undefined || s.napcat === null
      ? { enabled: false }
      : { enabled: true, peers: s.napcat.reverse.size },
  }
}

function round2(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : null
}

/** 自包含的控制台页面（无外部依赖，2 秒轮询）。 */
function renderConsole() {
  return [
    '<!doctype html><html lang="zh"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>复合体 · 状态控制台</title><style>',
    ':root{--bg:#0f1117;--fg:#e6e6e6;--dim:#8b93a1;--card:#171a21;--line:#252a33;--a:#6ea8fe;--b:#7ee787;--c:#ffa657;--d:#d2a8ff}',
    '*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:13px/1.5 ui-monospace,Menlo,Consolas,monospace}',
    'h1{font-size:15px;margin:0 0 12px;font-weight:600}h2{font-size:13px;margin:18px 0 8px;color:var(--dim);font-weight:600}',
    '.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(340px,1fr))}',
    '.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px}',
    '.k{color:var(--dim);font-size:11px;word-break:break-all}',
    '.row{display:flex;justify-content:space-between;margin:4px 0}',
    '.v{font-weight:600}.u{color:var(--dim);font-size:11px}',
    '.bar{height:6px;background:#222833;border-radius:3px;overflow:hidden;margin-top:2px}',
    '.bar>i{display:block;height:100%}',
    'svg{display:block;width:100%;height:56px;margin-top:8px}',
    '.log{max-height:220px;overflow:auto;background:#12151c;border:1px solid var(--line);border-radius:6px;padding:8px}',
    '.log div{white-space:pre-wrap;word-break:break-word;color:#c9d1d9}',
    '.muted{color:var(--dim)}.pill{display:inline-block;padding:1px 6px;border:1px solid var(--line);border-radius:999px;font-size:11px}',
    '</style></head><body>',
    '<h1>复合体 · 状态控制台 <span class="muted" id="t"></span></h1>',
    '<div id="app" class="grid"></div>',
    '<h2>决定与事件</h2><div class="log" id="log"></div>',
    '<h2>原始数据</h2><div class="u"><a style="color:var(--a)" href="/composite/state.json">/composite/state.json</a></div>',
    '<script>',
    'function esc(s){return String(s).replace(/[&<>]/g,function(c){return c==="&"?"&amp;":c==="<"?"&lt;":"&gt;"})}',
    // 折线：把一串数值画成一条 SVG path（viewBox 0..100 x 0..40）
    'function spark(points,key,color){',
    ' if(!points||points.length<2)return "<div class=u>采样不足</div>";',
    ' var vals=points.map(function(p){return p[key]});',
    ' var lo=Math.min.apply(null,vals),hi=Math.max.apply(null,vals);',
    ' if(hi-lo<0.01){hi=lo+1}',
    ' var d=vals.map(function(v,i){var x=i*100/(vals.length-1);var y=36-((v-lo)/(hi-lo))*30;return (i?"L":"M")+x.toFixed(1)+" "+y.toFixed(1)}).join(" ");',
    ' return "<svg viewBox=\\"0 0 100 40\\" preserveAspectRatio=\\"none\\"><path d=\\""+d+"\\" fill=\\"none\\" stroke=\\""+color+"\\" stroke-width=\\"1.5\\" vector-effect=\\"non-scaling-stroke\\"/></svg>"}',
    'function bar(v,color){var pct=Math.max(0,Math.min(100,(v/10)*100));return "<div class=bar><i style=\\"width:"+pct+"%;background:"+color+"\\"></i></div>"}',
    'function ago(t){if(!t)return "—";var s=Math.floor((Date.now()-t)/1000);if(s<60)return s+" 秒前";if(s<3600)return Math.floor(s/60)+" 分钟前";return Math.floor(s/3600)+" 小时前"}',
    'async function tick(){',
    ' try{var r=await fetch("/composite/state.json",{cache:"no-store"});var d=await r.json();',
    '  document.getElementById("t").textContent="· "+new Date(d.now).toLocaleTimeString();',
    '  var app=document.getElementById("app");var h="";',
    '  if(!d.sessions.length){h="<div class=card>还没有任何会话状态。<br><span class=u>插件挂在宿主面，随便开一个会话聊一句就会有数据。</span></div>"}',
    '  d.sessions.forEach(function(s){var st=s.state;',
    '   h+="<div class=card><div class=k>"+esc(s.key)+"</div>";',
    '   h+="<div class=row><span>心情</span><span class=v>"+st.mood+"/10</span></div>"+bar(st.mood,"var(--a)");',
    '   h+="<div class=row><span>精力</span><span class=v>"+st.energy+"/10</span></div>"+bar(st.energy,"var(--b)");',
    '   h+="<div class=row><span>耐心</span><span class=v>"+st.patience+"/10</span></div>"+bar(st.patience,"var(--c)");',
    '   h+="<div class=row><span>专注</span><span class=v>"+st.focus+"/10</span></div>"+bar(st.focus,"var(--d)");',
    '   if(st.unanswered>0){h+="<div class=row><span class=u>连发没回音</span><span class=v>"+st.unanswered+"</span></div>"}',
    '   h+=spark(s.history,"patience","#ffa657");',
    '   h+="<div class=u>上次用户 "+ago(st.lastUserAt)+" · 上次她说话 "+ago(st.lastSpeakAt)+"</div></div>"});',
    '  app.innerHTML=h;',
    '  var hb=d.heartbeat||{};var keys=Object.keys(hb);',
    '  var lh="<div>主动心跳："+(keys.length?keys.map(function(k){var v=hb[k];return esc(k.slice(0,18))+" 上次 "+ago(v.lastProactiveAt)+" 今日 "+(v.count||0)+" 次"}).join("<br>"):"<span class=muted>还没有主动开口记录</span>")+"</div>";',
    '  lh+="<div class=muted>记忆 " + d.memoryCount + " 条 · NapCat " + (d.napcat&&d.napcat.enabled?"已启用":"未启用") + "</div>";',
    '  var dl=(d.decisions||[]).slice().reverse().map(function(x){return "<div>"+new Date(x.at).toLocaleTimeString()+"  "+esc(x.text)+"</div>"}).join("");',
    '  var lg=(d.log||[]).slice().reverse().map(function(x){return "<div>"+new Date(x.at).toLocaleTimeString()+"  "+esc(x.text)+"</div>"}).join("");',
    '  document.getElementById("log").innerHTML=lh+"<hr style=\\"border-color:#252a33\\">"+dl+lg;',
    ' }catch(e){document.getElementById("t").textContent="· 读取失败 "+e}',
    '}',
    'tick();setInterval(tick,2000);',
    '</script></body></html>',
  ].join('\n')
}

/**
 * 插件日志：**同时**写控制台与文件。
 *
 * ## 为什么必须写文件
 *
 * 实测环境变化：DSH 最新版桌面端**没有控制台窗口**，`console.log` 看不见。
 * 这意味着所有挂载诊断（"注册失败：…"、"心跳已启动"）都静默消失 ——
 * 而"插件挂载失败往往是静默的"这条教训在这里代价最大：
 * 用户看不到任何东西，也无法判断插件到底跑没跑。
 *
 * 所以日志落盘到 `${DSH_HOME}/composite/log.txt`：用户能读，
 * 也能直接把它发出来。文件有大小上限，不会无限增长。
 */
const LOG_MAX_BYTES = 256 * 1024

function fileLog(line) {
  try {
    const dir = resolveDataDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'log.txt')
    try {
      const st = fs.statSync(file)
      if (st.size > LOG_MAX_BYTES) {
        // 超限就只留后半段，防无限增长（不引入轮转文件，够用即可）
        const text = fs.readFileSync(file, 'utf8')
        fs.writeFileSync(file, text.slice(text.length - LOG_MAX_BYTES / 2), 'utf8')
      }
    } catch (error) { /* 首次写入时文件不存在，正常 */ }
    fs.appendFileSync(file, new Date().toISOString() + '  ' + String(line) + '\n', 'utf8')
  } catch (error) {
    // 落盘失败也不能影响插件
  }
}

/** 插件自己的日志出口：控制台 + 文件。 */
function plog(message) {
  const text = String(message)
  try { console.log(text) } catch (error) { /* 桌面端可能没有可写控制台 */ }
  fileLog(text)
}

/**
 * 首次运行时自动安装预设。
 *
 * ## 为什么需要
 *
 * 用官方面板（设置 → 插件 → 添加插件）装这个包时，只会把**包**装进 profile，
 * **不会**把预设放进 `$DSH_HOME/.agent-presets/`。结果是：插件装上了，
 * 但新建会话的选择器里**没有「复合体」** —— 装了却用不了。
 *
 * 所以包自己带上预设，首次挂载时补齐这一步。这样无论用什么方式安装
 * （面板 / `dsh plugin add` / 手工 / git），结果都一致。
 *
 * ## 纪律
 *
 *   · **已存在就不覆盖** —— 用户可能改过人格或心跳参数，覆盖等于毁掉他的调整
 *   · 任何失败只打日志 —— 预设装不上不该连累插件本身
 */
/**
 * 兼容性自检：把运行时的真实版本与能力写进日志。
 *
 * ## 为什么先自检再适配
 *
 * 这件事上我已经错过两次：一次把插件装进了桌面端**不用**的 profile，
 * 一次以为预设必须改成 bundle 声明、而运行时未必是那个版本。
 * 两次都是**靠推测**而不是靠事实。
 *
 * 所以这里只做一件事：把能确定的测出来并落盘 —— 版本号、服务在不在、
 * 预设该用哪种形态。有了这些，适配才是照事实改，而不是照猜测改。
 *
 * 任何一步失败都只记一行，绝不影响插件本身。
 */
function checkCompatibility() {
  const parts = []
  try {
    parts.push('node ' + process.version)
    parts.push('profile=' + String(process.env.DSH_PROFILE === undefined ? '?' : process.env.DSH_PROFILE))
  } catch (error) { /* 忽略 */ }

  // 用**运行时自己的解析规则**问版本 —— 与它加载插件走同一套解析
  const probe = [
    '@deepseek-ai/dsh-agent-presets/package.json',
    '@deepseek-ai/dsh-agent/package.json',
    '@deepseek-ai/dsh-tools/package.json',
  ]
  const versions = {}
  for (let i = 0; i < probe.length; i += 1) {
    const spec = probe[i]
    const label = spec.replace('/package.json', '')
    try {
      const file = fileURLToPath(import.meta.resolve(spec))
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
      versions[label] = String(pkg.version)
      parts.push(label.replace('@deepseek-ai/', '') + '=' + String(pkg.version))
    } catch (error) {
      parts.push(label.replace('@deepseek-ai/', '') + '=解析失败')
    }
  }

  // 预设形态判定：0.1.7 起官方从"目录"改为"bundle 内声明"
  const v = versions['@deepseek-ai/dsh-agent-presets']
  let note = '无法判定（agent-presets 不可解析）'
  const m = v === undefined ? null : /^(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (m !== null) {
    const major = Number(m[1])
    const minor = Number(m[2])
    note = (major > 0 || minor >= 7)
      ? 'bundle 声明（目录形态可能不再被读）'
      : '目录形态 .agent-presets/<id>/'
  }
  parts.push('预设形态=' + note)
  plog('[composite] 自检：' + parts.join('  '))
}

function ensurePresetInstalled() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const src = path.join(here, '..', 'preset')
    const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
    const dst = path.join(home, '.agent-presets', 'composite')

    if (!fs.existsSync(path.join(src, 'agent.cordis.yml'))) return
    if (fs.existsSync(path.join(dst, 'agent.cordis.yml'))) return // 已有，绝不覆盖

    fs.mkdirSync(dst, { recursive: true })
    const names = fs.readdirSync(src)
    for (let i = 0; i < names.length; i += 1) {
      const from = path.join(src, names[i])
      const to = path.join(dst, names[i])
      if (fs.statSync(from).isFile()) fs.copyFileSync(from, to)
    }
    plog('[composite] 预设已自动安装到 ' + dst + '（新建会话时可选「复合体」）')
  } catch (error) {
    plog('[composite] 预设自动安装失败（不影响插件本身）：'
      + String(error && error.message ? error.message : error))
  }
}

// ── 入口 ────────────────────────────────────────────────────────────────

/**
 * @param {object} ctx 宿主 cordis 上下文
 * @param {object} [config] loader 行配置
 */
export function apply(ctx, config) {
  const plane = config !== null && config !== undefined && typeof config.plane === 'string'
    ? config.plane
    : 'host'

  // 总开关优先于一切：标记文件存在就整体停用（两个平面都算）。
  // 这比 YAML 的 disabled 更彻底 —— 那个只停宿主面那一行。
  try {
    if (getShared().isDisabled()) {
      plog('[composite] 检测到 disabled 标记，插件整体停用（plane=' + plane + '）')
      return
    }
  } catch (error) {
    // 探测失败当作启用，绝不静默失效
  }

  plog('[composite] 挂载（plane=' + plane + '）')

  // 无论哪个平面先挂上，都补齐预设（幂等，已存在就不动）
  ensurePresetInstalled()
  // 并把运行时的真实版本落盘 —— 适配要照事实改，不照猜测改
  checkCompatibility()

  try {
    // ── 预设面：不再注册任何东西 ─────────────────────────────────────────
    //
    // 为什么改成这样（实测代价换来的）：
    //
    // 原来人格/状态/心跳/记忆全挂在 preset 面，前提是"会话选了本预设"。
    // 而 0.2.x 把预设从「目录形态」改成了「bundle 内声明」——
    // 于是这份预设**根本没被读**，preset 面从未挂载，用户看到的是
    // "插件装好了、开关也开了、重启了，无事发生"。
    //
    // 宿主面则**在所有版本、所有 profile 上都加载**（日志实证）。
    // 所以功能全部搬到宿主面：不再依赖任何版本相关的预设机制。
    //
    // 代价：它会作用于所有会话，不再只限「复合体」会话。
    // 对一个自用 bot 而言这个代价可以接受，换来的是"装上就能用"。
    if (plane === 'preset') {
      plog('[composite] 预设面：功能已在宿主面注册，此处不重复（避免同名重复注册）')
      return
    }

    // ── 宿主面：注册全部功能 ─────────────────────────────────────────────
    installConsole(ctx, config)        // 可视化控制台页面
    installNapCatBridge(ctx, config)   // QQ 双向（配置开启才启动）
    installPersona(ctx, config)        // 人格段
    installContext(ctx, config)        // 状态 + 记忆摘要注入
    installObservation(ctx)            // 事件 → 观察信号
    installOutbound(ctx)               // 出站分段（首段零延迟）
    installGenerationBias(ctx)         // 状态 → 生成参数
    installHeartbeat(ctx, config)      // 主动心跳
    installDecision(ctx, config)       // L1 同步 + L2 异步决策

    // 工具注册是异步的（要动态 import），失败只降级
    installMemoryTools(ctx, config).catch((error) => {
      plog('[composite] 记忆工具装配失败：' + String(error && error.message ? error.message : error))
    })

    plog('[composite] 宿主面装配完成（人格/状态/心跳/记忆/决策/控制台全部就绪）')
  } catch (error) {
    // 装配失败不应让整个插件挂载失败
    plog('[composite] 装配异常（已降级）：' + String(error && error.message ? error.message : error))
  }
}
