# dsh-composite

把「思考 / 决策 / 记忆 / 状态 / 主动」装成 DeepSeek Harness 的聊天 Bot。
**零依赖、零构建**，只用 Node 内置模块。

核心一句话：**变量是 DSH 观察自己输出得出的** —— 不额外调模型去推断她的状态，
而是从已经发生的事实里算（她说了多长、工具失败几次、多久没人理她）。
于是状态机归程序，模型只负责理解与生成。

---

## 装

```powershell
node scripts/install-web-profile.mjs --dry-run            # 先看它会做什么
node scripts/install-web-profile.mjs --profile desktop     # 桌面端（Electron）
node scripts/install-web-profile.mjs --profile web         # web 端
```

装的是哪个 profile 就写哪个：桌面端是 `desktop`，命令行 `dsh web` 是 `web`。
**装错 profile 的表现是"什么都装上去了，但一点反应都没有"** —— 实测踩过。

**装完必须重启**（桌面端：退出 App 再打开；web 端：重启 `dsh web`）。
bundle 变更只在启动期合成，`patchReload: live` 只热重载 patch 文件本身。

> 为什么不用官方的 `dsh plugin add`：它把操作转发给 **pnpm**，
> 而本机 pnpm 未安装；Windows 上 `npm.ps1` / `dsh.ps1` 还被
> PowerShell 执行策略禁止。本脚本走确定性路径（改 profile 清单 + 镜像进
> `node_modules` + 装预设两条路），正是 pnpm 成功那些次产生的结果。

### 预设的两条路（0.1.x 与 0.2.x 认的不是同一个东西）

| 运行时 | 预设怎么被读到 | 本包提供 |
|---|---|---|
| **0.2.x**（桌面端 `0.2.0-rc.2`） | **bundle 内声明**：插入一行 `@deepseek-ai/dsh-agent-preset` | `preset.patch.yml`（随包发布，`dsh.bundle.patch` 是数组） |
| **0.1.x**（web 端 `0.1.5-rc.2`） | **目录形态**：`$DSH_HOME/.agent-presets/<id>/agent.cordis.yml` | 安装脚本把 `preset/` 复制过去 |

**0.2.x 不再读取 `.agent-presets/` 目录** —— 复制目录没有用、也没有报错，
表现就是"选择器里没有「复合体」"。这条实测换来的结论写在
`preset.patch.yml` 的头部注释里。

预设树里 `composite` 那一行的**唯一出处是 `preset.patch.yml`**：
`preset/agent.cordis.yml` 里故意没有这一行，否则两套机制都生效时
同一个预设树里会出现两个实例（工具重名、定时器翻倍、状态各记一份）。

### 装完验证三条

1. **配置能合成**
   ```powershell
   node C:\Users\<你>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js `
        --profile web --dump-config
   ```
   期望：退出码 0，且 `- id: composite` **恰好一条**。

2. **预设进了名单**：新建会话 → 选择器里出现「复合体」。

3. **状态行出现**：会话里应该能看到 `【当前状态】心情 x/10、精力 x/10…`。
   它由 `systemPrompt.context` 注入，同步求值。

> ⚠️ **当前版本的人格/状态上下文挂在宿主面，对所有会话生效**（包括写代码的会话）。
> 这是 c06fbb5 的权宜之计：0.2.x 的预设面当时根本挂不上，挂在预设面等于功能全灭。
> 现在预设声明已经修好（`preset.patch.yml`），下一步才是按平面拆分：
> 会话级的东西回预设面，只留给「复合体」会话。
> 在那之前，**你会在每个会话里都看到 `【当前状态】` 那行** —— 这不是 bug，是已知代价。
>
> 旧会话不会自动切换预设（预设是建会话时定的）。

### 状态行不动？先看这一条

状态行读的是**当前会话自己的**状态。键来自
`ctx.agents.currentInitiator().id`（= `session.id`），与观察层
`session/event` 用的是同一个值 —— **这是同一个键**。

曾经不是：注入用写死的 `dsh|session`，观察用 `session.id`，于是状态机
一直给 `session-xxxx` 记账、注入那行读的却是一个除它自己没人写的键，
表现为"状态行永远不动，而且每个会话看到的一样"。回归测试在
`test-apply.mjs` 的 3c 组（A/B 两会话状态必须不同）。

### 回滚

```powershell
node scripts/install-web-profile.mjs --rollback
```

然后同样要重启 `dsh web`。

---

## 启用 / 禁用

### 一处生效的总开关（推荐）

```powershell
# 停用（宿主面 + 预设面一起停）
New-Item "$env:USERPROFILE\.dsh\composite\disabled" -ItemType File -Force

