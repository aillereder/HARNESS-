// 装配冒烟测试：用假的 ctx 真实调用 apply()。
//
// 为什么需要它：**模块能 import 成功 ≠ apply() 不抛**。
// 装配期的异常会让整个插件挂载失败（dsh-herta 的教训），
// 而这类错误只有在真启动时才暴露 —— 那时排查成本很高。
// 这里用最小假 ctx 把两条装配路径都跑一遍。

import { apply, inject, name } from './lib/index.js'

let pass = 0
let fail = 0
function ok(name_, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name_) }
  else { fail += 1; console.log('FAIL  ' + name_ + (detail === undefined ? '' : '  -> ' + detail)) }
}

/** 最小假 ctx：记录注册了什么，不连接真服务。 */
function fakeCtx(options) {
  const o = options === undefined || options === null ? {} : options
  const recorded = {
    sections: [],
    contexts: [],
    tools: [],
    events: [],
    effects: [],
    gets: [],
    intervals: [],
    timeouts: [],
  }
  const disposable = () => () => {}
  const systemPrompt = {
    section: (s) => { recorded.sections.push(s); return disposable() },
    context: (c) => { recorded.contexts.push(c); return disposable() },
    getContextOrder: () => 115,
  }
  const tools = {
    register: (t) => { recorded.tools.push(t); return disposable() },
  }
  const timer = {
    interval: (cb, ms) => { recorded.intervals.push({ cb: cb, ms: ms }); return disposable() },
    timeout: (cb, ms) => { recorded.timeouts.push({ cb: cb, ms: ms }); return disposable() },
  }
  const ctx = {
    // 真 Cordis 对 `inject` 声明的服务会以属性形式暴露，这里照做
    systemPrompt: o.noSystemPrompt === true ? undefined : systemPrompt,
    tools: o.noTools === true ? undefined : tools,
    get: (key) => {
      recorded.gets.push(key)
      if (key === 'systemPrompt') return o.noSystemPrompt === true ? undefined : systemPrompt
      if (key === 'tools') return o.noTools === true ? undefined : tools
      if (key === 'timer') return o.noTimer === true ? undefined : timer
      if (key === 'agents') return o.agents
      return undefined
    },
    on: (eventName, handler) => { recorded.events.push({ name: eventName, handler: handler }); return disposable() },
    effect: (fn) => {
      recorded.effects.push(fn)
      try { const d = fn(); return typeof d === 'function' ? d : disposable() } catch (error) { return disposable() }
    },
  }
  return { ctx: ctx, recorded: recorded, timer: timer }
}

// 环境隔离：把数据目录指到临时位置，别污染真实 ~/.dsh
const tmpHome = process.env.TEMP
  ? process.env.TEMP + '\\dsh-composite-smoke'
  : '/tmp/dsh-composite-smoke'
process.env.DSH_HOME = tmpHome

// ── 1. 导出契约 ─────────────────────────────────────────────────────────
{
  ok('name 是 composite（须与 cordis.patch.yml 的 id 一致）', name === 'composite', name)
  ok('inject 声明了 systemPrompt', Array.isArray(inject) && inject.indexOf('systemPrompt') >= 0,
    JSON.stringify(inject))
  ok('apply 是函数', typeof apply === 'function')
}

// ── 2. preset 面装配不抛，且注册了该注册的东西 ──────────────────────────
{
  const { ctx, recorded } = fakeCtx()
  let threw = false
  try { apply(ctx, { plane: 'host', persona: '测试人格：你是测试角色。' }) } catch (error) {
    threw = true
    console.log('       抛出：' + error.message)
  }
  ok('preset 面 apply 不抛', threw === false)
  ok('  注册了人格段', recorded.sections.length === 1, String(recorded.sections.length))
  ok('  人格段名正确', recorded.sections[0] !== undefined && recorded.sections[0].name === 'composite:persona',
    JSON.stringify(recorded.sections.map((s) => s.name)))
  ok('  人格文本来自配置', recorded.sections[0] !== undefined
    && recorded.sections[0].text === '测试人格：你是测试角色。', String(recorded.sections[0].text))
  ok('  人格段排在人设前缀之后（order=100）', recorded.sections[0].order === 100,
    String(recorded.sections[0].order))
  ok('  注册了状态上下文', recorded.contexts.length === 1
    && recorded.contexts[0].name === 'composite:state',
    JSON.stringify(recorded.contexts.map((c) => c.name)))
  ok('  订阅了 session/event（观察的主挂点）',
    recorded.events.some((e) => e.name === 'session/event'),
    JSON.stringify(recorded.events.map((e) => e.name)))
  ok('  订阅了 agent/turn-stopping（L1 的挂点）',
    recorded.events.some((e) => e.name === 'agent/turn-stopping'),
    JSON.stringify(recorded.events.map((e) => e.name)))
  ok('  订阅了 agent/inbox/inserted（被动心跳）',
    recorded.events.some((e) => e.name === 'agent/inbox/inserted'),
    JSON.stringify(recorded.events.map((e) => e.name)))
  ok('  订阅了 agent/assistant-stream（出站分段发送的来源）',
    recorded.events.some((e) => e.name === 'agent/assistant-stream'),
    JSON.stringify(recorded.events.map((e) => e.name)))
  ok('  订阅了 agent/request（状态 → 生成参数）',
    recorded.events.some((e) => e.name === 'agent/request'),
    JSON.stringify(recorded.events.map((e) => e.name)))
}

