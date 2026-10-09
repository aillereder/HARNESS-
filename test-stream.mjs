// 阶段 2 验证：lib/stream.js 的实时分句与发送节奏。
//
// 最重要的不变量是**拼回去等于原文** —— 分段丢字或重复都是聊天里的致命 bug，
// 而且这种 bug 在人工试聊时很难发现（少一个字通常看不出来）。

import {
  JITTER_SECONDS, MAX_SEGMENTS, Segmenter, intervalFor, takeSegment, wordCount,
} from './lib/stream.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const NO_JITTER = () => 0

// ── 1. 首段零延迟：这是"秒回"的全部来源 ──────────────────────────────────
{
  const s = new Segmenter()
  s.push('我在呢，刚才在整理东西。还有别的事吗？')
  const first = s.pull(NO_JITTER)
  ok('首段存在', first !== null)
  ok('首段 delayMs === 0（零延迟）', first !== null && first.delayMs === 0,
    first === null ? 'null' : String(first.delayMs))
  ok('首段 isFirst === true', first !== null && first.isFirst === true)
  ok('首段按句末切成整句', first !== null && first.text === '我在呢，刚才在整理东西。', first === null ? '' : first.text)

  // 第二句只有 7 字（低于非首段下限）→ 生成未结束时正确地"再等等"，
  // 所以这里必须 finish() 之后才拉得到它，且走间隔（非零延迟）。
  s.finish()
  const second = s.pull(NO_JITTER)
  ok('第二段（非首段）delayMs > 0（按间隔）', second !== null && second.delayMs > 0,
    second === null ? 'null' : String(second.delayMs))
  ok('第二段内容正确', second !== null && second.text === '还有别的事吗？',
    second === null ? 'null' : second.text)
}

// ── 2. 间隔随段长递增（对数）──────────────────────────────────────────────
{
  const short = intervalFor('好的。', NO_JITTER)
  const mid = intervalFor('行吧，那就按你说的来，我这边先准备一下。', NO_JITTER)
  const long = intervalFor('这一段明显更长一些，用来验证间隔是不是随着段内字数增加而变长，应该看得出来差别。', NO_JITTER)
  ok('间隔随段长递增', short < mid && mid < long,
    short.toFixed(2) + ' < ' + mid.toFixed(2) + ' < ' + long.toFixed(2))
  ok('短段间隔 >= 1.2s（公式下限）', short >= 1.2 && short <= 3.0, short.toFixed(2))
  ok('长段间隔在 3.0~5.5s', long >= 3.0 && long <= 5.5, long.toFixed(2))
}

// ── 3. 绝不在逗号切 ───────────────────────────────────────────────────────
{
  const s = new Segmenter()
  s.push('嗯，我觉得吧，这事，')
  const got = s.pull(NO_JITTER)
  ok('只有逗号时不切（返回 null）', got === null, got === null ? '' : got.text)
}

// ── 4. 拼回去等于原文（关键不变量）────────────────────────────────────────
{
  const original = '第一句。第二句更长一些，带个逗号。第三句！第四句问一下？最后收个尾。'
  const s = new Segmenter()
  // 模拟逐块推送（真实流式是碎片化的）
  for (let i = 0; i < original.length; i += 3) s.push(original.slice(i, i + 3))
  s.finish()
  const segs = s.drain(NO_JITTER)
  const joined = segs.map((x) => x.text).join('')
  ok('分段拼回等于原文', joined === original,
    'joined=' + JSON.stringify(joined) + ' original=' + JSON.stringify(original))
  ok('段数 > 1（确实分了段）', segs.length > 1, String(segs.length))
}

// ── 5. 长段不切：超过阈值整段发（切碎更假）──────────────────────────────
{
  const long = '这一句故意写得很长。'.repeat(15) // 165 字，超过 NO_SPLIT_OVER
  const got = takeSegment(long, true, false)
  ok('超过不切阈值时整段发出', got !== null && got.rest === '',
    got === null ? 'null' : 'rest.length=' + got.rest.length + ' text.length=' + got.text.length)
  ok('该串长度确实超过不切阈值', long.length > 120, String(long.length))
}

// ── 6. 代码块不切 ─────────────────────────────────────────────────────────
{
  const s = new Segmenter()
  s.push('看这个：\n```js\nconst a = 1;\n```\n好了。')
  const got = s.pull(NO_JITTER)
  ok('含代码块时不切（等结束或长大）', got === null, got === null ? '' : got.text)
  s.finish()
  const drained = s.drain(NO_JITTER)
  ok('结束后代码块整段发出', drained.length >= 1 && drained.map((x) => x.text).join('').indexOf('const a = 1;') >= 0)
}