# 启用
Remove-Item "$env:USERPROFILE\.dsh\composite\disabled"
```

改完**重启 `dsh web`**。停用时控制台会打
`[composite] 检测到 disabled 标记，插件整体停用（plane=…）`。

**为什么需要这个文件**：`cordis.patch.yml` 里的 `disabled: true` 只停掉
**宿主面那一行**（实测确认过它确实生效），而预设面那一行（`plane: preset`）
照样加载 —— 人格段、状态上下文、主动心跳都还在跑。标记文件同时覆盖两个平面。

探测失败（目录还不存在等）一律当作**启用** —— 不会因为读不到标记而静默失效。

### 只停某个功能

改 `preset/agent.cordis.yml` 的 `composite` 行（改完要重装 + 重启）：

```yaml
    heartbeat:
      enabled: false      # 停主动心跳，其余照常
```

NapCat 同理（默认就是关的）。

### 完全卸载

```powershell
node scripts/install-web-profile.mjs --rollback
```

然后重启。会话数据在 `~/.dsh/sessions`，与 profile 分离，**卸载不会丢历史对话**。

---

## 这个包只做宿主侧

**没有客户端 bundle**，也不会做。原因是一次真实事故：我手写过一个
`lib/client.js`（两个 GUI 插槽 + 轮询宿主路由），它在假环境里 22 项断言全过，
但**装上去之后 WEB 界面直接起不来** —— `client-modules` 在启动期抛
`ClientPackageCompositionError`，而那个准入规则（源码里提到的运行期
bundle purity gate）在假环境里复现不了。

教训：**client bundle 在启动期加载，任何它不接受的东西都会让整个 profile 起不来。**
宿主侧的包没有这个风险（挂载失败只影响自己）。所以这个包的边界是：

- 宿主侧：状态机、心跳、记忆、决策、NapCat 桥、`/composite/status` 控制台页面
- 不碰 GUI：不在会话标题栏、侧栏、浮层里插任何东西

想看状态就用宿主控制台那行每分钟的日志，或者 `/composite/status` 页面。

---

## QQ 接入（可选）

默认**关闭**。启用需要改 profile 的 `cordis.patch.yml`，给 `composite` 行加配置：

```yaml
- id: composite
  config:
    napcat:
      enabled: true
      http: 'http://127.0.0.1:3000'
      ws: 'ws://127.0.0.1:3000'
      token: 'dsbot'
      peers: []          # 空 = 不限；填了就只响应这些号
      allowGroup: false  # 默认不在群里说话