// ── 3b. 出站与生成偏置的接线细节 ────────────────────────────────────────
{
  const { ctx, recorded } = fakeCtx()
  apply(ctx, { plane: 'host' })

  // agent/assistant-stream 的处理函数在 NapCat 未启用时应安静返回（不该抛）
  const streamHandler = recorded.events.find((e) => e.name === 'agent/assistant-stream')
  let threw = false
  try {
    streamHandler.handler({ agent: { id: 's1' }, frame: { type: 'start' } })
    streamHandler.handler({ agent: { id: 's1' }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '嗨' } } })
    streamHandler.handler({ agent: { id: 's1' }, frame: { type: 'end' } })
  } catch (error) { threw = true; console.log('       抛出：' + error.message) }
  ok('NapCat 未启用时 assistant-stream 处理安静返回', threw === false)

  // agent/request 必须在状态不好时压低 maxTokens，且不抛
  const reqHandler = recorded.events.find((e) => e.name === 'agent/request')
  let cfg = null
  let reqThrew = false
  try {
    cfg = await reqHandler.handler({ agent: { id: 's1' }, turn: 1, step: 1 }, async () => ({
      provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 800, temperature: 0.9,
    }))
  } catch (error) { reqThrew = true }
  ok('agent/request 处理不抛', reqThrew === false)
  ok('  返回了调用配置', cfg !== null && cfg !== undefined && cfg.provider === 'deepseek-official',
    JSON.stringify(cfg))
  ok('  maxTokens 不被放大（只收紧不放松）', cfg !== null && cfg.maxTokens <= 800,
    cfg === null ? 'null' : String(cfg.maxTokens))
  ok('  且不低于合理下限 400', cfg !== null && cfg.maxTokens >= 400,
    cfg === null ? 'null' : String(cfg.maxTokens))
}

// ── 3. 状态上下文可以同步求值，且返回可读文本 ───────────────────────────
{
  const { ctx, recorded } = fakeCtx()
  apply(ctx, { plane: 'host', personality: undefined })
  const entry = recorded.contexts[0]
  ok('context.text 是函数（同步求值）', typeof entry.text === 'function', typeof entry.text)
  let out = null
  let threw = false
  try { out = entry.text({}) } catch (error) { threw = true }
  ok('求值不抛', threw === false)
  ok('返回字符串', typeof out === 'string', typeof out)
  ok('含状态段（心情/精力/耐心/专注）',
    out.indexOf('心情') >= 0 && out.indexOf('耐心') >= 0, out)
  // 连续求值两次应当稳定（漂移按时间，但同一毫秒内不该乱跳）
  const out2 = entry.text({})
  ok('连续求值都是字符串', typeof out2 === 'string')
}