// ── 7. 每轮段数上限 ───────────────────────────────────────────────────────
{
  const s = new Segmenter()
  s.push('一。二。三。四。五。六。七。八。九。十。')
  s.finish()
  const segs = s.drain(NO_JITTER)
  ok('段数不超过 MAX_SEGMENTS', segs.length <= MAX_SEGMENTS, String(segs.length))
}

// ── 8. 互斥的两种方向（少话 / 重复，是相反的 bug）─────────────────────────
{
  const s = new Segmenter()
  ok('初始：既没发过也没发完', s.anySent() === false && s.alreadySentComplete() === false)
  s.push('这一句够长了，可以被发出去。还有后半句。')
  const firstPull = s.pull(NO_JITTER)
  ok('首段确实发出（供互斥断言用）', firstPull !== null, firstPull === null ? 'null' : firstPull.text)
  // 关键：只发了一部分时，**不能**说"完整发过" —— 否则残余被永久丢弃（少话）
  ok('只发了一部分：anySent=true 但 alreadySentComplete=false',
    s.anySent() === true && s.alreadySentComplete() === false,
    'anySent=' + s.anySent() + ' complete=' + s.alreadySentComplete())
}

// ── 12. 互斥的另一个方向：完整发完之后不许终局再发一遍（重复回复）─────────
{
  const s = new Segmenter()
  s.push('第一句。第二句。第三句。')
  s.finish()
  s.drain(NO_JITTER)
  ok('全部分段发完后 alreadySentComplete=true（宿主据此跳过终局发送，防重复）',
    s.alreadySentComplete() === true)
  ok('已发文本拼回等于原文（没有重复段）',
    s.sentTexts.join('') === '第一句。第二句。第三句。',
    JSON.stringify(s.sentTexts))
}

// ── 9. 生成结束：不丢尾，也不吞掉完整句子 ────────────────────────────────
{
  // 半句话（无句末标点）→ 回填进上一段，不单独发。
  // 注意首句必须够长（>= FIRST_MIN_CHARS），否则第一段本身就不该发。
  const s = new Segmenter()
  s.push('开头这一句必须足够长才能发出去。尾')
  const firstSeg = s.pull(NO_JITTER)
  s.finish()
  s.drain(NO_JITTER)
  const all = s.sentTexts.join('')
  ok('半句话被回填：拼回完整', all === '开头这一句必须足够长才能发出去。尾', JSON.stringify(all))
  ok('半句话不单独成段（而是并进上一段）',
    firstSeg !== null && firstSeg.text === '开头这一句必须足够长才能发出去。尾',
    firstSeg === null ? 'null' : JSON.stringify(firstSeg.text))

  // 完整句子（有句末标点）→ 必须单独发，不能并进上一段
  const s2 = new Segmenter()
  s2.push('第一句够长了。还有别的事吗？')
  s2.pull(NO_JITTER)
  s2.finish()
  s2.drain(NO_JITTER)
  ok('尾部完整短句单独成段（不被吞）',
    s2.sentTexts.length === 2 && s2.sentTexts[1] === '还有别的事吗？',
    JSON.stringify(s2.sentTexts))
  ok('完整句子场景拼回也等于原文',
    s2.sentTexts.join('') === '第一句够长了。还有别的事吗？', JSON.stringify(s2.sentTexts))
}

// ── 10. wordCount 对中英文都合理 ─────────────────────────────────────────
{
  ok('中文按字计（去空白）', wordCount('你好 世界') === 4, String(wordCount('你好 世界')))
  ok('英文按词计', wordCount('hello world foo') === 3, String(wordCount('hello world foo')))
  ok('空串为 0', wordCount('') === 0)
}

// ── 11. 空输入不产生空段 ─────────────────────────────────────────────────
{
  const s = new Segmenter()
  s.finish()
  const segs = s.drain(NO_JITTER)
  ok('无内容时不发出任何段', segs.length === 0, String(segs.length))
  const s2 = new Segmenter()
  s2.push('   ')
  s2.finish()
  ok('纯空白也会作为残余发出（由宿主侧决定是否过滤）', s2.drain(NO_JITTER).length === 1)
}

// ── 12. 抖动只影响 0~JITTER_SECONDS，不失控 ──────────────────────────────
{
  const a = intervalFor('测试一句话看看抖动范围。', () => 0)
  const b = intervalFor('测试一句话看看抖动范围。', () => 1)
  ok('抖动幅度等于 JITTER_SECONDS', Math.abs((b - a) - JITTER_SECONDS) < 1e-9,
    (b - a).toFixed(6) + ' expect ' + JITTER_SECONDS)
}

console.log('\nstream 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
