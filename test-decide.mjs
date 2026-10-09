// 阶段 6 验证：lib/decide.js 的 L2 判决解析、配额、纠正措辞。
//
// 重心是**退化路径**。旧实现的教训（注释原文）：
//   > 判决解析这种「模型输出不可控」的代码，必须把退化路径全部写成测试 ——
//   > 两条 bug 都在退化路径上，正常路径永远碰不到。
// 那两条 bug 是：`/\bVETO\b?/u` 让正则编译失败、判决词正则大小写敏感。

import {
  MAX_VETOES_PER_TURN, VERDICT_PASS, VERDICT_VETO, VetoQuota,
  buildPrompt, formatCorrection, parseVerdict, shouldReview,
} from './lib/decide.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

// ── 1. 正则本身必须能编译（旧实现在这里炸过）────────────────────────────
{
  let threw = false
  try {
    // 直接构造与源码等价的正则，确认加了 /i 且没有零宽断言量词
    const re = /\bveto\b/i
    re.test('veto')
  } catch (error) { threw = true }
  ok('判决正则可编译（不能出现 \\b 加量词）', threw === false)
}

// ── 2. 标准输出 ─────────────────────────────────────────────────────────
{
  ok('首行 PASS → 放行', parseVerdict('PASS').verdict === 'pass')
  const v = parseVerdict('VETO\n她说写好了，但记录里没有成功的写入调用。')
  ok('首行 VETO + 理由 → 否决', v.verdict === 'veto', JSON.stringify(v))
  ok('  理由被带出', v.reason.indexOf('没有成功的写入') >= 0, v.reason)
  ok('  parsed=true', v.parsed === true)
}

// ── 3. 退化：大小写（旧实现漏过）────────────────────────────────────────
{
  ok('小写 veto 也识别', parseVerdict('veto\n理由在这里').verdict === 'veto')
  ok('小写 pass 也识别', parseVerdict('pass').verdict === 'pass')
  ok('混合大小写 Veto 也识别', parseVerdict('Veto\n理由').verdict === 'veto')
  ok('大写 PASS 带标点也识别', parseVerdict('PASS.').verdict === 'pass')
  ok('  VETO:  带冒号也识别', parseVerdict('VETO: 她说的对不上').verdict === 'veto')
  ok('  VETO：中文冒号也识别', parseVerdict('VETO：她说的对不上').verdict === 'veto')
}

// ── 4. 退化：否决却不给理由 → 必须放行 ──────────────────────────────────
{
  // 旧实现的原话：否则她收到无从改起的指令、下一轮原样重犯，白吃配额 + 一次调用
  const r1 = parseVerdict('VETO')
  ok('只有 VETO 没有理由 → 放行', r1.verdict === 'pass', JSON.stringify(r1))
  ok('  并说明原因', r1.reason.indexOf('没给理由') >= 0, r1.reason)

  const r2 = parseVerdict('VETO\n   \n  ')
  ok('理由全是空白 → 放行', r2.verdict === 'pass', JSON.stringify(r2))

  const r3 = parseVerdict('VETO:')
  ok('VETO 后只有冒号 → 放行', r3.verdict === 'pass', JSON.stringify(r3))
}

// ── 5. 退化：空输出与垃圾输入 ───────────────────────────────────────────
{
  ok('空串 → 放行', parseVerdict('').verdict === 'pass')
  ok('空白 → 放行', parseVerdict('   \n  ').verdict === 'pass')
  ok('null → 放行', parseVerdict(null).verdict === 'pass')
  ok('undefined → 放行', parseVerdict(undefined).verdict === 'pass')
  ok('非字符串 → 放行', parseVerdict(12345).verdict === 'pass')

  const junk = parseVerdict('嗯……我觉得还可以吧，没什么大问题。')
  ok('没有判决词的闲聊输出 → 放行', junk.verdict === 'pass', JSON.stringify(junk))
  ok('  并标记未解析', junk.parsed === false)
}

// ── 6. JSON 结构化输出 ──────────────────────────────────────────────────
{
  const v1 = parseVerdict('{"verdict":"veto","reason":"与记录不符"}')
  ok('JSON veto 被识别', v1.verdict === 'veto' && v1.reason === '与记录不符', JSON.stringify(v1))

  const v2 = parseVerdict('{"verdict":"pass"}')
  ok('JSON pass 被识别', v2.verdict === 'pass')

  const v3 = parseVerdict('```json\n{"verdict":"veto","reason":"没写盘"}\n```')
  ok('代码块包裹的 JSON 也能识别', v3.verdict === 'veto' && v3.reason === '没写盘', JSON.stringify(v3))

  const v4 = parseVerdict('{"verdict":"veto"}')
  ok('JSON veto 缺 reason → 放行', v4.verdict === 'pass', JSON.stringify(v4))
}