// ── 3c. 会话身份：注入用的键必须与观察用的键一致 ────────────────────────
//
// 这一组是**回归测试**，针对一个真实存在过的 bug：
// 注入（systemPrompt.context）用的是写死的 'dsh|session'，
// 而观察（session/event）用 session.id —— 两个键不一致，
// 于是状态行读的是一个除了它自己没人写的键：**永远不动**，
// 而且所有会话看到同一份。用户看到的现象是"状态行不更新"。
{
  const agentA = { id: 'session-A', session: { id: 'session-A' } }
  const agentB = { id: 'session-B', session: { id: 'session-B' } }
  let current = agentA
  const agents = {
    currentInitiator: () => current,
    requireInitiator: () => current,
    // plugin 不该用这个（用了就会串会话），放这里当哨兵
    list: () => { throw new Error('不该调 list()：会话身份必须来自 currentInitiator()') },
  }

  const { ctx, recorded } = fakeCtx({ agents })
  apply(ctx, { plane: 'host' })

  const entry = recorded.contexts[0]
  ok('会话键：注册了状态上下文', entry !== undefined && typeof entry.text === 'function')

  // A 会话挨一轮工具失败：状态必然变化
  const sessionHandler = recorded.events.find((e) => e.name === 'session/event').handler
  sessionHandler({ id: 'session-A' }, { type: 'turn/start', time: Date.now(), data: { turn: 1 } })
  for (let i = 0; i < 3; i += 1) {
    sessionHandler({ id: 'session-A' }, {
      type: 'tool/result', time: Date.now(),
      data: { turn: 1, step: i + 1, message: { content: [{ type: 'tool-result', toolCallId: 'c' + i, content: [], isError: true }] } },
    })
  }
  sessionHandler({ id: 'session-A' }, {
    type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } },
  })

  current = agentA
  const outA = entry.text({})
  current = agentB
  const outB = entry.text({})
  current = agentA
  const outA2 = entry.text({})

  ok('会话键：A 会话的状态上下文是字符串', typeof outA === 'string' && outA.length > 0, String(outA).slice(0, 60))
  ok('会话键：B 会话的状态上下文是字符串', typeof outB === 'string' && outB.length > 0, String(outB).slice(0, 60))
  // 这一条就是那个 bug 的判据：键一致时 A 读到的是 A 自己的状态
  ok('会话键：挨过失败的 A 与干净的 B 状态**不同**（键一致的核心判据）',
    outA !== outB, 'A=' + String(outA).slice(0, 46) + ' | B=' + String(outB).slice(0, 46))
  ok('会话键：同一会话连续求值稳定', outA === outA2)
  // 反向判据：状态没往共享键上写
  ok('会话键：没有退化到共享键（A 不是那个"谁都不写"的键）',
    outA.indexOf('耐心 10.0') < 0 || outB.indexOf('耐心 10.0') >= 0,
    'A=' + String(outA).slice(0, 46))

  // agents 服务缺失时必须降级而不是抛（老运行时的兼容路径）
  const degraded = fakeCtx()
  apply(degraded.ctx, { plane: 'host' })
  let degradedThrew = false
  let degradedOut = null
  try { degradedOut = degraded.recorded.contexts[0].text({}) } catch (error) { degradedThrew = true }
  ok('会话键：agents 缺失时降级不抛', degradedThrew === false)
  ok('  且仍然给出可读状态', typeof degradedOut === 'string' && degradedOut.indexOf('心情') >= 0,
    String(degradedOut).slice(0, 50))
}

// ── 4. 缺 systemPrompt 时不崩（硬依赖缺失的降级）────────────────────────
{
  const { ctx } = fakeCtx({ noSystemPrompt: true })
  let threw = false
  try { apply(ctx, { plane: 'host' }) } catch (error) { threw = true }
  ok('systemPrompt 缺失时 apply 不抛（整层降级）', threw === false)
}

// ── 5. 缺 tools 时记忆工具跳过而不崩 ────────────────────────────────────
{
  const { ctx } = fakeCtx({ noTools: true })
  let threw = false
  try { apply(ctx, { plane: 'host' }) } catch (error) { threw = true }
  ok('tools 缺失时 apply 不抛', threw === false)
  await new Promise((r) => setTimeout(r, 100))
  ok('  异步装配也不产生未捕获异常', true)
}

// ── 6. 宿主面：NapCat 未启用时安静返回 ──────────────────────────────────
{
  const { ctx, recorded } = fakeCtx()
  let threw = false
  try { apply(ctx, { plane: 'host' }) } catch (error) { threw = true }
  ok('NapCat 未启用时宿主面不抛', threw === false)
  // 设计变更（实测代价换来的）：功能全部搬到了宿主面。
  // 因为 0.2.x 改了预设声明形态，预设面在用户机器上根本没挂载；
  // 而宿主面在所有版本、所有 profile 上都加载。
  ok('  且宿主面现在注册全部功能（不再依赖预设面）', recorded.sections.length === 1,
    String(recorded.sections.length))
}