```

注意：`patch` 会**整体替换**该行的 `config`，所以同一条目下的其他配置要一起写。

**NapCat 侧必须保持 `reportSelfMessage` 关闭** —— 打开就是"bot 自己跟自己说话"。
（本插件另有一道自消息判定，但那是兜底，不是许可。）

---

## 她是什么

| 能力 | 做法 |
|---|---|
| **状态** | 心情/精力/耐心/专注，带均值回归的随机游走，**按真实经过时间**成比例 |
| **状态影响** | 累/没耐心 → 回复变短（`maxTokens` 压低）；这是真提速也是拟人 |
| **回复节奏** | **首段零延迟**（首句写完就发）+ 后续段按对数间隔（`log(词数+1, 2.6)` 秒） |
| **决策层** | 两级：L1 同步纯逻辑（发送前，<1ms）+ L2 异步小模型复核（发出后，下一轮改口） |
| **记忆** | 分层 + **隔离**（私聊记忆绝不进群聊）+ 2-gram 词法召回 |
| **主动心跳** | 三段分离：定时器只做"该评估了"信号 → 纯逻辑决策 → 放行才起一轮。累了不硬撑，且被要求**允许沉默** |
| **多模态** | 免费：`deepseek-flash` 就是 `DeepSeek-V41-Flash`，`inputModalities` 含 image |

### 三条不许省的纪律（都是实测换来的）

1. **决策层必须是独立的一次模型调用。** 旧实现证过：把判断塞进思考层输出的
   一个字段，决策层三次全放行，**干预变成死代码**。
2. **命令失败 ≠ 工具失败。** `process.exit(3)` 返回 exit code 1，但工具判定为
   成功。所以"她声称做完但没做"的判据只能看 `tool/result.error` / `isError`，
   **不能看命令退出码**。
3. **记忆读取必须同步。** DSH 没有异步 prompt provider，`PromptSection.text`
   是同步求值。所以是"内存索引 + 同步查表"，不是"每次去查库"。

---

## 主动心跳：没人说话时她也会开口

默认**在预设里开启**，配置在 `preset/agent.cordis.yml` 的 `composite` 行：

```yaml
    heartbeat:
      enabled: true
      intervalMs: 180000     # 每 3 分钟评估一次（评估 ≠ 发言）
      silenceMs: 180000      # 用户沉默 3 分钟以上才考虑
      cooldownMs: 1200000    # 距上次主动开口至少 20 分钟
      dailyBudget: 8         # 每天最多主动 8 次
      probability: 0.4       # 每次评估通过后的概率
      quietHours: [[0, 7]]   # 凌晨不打扰
      minEnergy: 3.0         # 累了就不主动找话说
      minPatience: 2.5
      minMood: 2.5
```

**三段分离**（这是不刷屏的根本）：

```
定时器（每 3 分钟）  → 只产生"该评估了"的信号，**不调模型**
决策（纯逻辑）        → 读状态 + 计数器 + 时段，输出 allow/deny + 理由
内容（仅 allow 后）   → 这一次才 steer 起一轮
```

定时器**绝不直接调模型**，也绝不"评估了就发"—— 那会退化成"定时发消息"，
是刷屏与自我循环的经典成因。

**她被要求允许沉默**：注入的旁注里明确写着"没什么真想说的就别开口"，
所以不是每次评估都会收到一条消息 —— 硬找话说比沉默更明显。

**放行条件（全部满足）**：时段许可 · 冷却已过 · 今日预算未超 · 概率通过 ·
用户已沉默够久 · 当前没有进行中的轮次 · **她自己的状态撑得住**。
最后一条是性格不是安全阀：累了/没耐心就不主动找话说。

**只对挂载了本预设的会话生效**（按 `session.header.agentPreset` 过滤），
不去打扰其他预设的会话。冷却与预算**按会话独立计数**。

要关掉就把 `enabled` 改成 `false`，然后重装（`node scripts/install-web-profile.mjs`
会更新预设）并重启。

---

## 测试

```powershell
node test-all.mjs
```

十三套、**538 项**，全部纯逻辑或对着**假 OneBot 服务**跑（不需要真 QQ）。

| 套 | 覆盖 |
|---|---|
| `test-state` / `test-tuning` | 变量演化、按时间成比例、软性地板、调参验收 |
| `test-stream` | 分句切点、首段零延迟、对数间隔、分段互斥 |
| `test-filter` | L1 判定与**不误报**（反例优先） |
| `test-memory` | 隔离（不泄漏）、别名归一、去重、召回、嵌入预算 |
| `test-followup` | 严格顺序、幂等、静默窗、限频 |
| `test-onebot` / `test-ws-frame` | 事件解析（含历史回包自消息判定）、RFC6455 编解码 |
| `test-decide` | 判决解析**退化路径**、配额、纠正措辞 |
| `test-observe` | 事件→信号（字段形状照类型定义抄） |
| `test-heartbeat` | 主动心跳的**拦截面**（不打扰时段、冷却、预算、累了不硬撑）、长期频率 |
| `test-apply` | 装配冒烟（假 ctx 真实调 apply，含**会话身份键一致性**回归：A/B 会话状态必须不同） |
| `test/test-e2e` | 端到端：**自回声=0**、**顺序不倒**、断线自愈、四层健康检查 |

### 这些测试真抓到过东西

不是"补覆盖率"，是实际抓到 12 个真 bug，其中多数人工试聊看不出来：

- 切点取最后一个句末标点 → **从分段**，一次刷出全部
- 生成结束后仍套最小段长 → 短句**永远发不出去**（静默丢话）
- `alreadySent` 混淆"发过一部分/发完" → 残余**静默丢失**
- `burst` 从不归零 → 活力被压穿地板
- 包含规则无主观前缀护栏 → 正常承接被误判为重复
- 判决词只在换行后找理由 → `VETO: 理由` 被当"无理由"放行
- JSON 截断回落到文本判定 → 半截 JSON 被当成有效否决

---

## 文件

```
lib/
  state.js      变量演化（纯函数）
  stream.js     分句与节奏（纯函数）
  filter.js     L1 前置过滤（纯函数）
  memory.js     分层 + 隔离 + 召回（纯逻辑）
  followup.js   顺序 / 去重 / 静默窗 / 限频（纯逻辑）
  observe.js    事件 → 观察信号
  decide.js     L2 决策（判决解析 + 配额 + 措辞）
  onebot.js     OneBot 事件解析 + 健康判定
  ws-frame.js   RFC6455 帧编解码（纯逻辑）
  ws.js         WS 网络层（重连 + 半死检测）
  napcat.js     OneBot HTTP 客户端
  index.js      双平面接线