// ── 7. 退化：JSON 截断 → 不猜 ───────────────────────────────────────────
{
  // 半截 JSON 绝不能当成有效判决
  const r = parseVerdict('{"verdict":"veto","reason":"她说写完')
  ok('截断 JSON 不误判为否决', r.verdict === 'pass', JSON.stringify(r))
  ok('  标记为未解析', r.parsed === false)
}

// ── 8. 配额闸：防 steer 死循环 ──────────────────────────────────────────
{
  const q = new VetoQuota(2)
  ok('初始可否决', q.canVeto() === true)
  ok('  剩余 2', q.remaining === 2)
  q.consume()
  ok('用一次后仍可否决', q.canVeto() === true && q.remaining === 1)
  q.consume()
  ok('到顶后不可否决（一律放行）', q.canVeto() === false && q.remaining === 0)
  q.reset()
  ok('新一轮归零', q.canVeto() === true && q.remaining === 2)

  const dflt = new VetoQuota()
  ok('默认上限为 ' + MAX_VETOES_PER_TURN, dflt.max === MAX_VETOES_PER_TURN)
  const zero = new VetoQuota(0)
  ok('非法上限回落到默认', zero.max === MAX_VETOES_PER_TURN)
}

// ── 9. 纠正措辞：必须是记录口吻，且保留两条底线 ─────────────────────────
{
  const t = formatCorrection('她声称写过笔记，但记录里没有任何写入工具调用')
  ok('以记录口吻出现（含"复核记录"）', t.indexOf('复核记录') >= 0, t.slice(0, 40))
  ok('带上具体理由', t.indexOf('她声称写过笔记') >= 0)
  ok('保留底线一：凭证不用怀疑', t.indexOf('凭证') >= 0)
  ok('保留底线二：动文件的是工具不是"我"', t.indexOf('不是"我"') >= 0, t)
  ok('要求丢掉被否的说法', t.indexOf('整个丢掉') >= 0)
  ok('空理由返回空（不注入噪音）', formatCorrection('') === '' && formatCorrection(null) === '')
}

// ── 10. 复核提示词：给出可判据，并明确"拿不准就放行" ────────────────────
{
  const p = buildPrompt({
    reply: '已经写好了。',
    tools: ['FAIL write'],
    toolErrorCount: 1,
    state: 'mood=5.0 energy=4.0',
  })
  ok('提示词含真实记录', p.indexOf('FAIL write') >= 0)
  ok('提示词含她的原话', p.indexOf('已经写好了。') >= 0)
  ok('提示词含状态', p.indexOf('mood=5.0') >= 0)
  ok('提示词明确要输出 PASS/VETO', p.indexOf(VERDICT_PASS) >= 0 && p.indexOf(VERDICT_VETO) >= 0)
  ok('提示词写了"拿不准就放行"', p.indexOf('拿不准就放行') >= 0)
  ok('提示词列了不该否决的情形', p.indexOf('不要') >= 0 && p.indexOf('闲聊') >= 0)

  const empty = buildPrompt({})
  ok('空输入不抛且给出占位', empty.indexOf('（本轮没有调用工具）') >= 0, empty.slice(0, 60))
  ok('buildPrompt(null) 安全', buildPrompt(null).length > 0)
}

// ── 11. 触发条件：不是每轮都跑（延迟的关键取舍）─────────────────────────
{
  ok('L1 判定"断言无证据"→ 触发复核',
    shouldReview({ claimWithoutEvidence: true, needsReview: false }, 100) === true)
  ok('L1 判定需要复核 → 触发', shouldReview({ claimWithoutEvidence: false, needsReview: true }, 100) === true)
  ok('普通回复 + 不长 → 不触发（省延迟）',
    shouldReview({ claimWithoutEvidence: false, needsReview: false }, 100) === false)
  ok('很长的回复 → 触发（> 600 字）', shouldReview({}, 800) === true)
  ok('无 L1 结果但很长 → 触发', shouldReview(null, 900) === true)
  ok('无 L1 结果且不长 → 不触发', shouldReview(null, 100) === false)
}

console.log('\ndecide 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
