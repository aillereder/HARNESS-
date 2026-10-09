// 阶段 2b 验证：lib/filter.js 的 L1 前置过滤。
//
// 测试的重心是**反例（不误报）**。误报会让她莫名其妙地不说话，
// 而那是比"漏掉一次撒谎"更糟的体验 —— 所以反例比正例更重要。

import {
  REPLY_TOO_LONG, hasCompletionClaim, isWriteTool, lint, reviewInput, sendStrategy,
} from './lib/filter.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

// ── 1. 写入类工具的识别 ───────────────────────────────────────────────────
{
  ok('write 是写入类', isWriteTool('write') === true)
  ok('memory_save 是写入类', isWriteTool('memory_save') === true)
  ok('read 不是写入类', isWriteTool('read') === false)
  ok('web_search 不是写入类', isWriteTool('web_search') === false)
  ok('空名安全', isWriteTool('') === false)
  ok('非字符串安全', isWriteTool(undefined) === false)
}

// ── 2. 断言识别 ───────────────────────────────────────────────────────────
{
  ok('识别"已经写好了"', hasCompletionClaim('已经写好了，你看下。') === true)
  ok('识别"搞定了"', hasCompletionClaim('搞定了。') === true)
  ok('识别"我记下了"', hasCompletionClaim('我记下了。') === true)
  ok('识别英文 done', hasCompletionClaim('All done!') === true)
  ok('普通陈述不算断言', hasCompletionClaim('这个文件里有一段配置。') === false)
  ok('未来时不算断言', hasCompletionClaim('我准备去写一下。') === false)
}

// ── 3. 核心判据：声称完成而无证据 ─────────────────────────────────────────
{
  const record = {
    tools: [
      { name: 'read', isError: false },
      { name: 'write', isError: true },
    ],
    toolErrorCount: 1,
  }
  const r = lint('已经写好了，你放心。', record)
  ok('声称完成 + 写入失败 → 打标', r.block === true, JSON.stringify(r.reasons))
  ok('  且判为"断言无证据"', r.claimWithoutEvidence === true)
  ok('  且需要 L2 复核', r.needsReview === true)
  ok('  且建议单条发送（缩小爆炸半径）', sendStrategy(r) === 'single')
}

// ── 4. 正例：有证据的声称不误报 ───────────────────────────────────────────
{
  const record = {
    tools: [
      { name: 'memory_save', isError: false },
    ],
    toolErrorCount: 0,
  }
  const r = lint('已经记好了。', record)
  ok('写入成功 + 声称完成 → 不打标', r.block === false, JSON.stringify(r.reasons))
  ok('  且继续分段发送', sendStrategy(r) === 'segmented')
}

// ── 5. 关键反例：普通 read 失败不该让她闭嘴 ───────────────────────────────
{
  const record = {
    tools: [{ name: 'read', isError: true }],
    toolErrorCount: 1,
  }
  const r = lint('那个文件不存在，你要不要确认一下路径？', record)
  ok('工具失败但没声称完成 → 不打标', r.block === false, JSON.stringify(r.reasons))
}

// ── 6. 反例：失败后如实说明，也不算撒谎 ───────────────────────────────────
{
  const record = {
    tools: [{ name: 'write', isError: true }],
    toolErrorCount: 1,
  }
  const r = lint('写入失败了，我再试一次。', record)
  ok('如实说明失败 → 不打标', r.block === false, JSON.stringify(r.reasons))
}

// ── 7. 反例：纯闲聊不触发 ─────────────────────────────────────────────────
{
  const r = lint('在呢，刚吃完饭。你今天怎么样？', { tools: [], toolErrorCount: 0 })
  ok('纯闲聊不打标', r.block === false, JSON.stringify(r.reasons))
  ok('  且不需要复核', r.needsReview === false)
}

// ── 8. 过长与截断 ─────────────────────────────────────────────────────────
{
  const long = '啊'.repeat(REPLY_TOO_LONG + 10)
  const r1 = lint(long, { tools: [], toolErrorCount: 0 })
  ok('过长打标', r1.block === true && r1.reasons.indexOf('too-long') >= 0, JSON.stringify(r1.reasons))

  const r2 = lint('这是一段正常长度的回复。', { tools: [], toolErrorCount: 0, truncated: true })
  ok('截断打标', r2.block === true && r2.reasons.indexOf('truncated') >= 0, JSON.stringify(r2.reasons))

  const r3 = lint('', { tools: [], toolErrorCount: 0 })
  ok('空回复打标', r3.block === true && r3.reasons.indexOf('empty') >= 0, JSON.stringify(r3.reasons))
}

// ── 9. 长的正常回复值得复核，但不打标 ─────────────────────────────────────
{
  const medium = '一个字。'.repeat(200) // 800 字，未过长
  const r = lint(medium, { tools: [], toolErrorCount: 0 })
  ok('800 字正常回复不打标', r.block === false, JSON.stringify(r.reasons))
  ok('  但值得 L2 复核（> 600 字）', r.needsReview === true)
}

// ── 10. 容错：畸形输入不抛 ────────────────────────────────────────────────
{
  let threw = false
  try {
    lint(undefined, undefined)
    lint(null, null, null)
    lint('x', { tools: [null, undefined] })
    lint('x', { tools: 'not-an-array' })
    lint(123, { toolErrorCount: 'x' })
  } catch (error) { threw = true }
  ok('畸形输入不抛异常', threw === false)
}

// ── 11. reviewInput 只输出扁平纯数据（不夹带 live 对象）──────────────────
{
  const rec = {
    tools: [{ name: 'write', isError: true }, { name: 'read', isError: false }],
    toolErrorCount: 1,
  }
  const ri = reviewInput('已经写好了。', rec, 'mood=6.0 energy=5.2')
  ok('reviewInput.reply 是字符串', typeof ri.reply === 'string')
  ok('reviewInput.tools 是字符串数组', Array.isArray(ri.tools) && typeof ri.tools[0] === 'string')
  ok('  失败项带 FAIL 前缀', ri.tools[0] === 'FAIL write', ri.tools[0])
  ok('  state 原样带入', ri.state === 'mood=6.0 energy=5.2')
  ok('不夹带原对象', typeof ri === 'object' && ri !== rec)
}

// ── 12. 工具名大小写不敏感 ────────────────────────────────────────────────
{
  ok('Write 也识别为写入类', isWriteTool('Write') === true)
  ok('MEMORY_SAVE 也识别', isWriteTool('MEMORY_SAVE') === true)
}

console.log('\nfilter 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