// ── 7. 宿主面：启用 NapCat 但指向死地址也不崩 ───────────────────────────
{
  const { ctx } = fakeCtx()
  let threw = false
  try {
    apply(ctx, {
      plane: 'host',
      napcat: { enabled: true, http: 'http://127.0.0.1:1', token: 'x', tickMs: 600000 },
    })
  } catch (error) { threw = true; console.log('       抛出：' + error.message) }
  ok('NapCat 指向死地址时 apply 不抛（重连逻辑负责恢复）', threw === false)
  await new Promise((r) => setTimeout(r, 150))
}

// ── 8. 配置缺失/非法时用默认值 ──────────────────────────────────────────
{
  const cases = [
    undefined,
    null,
    {},
    { plane: 'host' },
    { plane: 'host', persona: '' },
    { plane: 'host', persona: 123 },
    { plane: 'unknown-plane' },
  ]
  let threw = 0
  for (const cfg of cases) {
    const { ctx } = fakeCtx()
    try { apply(ctx, cfg) } catch (error) { threw += 1 }
  }
  ok('各种畸形配置都不抛', threw === 0, String(threw))
  await new Promise((r) => setTimeout(r, 150))
}

// ── 9. 主动心跳的接线与过滤 ─────────────────────────────────────────────
{
  // 未启用 → 不该注册定时器
  const off = fakeCtx()
  apply(off.ctx, { plane: 'host' })
  ok('心跳未启用时不注册定时器', off.recorded.intervals.length === 0,
    String(off.recorded.intervals.length))

  // 启用 → 注册一个定时器
  const on = fakeCtx()
  apply(on.ctx, {
    plane: 'host',
    heartbeat: { enabled: true, intervalMs: 1000, silenceMs: 0, cooldownMs: 0, dailyBudget: 99, probability: 1 },
  })
  ok('心跳启用时注册了定时器', on.recorded.intervals.length === 1,
    String(on.recorded.intervals.length))
  // 定时器用**高频 tick**（这是她能要求的粒度上限），默认节奏交给每会话的 nextEvalAt。
  // 早期拿 intervalMs 当定时器周期，导致她排的 15 秒永远等不到 —— 实测踩过。
  ok('  定时器用秒级 tickMs（不是分钟级 intervalMs）',
    on.recorded.intervals[0].ms === 10000, String(on.recorded.intervals[0].ms))

  // timer 缺失 → 降级而非崩
  const noTimer = fakeCtx({ noTimer: true })
  let threw = false
  try {
    apply(noTimer.ctx, { plane: 'host', heartbeat: { enabled: true } })
  } catch (error) { threw = true }
  ok('timer 缺失时心跳降级不抛', threw === false)
}

// ── 10. 心跳只对复合体预设的会话生效 ────────────────────────────────────
{
  const steered = []
  const fakeAgents = {
    list: () => [
      {
        id: 'session-on-composite',
        status: 'idle',
        session: { header: { agentPreset: 'composite' } },
        steer: (m) => steered.push({ who: 'composite', text: m.content[0].text }),
      },
      {
        id: 'session-on-standard',
        status: 'idle',
        session: { header: { agentPreset: 'standard' } },
        steer: (m) => steered.push({ who: 'standard', text: m.content[0].text }),
      },
      {
        id: 'session-busy',
        status: 'running',
        session: { header: { agentPreset: 'composite' } },
        steer: (m) => steered.push({ who: 'busy', text: m.content[0].text }),
      },
    ],
  }

  const f = fakeCtx({ agents: fakeAgents })
  apply(f.ctx, {
    plane: 'host',
    heartbeat: {
      enabled: true, intervalMs: 50,
      silenceMs: 0, cooldownMs: 0, dailyBudget: 99, probability: 1,
      quietHours: [], minEnergy: 0, minPatience: 0, minMood: 0,
    },
  })
  ok('注册了定时器', f.recorded.intervals.length === 1)

  // 定时器**被触发时**就是"该评估了"。频率由 timer.interval 的间隔管，
  // 不必再在 tick 里设一道闸（早期版本两处都设，导致永远不触发）。
  let tickThrew = false
  try { f.recorded.intervals[0].cb() } catch (error) { tickThrew = true; console.log('       抛出：' + error.message) }
  await new Promise((r) => setTimeout(r, 50))

  ok('tick 不抛', tickThrew === false)
  ok('只对 composite 会话 steer', steered.length === 1, JSON.stringify(steered.map((x) => x.who)))
  ok('  被 steer 的是 idle 的 composite 会话',
    steered.length === 1 && steered[0].who === 'composite', JSON.stringify(steered.map((x) => x.who)))
  ok('  没有打扰 standard 会话', !steered.some((x) => x.who === 'standard'))
  ok('  没有插话忙碌会话', !steered.some((x) => x.who === 'busy'))
  ok('注入内容允许沉默', steered.length === 1 && steered[0].text.indexOf('别开口') >= 0,
    steered.length === 1 ? steered[0].text.slice(0, 60) : '')
  ok('注入内容告诉她可以自己定节奏（能力不告知等于不存在）',
    steered.length === 1 && steered[0].text.indexOf('heartbeat_wait') >= 0,
    steered.length === 1 ? steered[0].text.slice(-90) : '')
}