cordis.patch.yml            宿主面 bundle patch（控制台 / NapCat 桥）
preset.patch.yml            预设声明 patch（0.2.x 靠它把「复合体」放进选择器）
scripts/install-web-profile.mjs   安装 / 回滚
```

数据落在 `${DSH_HOME}/composite/`：`state.json` / `memory.jsonl` / `pending.jsonl`。

---

## 已知限制

- **主动心跳默认不开**。心跳策略的默认值在 `lib/heartbeat.js` 的
  `DEFAULT_POLICY`（`enabled: false`），宿主面那一行没有 config。
  要开就改 `preset.patch.yml` 里 `composite` 子插件的 `heartbeat` 段
  （那里已经写好了一份调好的配置，但只在预设面生效）。
- **平面拆分还没做**（见上文警告）：人格与状态上下文目前在宿主面，
  对所有会话生效。
- **本机 web 端是 `0.1.5-rc.2`，桌面端是 `0.2.0-rc.2`**，两者共用同一个
  `~/.dsh`：状态/记忆文件是**两个进程同时读写**的（后写的赢）。
  一个进程独占使用时没问题，两个一起跑会互相盖。日志在同一个
  `log.txt` 里交替出现，就是这个原因。
- **没有对真实 QQ 做过端到端验证**（NapCat 当前未运行）。网络层、事件解析、
  顺序、自回声、断线自愈都由假 OneBot 服务覆盖，但那毕竟不是真 NapCat。
- **控制台 UI 未做**。`client.js` 需要 `window.__ModuleLoader__.load({id, factory})`
  契约（预打包产物），不是普通 ESM；手写一个不符合契约的 client 会弄坏整个 profile。
- **鸿蒙端未验证**（本版只面向 Win 的 web 端）。
- 预设目前是 `standard` 的副本，因此**她仍然持有编码工具**（bash/fs 等）。
  按设计聊天人格不该有 shell —— 要收窄就把 `preset/agent.cordis.yml` 里
  `tool-bash` / `tool-fs` 等行加 `disabled: true`（改一行的事）。
  注意 `preset.patch.yml` 里那个预设**已经**不带 shell（子插件列表只有
  persona 与 composite），但它只在 0.2.x 的桌面端生效。

## 两处"接上了但没有真跑过"的地方

诚实标注，免得被当成已验证：

1. **L2 改口注入**：判决会写进 `systemPrompt.context`（以记录口吻，只注入一次）。
   逻辑与措辞都有单测，但"她读完之后是否真的改口"只能靠真实对话看。
2. **出站分段**：`assistant-stream` → `Segmenter` → 间隔发送的路由有冒烟测试，
   但没有对着真实模型与真实 QQ 跑过完整一轮。
