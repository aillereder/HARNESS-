// 总测试入口：依次跑各套纯逻辑测试，任一失败即整体失败。
//
// 为什么要有它：这些测试是**唯一的回归防线**。开发过程中它们抓出了
// 十几个真 bug（分段永不触发、整句丢失、残余被误拦、burst 无限增长、
// 记忆泄漏、包含规则误判、心跳永不触发…），其中多数人工试聊根本看不出来。
//
// 纪律（来自 dsh-herta 的教训）：测试的 mock 必须**照抄类型定义/真实形状**。
// 曾经有过"单测 mock 用了错的字段形状，24 项全绿而真实会话 100% 失败"
// —— 同错互证的绿色测试比没有测试更危险。

import { spawnSync } from 'node:child_process'

const SUITES = [
  'test-state.mjs',
  'test-tuning.mjs',
  'test-stream.mjs',
  'test-filter.mjs',
  'test-memory.mjs',
  'test-followup.mjs',
  'test-onebot.mjs',
  'test-ws-frame.mjs',
  'test-decide.mjs',
  'test-observe.mjs',
  'test-heartbeat.mjs',
  'test-apply.mjs',
  'test/test-e2e.mjs',
]

let failed = 0
const results = []

for (const suite of SUITES) {
  const r = spawnSync(process.execPath, [suite], { encoding: 'utf8' })
  const out = (r.stdout || '') + (r.stderr || '')
  const lines = out.split('\n').filter((l) => l.trim().length > 0)
  const summary = lines.length > 0 ? lines[lines.length - 1] : '(no output)'
  const ok = r.status === 0
  if (!ok) failed += 1
  results.push({ suite: suite, ok: ok, summary: summary })
  console.log((ok ? '  OK   ' : '  FAIL ') + suite.padEnd(20) + summary)
  if (!ok) {
    // 失败时把该套的 FAIL 行也打出来，省得再去单跑一次
    for (const line of lines) {
      if (line.indexOf('FAIL') === 0) console.log('         ' + line)
    }
  }
}

console.log('')
if (failed === 0) {
  console.log('all passed: ' + SUITES.length + ' suites')
} else {
  console.log('failed: ' + failed + ' / ' + SUITES.length + ' suites')
}
process.exit(failed === 0 ? 0 : 1)