// ── 11. 总开关：disabled 标记文件让两个平面都停用 ────────────────────────
{
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const marker = pathMod.join(tmpHome, 'composite', 'disabled')
  fsMod.mkdirSync(pathMod.dirname(marker), { recursive: true })

  // 无标记 → 正常装配
  if (fsMod.existsSync(marker)) fsMod.rmSync(marker)
  const normal = fakeCtx()
  apply(normal.ctx, { plane: 'host' })
  ok('无标记时 preset 面正常装配', normal.recorded.sections.length === 1,
    String(normal.recorded.sections.length))

  // 有标记 → 两个平面都什么都不注册
  fsMod.writeFileSync(marker, 'disabled\n', 'utf8')
  const off = fakeCtx()
  apply(off.ctx, { plane: 'host' })
  ok('有标记时 preset 面不注册人格段', off.recorded.sections.length === 0,
    String(off.recorded.sections.length))
  ok('  也不注册状态上下文', off.recorded.contexts.length === 0, String(off.recorded.contexts.length))
  ok('  也不订阅任何事件', off.recorded.events.length === 0, String(off.recorded.events.length))

  const offHost = fakeCtx()
  apply(offHost.ctx, { plane: 'host', heartbeat: { enabled: true } })
  ok('有标记时宿主面也不注册控制台路由', offHost.recorded.effects.length === 0,
    String(offHost.recorded.effects.length))

  // 移除标记 → 恢复
  fsMod.rmSync(marker)
  const back = fakeCtx()
  apply(back.ctx, { plane: 'host' })
  ok('移除标记后恢复装配', back.recorded.sections.length === 1, String(back.recorded.sections.length))
}

// ── 12. 首次运行自动安装预设（面板安装的缺口）─────────────────────────────
{
  const fsMod = await import('node:fs')
  const pathMod = await import('node:path')
  const presetDir = pathMod.join(tmpHome, '.agent-presets', 'composite')

  // 清掉，模拟"面板刚装完包、还没装预设"的状态
  if (fsMod.existsSync(presetDir)) fsMod.rmSync(presetDir, { recursive: true, force: true })
  ok('起始状态：临时环境里没有预设', fsMod.existsSync(presetDir) === false)

  const c = fakeCtx()
  apply(c.ctx, { plane: 'host' })
  ok('挂载后预设被自动装上',
    fsMod.existsSync(pathMod.join(presetDir, 'agent.cordis.yml')),
    'dir=' + presetDir)
  ok('  元数据也一起装（否则选择器显示目录名）',
    fsMod.existsSync(pathMod.join(presetDir, 'preset.yml')))

  // 已存在时不覆盖（用户可能改过人格/心跳参数）
  const before = fsMod.readFileSync(pathMod.join(presetDir, 'agent.cordis.yml'), 'utf8')
  fsMod.writeFileSync(pathMod.join(presetDir, 'agent.cordis.yml'), '# 用户改过的\n', 'utf8')
  const c2 = fakeCtx()
  apply(c2.ctx, { plane: 'host' })
  const after = fsMod.readFileSync(pathMod.join(presetDir, 'agent.cordis.yml'), 'utf8')
  ok('已有预设时绝不覆盖（保护用户的调整）', after === '# 用户改过的\n', JSON.stringify(after.slice(0, 30)))
  fsMod.writeFileSync(pathMod.join(presetDir, 'agent.cordis.yml'), before, 'utf8')
}

console.log('\napply 冒烟测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
