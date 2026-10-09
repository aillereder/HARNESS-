/**
 * 把 dsh-composite 装进一个 DSH profile。
 *
 * ## 为什么要有这个脚本而不是敲一条命令
 *
 * 官方路径 `dsh plugin --profile <p> add file:<dir>` 会把操作转发给 **pnpm**。
 * 本机实测 pnpm 未安装（`'pnpm' 不是内部或外部命令`），而且 Windows 上
 * `npm.ps1` / `dsh.ps1` 被执行策略禁止 —— 所以官方路径在这里直接不可用。
 *
 * 本脚本走的是**确定性路径**：直接改 profile 清单的两处
 * （`dependencies` + `dsh.profile.bundles`），再把包镜像进 `node_modules`。
 * 这正是 pnpm 成功那些次所产生的结果，且不依赖任何外部工具。
 *
 * ## 用法
 *
 *   node scripts/install-web-profile.mjs --dry-run     # 只读：看它会做什么
 *   node scripts/install-web-profile.mjs               # 真装（默认 profile: web）
 *   node scripts/install-web-profile.mjs --rollback    # 用备份还原
 *
 * 装完**必须重启 dsh web** —— bundle 变更只在启动期合成，
 * `patchReload: live` 只热重载 patch 文件本身。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-composite'
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const argv = process.argv.slice(2)
const has = (flag) => argv.indexOf(flag) >= 0
const value = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt
}

const DRY = has('--dry-run')
const ROLLBACK = has('--rollback')
const PROFILE = value('--profile', 'web')
const HOME = value('--home', process.env.DSH_HOME && process.env.DSH_HOME.length > 0
  ? process.env.DSH_HOME
  : path.join(os.homedir(), '.dsh'))

const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE)
const PROFILE_PKG = path.join(PROFILE_DIR, 'package.json')
const MIRROR_DIR = path.join(PROFILE_DIR, 'node_modules', PACKAGE_NAME)
const BACKUP_PKG = PROFILE_PKG + '.bak-composite'

const say = (s) => console.log(s)

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// ── 回滚 ────────────────────────────────────────────────────────────────────
if (ROLLBACK) {
  let did = 0
  if (fs.existsSync(BACKUP_PKG)) {
    fs.copyFileSync(BACKUP_PKG, PROFILE_PKG)
    say('已还原 profile package.json')
    did += 1
  }
  if (fs.existsSync(MIRROR_DIR)) {
    fs.rmSync(MIRROR_DIR, { recursive: true, force: true })
    say('已移除 ' + MIRROR_DIR)
    did += 1
  }
  const presetDst = path.join(HOME, '.agent-presets', 'composite')
  const presetBak = presetDst + '.bak-composite'
  if (fs.existsSync(presetBak)) {
    if (fs.existsSync(presetDst)) fs.rmSync(presetDst, { recursive: true, force: true })
    fs.renameSync(presetBak, presetDst)
    say('已还原预设')
    did += 1
  } else if (fs.existsSync(presetDst)) {
    fs.rmSync(presetDst, { recursive: true, force: true })
    say('已移除预设')
    did += 1
  }
  if (did === 0) {
    say('没有可还原的东西')
    process.exit(1)
  }
  say('仍需**重启 dsh web** 才生效。')
  process.exit(0)
}

// ── 前置检查 ────────────────────────────────────────────────────────────────
say('目标 profile：' + PROFILE_DIR)
if (!fs.existsSync(PROFILE_PKG)) {
  say('❌ 找不到 profile package.json —— profile 名或 --home 不对')
  process.exit(1)
}
for (const rel of ['lib/index.js', 'cordis.patch.yml']) {
  const p = path.join(root, rel)
  if (!fs.existsSync(p)) {
    say('❌ 缺文件：' + p)
    process.exit(1)
  }
}

const before = readJson(PROFILE_PKG)
say('现有 bundles：' + JSON.stringify(before.dsh && before.dsh.profile ? before.dsh.profile.bundles : []))
if (before.dsh && before.dsh.profile && Array.isArray(before.dsh.profile.bundles)
  && before.dsh.profile.bundles.indexOf(PACKAGE_NAME) >= 0) {
  say('⚠️  已经装过了 —— 这次相当于重装')
}

if (DRY) {
  say('')
  say('（--dry-run：没有改动任何文件）')
  say('真装会做：')
  say('  1. 备份 profile/package.json → package.json.bak-composite')
  say('  2. dependencies["' + PACKAGE_NAME + '"] = "file:' + root.replace(/\\/g, '/') + '"')
  say('  3. dsh.profile.bundles 追加 "' + PACKAGE_NAME + '"')
  say('  4. 把包镜像到 ' + MIRROR_DIR)
  process.exit(0)
}

// ── 备份 ────────────────────────────────────────────────────────────────────
fs.copyFileSync(PROFILE_PKG, BACKUP_PKG)
say('✅ 已备份 → ' + BACKUP_PKG)

// ── 改清单 ──────────────────────────────────────────────────────────────────
const pkg = readJson(PROFILE_PKG)
pkg.dependencies = pkg.dependencies === undefined || pkg.dependencies === null ? {} : pkg.dependencies
pkg.dependencies[PACKAGE_NAME] = 'file:' + root.replace(/\\/g, '/')
pkg.dsh = pkg.dsh === undefined || pkg.dsh === null ? {} : pkg.dsh
pkg.dsh.profile = pkg.dsh.profile === undefined || pkg.dsh.profile === null ? {} : pkg.dsh.profile
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (bundles.indexOf(PACKAGE_NAME) < 0) bundles.push(PACKAGE_NAME)
pkg.dsh.profile.bundles = bundles
fs.writeFileSync(PROFILE_PKG, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
say('✅ 已写入 dependencies + bundles')

// ── 镜像 ────────────────────────────────────────────────────────────────────
function copyInto(src, dst) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const entry of fs.readdirSync(src)) {
      copyInto(path.join(src, entry), path.join(dst, entry))
    }
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    fs.copyFileSync(src, dst)
  }
}

if (fs.existsSync(MIRROR_DIR)) fs.rmSync(MIRROR_DIR, { recursive: true, force: true })
fs.mkdirSync(MIRROR_DIR, { recursive: true })
for (const rel of ['lib', 'preset', 'cordis.patch.yml', 'package.json']) {
  const src = path.join(root, rel)
  if (!fs.existsSync(src)) continue
  copyInto(src, path.join(MIRROR_DIR, rel))
}
say('✅ 已镜像到 ' + MIRROR_DIR)

// ── 预设 ────────────────────────────────────────────────────────────────────
//
// 预设必须单独装到 `$DSH_HOME/.agent-presets/<id>/`：
// 0.1.5-rc.2 只认目录形态（0.1.7-rc.2 起官方改为在 bundle 里声明，
// 那时这段要改成随包发布的第二条 bundle patch）。
//
// 少了这一步，插件装上了但**选择器里没有人设** —— 那是"装了但用不了"。
const PRESET_ID = 'composite'
const PRESET_SRC = path.join(root, 'preset')
const PRESET_DST = path.join(HOME, '.agent-presets', PRESET_ID)
const PRESET_BACKUP = PRESET_DST + '.bak-composite'

if (fs.existsSync(PRESET_SRC)) {
  if (fs.existsSync(PRESET_DST) && !fs.existsSync(PRESET_BACKUP)) {
    copyInto(PRESET_DST, PRESET_BACKUP)
    say('✅ 已备份原预设 → ' + PRESET_BACKUP)
  }
  if (fs.existsSync(PRESET_DST)) fs.rmSync(PRESET_DST, { recursive: true, force: true })
  copyInto(PRESET_SRC, PRESET_DST)
  // 目录形态要求文件名是 `agent.cordis.yml`（预设目录不必叫 preset.yml，但元数据要）
  say('✅ 预设已装到 ' + PRESET_DST)
} else {
  say('⚠️  包里没有 preset/ 目录，跳过预设安装（选择器里不会出现人设）')
}

// ── 自校验（静态部分）──────────────────────────────────────────────────────
const after = readJson(PROFILE_PKG)
const okDep = after.dependencies[PACKAGE_NAME] !== undefined
const okBundle = after.dsh.profile.bundles.indexOf(PACKAGE_NAME) >= 0
const okMirror = fs.existsSync(path.join(MIRROR_DIR, 'lib', 'index.js'))
const okPatch = fs.existsSync(path.join(MIRROR_DIR, 'cordis.patch.yml'))
const okPresetAgent = fs.existsSync(path.join(PRESET_DST, 'agent.cordis.yml'))
const okPresetMeta = fs.existsSync(path.join(PRESET_DST, 'preset.yml'))
say('')
say('自校验：')
say('  profile dependencies  = ' + okDep)
say('  profile bundles       = ' + okBundle)
say('  包镜像                = ' + okMirror)
say('  bundle patch          = ' + okPatch)
say('  预设 agent.cordis.yml = ' + okPresetAgent)
say('  预设 preset.yml       = ' + okPresetMeta)
if (!(okDep && okBundle && okMirror && okPatch && okPresetAgent && okPresetMeta)) {
  say('❌ 自校验失败 —— 用 --rollback 还原')
  process.exit(1)
}

say('')
say('════════════════════════════════════════════════════')
say('装好了。**现在必须重启 dsh web 才生效。**')
say('')
say('为什么必须重启：bundle 变更只在启动期合成，')
say('patchReload: live 只热重载 patch 文件本身。')
say('')
say('重启后验证：')
say('  1. 新建会话 → 选择器里出现「复合体」')
say('  2. 会话里出现状态行（【当前状态】心情 x/10、精力 x/10…）')
say('  3. 若开了 NapCat：QQ 收发可用')
say('')
say('出问题回滚：')
say('  node ' + path.relative(process.cwd(), fileURLToPath(import.meta.url)) + ' --rollback')
say('════════════════════════════════════════════════════')
