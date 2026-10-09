// 阶段 3 验证：lib/memory.js 的隔离、归一、召回。
//
// 重心是**隔离（不泄漏）**。旧实现只有单一 peer 键，私聊里说的个人信息
// 会跟着进群聊提示词 —— 那是最不可挽回的一类错误，所以断言写得最狠。

import {
  EMBED_BUDGET_CHARS, AliasTable, MemoryStore, isSameStatement, score, scopeKey, terms, visibleTo,
} from './lib/memory.js'

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name) }
  else { fail += 1; console.log('FAIL  ' + name + (detail === undefined ? '' : '  -> ' + detail)) }
}

const T0 = 1_800_000_000_000
const QQ = 'napcat'
const me = { platform: QQ, peer: '1802352763' }
const groupA = { platform: QQ, group: '999', sender: '1802352763' }
const groupB = { platform: QQ, group: '888', sender: '1802352763' }
const other = { platform: QQ, peer: '1666666666' }
const dshSide = { platform: 'dsh', peer: 'session-abc' }

function store() {
  return new MemoryStore({ now: () => T0 })
}

// ── 1. 作用域键 ───────────────────────────────────────────────────────────
{
  ok('私聊键含 peer', scopeKey(me) === 'napcat|private:1802352763', scopeKey(me))
  ok('群聊键含 group', scopeKey(groupA) === 'napcat|group:999', scopeKey(groupA))
  ok('群聊与私聊键不同', scopeKey(groupA) !== scopeKey(me))
}

// ── 2. 隔离：私聊记忆绝不进群聊（最狠的断言）─────────────────────────────
{
  const s = store()
  s.write({ text: '他跟我说他其实不太想去那个聚会。', scope: me })
  ok('私聊本人可见', s.visible(me).length === 1)
  ok('同一人在群里时**不可见**（不能替他说出去）', s.visible(groupA).length === 0,
    JSON.stringify(s.visible(groupA)))
}

// ── 3. 隔离：别人的私聊不可见 ─────────────────────────────────────────────
{
  const s = store()
  s.write({ text: '他家猫叫豆豆。', scope: other })
  ok('别人私聊本人可见', s.visible(other).length === 1)
  ok('对谈者换成我 → 不可见', s.visible(me).length === 0)
}

// ── 4. 隔离：群记忆不跨群 ─────────────────────────────────────────────────
{
  const s = store()
  s.write({ text: '这个群里大家叫他老王。', scope: groupA })
  ok('A 群可见', s.visible(groupA).length === 1)
  ok('B 群不可见', s.visible(groupB).length === 0)
  ok('私聊也不可见（群里的称呼不外传）', s.visible(me).length === 0)
}

// ── 5. 隔离：跨平台不共享 ─────────────────────────────────────────────────
{
  const s = store()
  s.write({ text: 'QQ 里聊过的事。', scope: me })
  ok('DSH 会话看不到 QQ 记忆', s.visible(dshSide).length === 0)
}

// ── 6. visibleTo 直接断言（安全核心）─────────────────────────────────────
{
  const priv = { scope: me, text: 'x' }
  ok('私聊记录对同 peer 可见', visibleTo(priv, me) === true)
  ok('私聊记录对群读者不可见', visibleTo(priv, groupA) === false)
  ok('畸形输入安全', visibleTo(null, me) === false && visibleTo(priv, null) === false)
  ok('缺 scope 安全', visibleTo({ text: 'x' }, me) === false)
}

// ── 7. 去重：同作用域内不重复写 ───────────────────────────────────────────
{
  const s = store()
  const a = s.write({ text: '他喜欢喝冰美式。', scope: me })
  const b = s.write({ text: '他喜欢喝冰美式。', scope: me })
  ok('首次写入成功', a.added === true)
  ok('重复写入被拒', b.added === false && b.reason === 'duplicate', JSON.stringify(b))
  ok('库里只有一条', s.dump().length === 1)

  // 同内容、不同作用域 → 应当是两条（不同群的同一句话各留各的）
  const c = s.write({ text: '他喜欢喝冰美式。', scope: groupA })
  ok('不同作用域的同内容可各自保留', c.added === true && s.dump().length === 2)
}

// ── 8. 去重的短句规则（旧实现实测的那组变体）────────────────────────────
{
  ok('"滚" 与 "滚就滚" 判为同一句', isSameStatement('滚', '滚就滚') === true)
  ok('"哦" 与 "哦？" 判为同一句（标点先归一）', isSameStatement('哦', '哦？') === true)
  ok('"咋了" 与 "咋了？" 判为同一句', isSameStatement('咋了', '咋了？') === true)
  ok('两句正常承接不误判', isSameStatement('我觉得这事不对', '这事不对') === false)
  ok('无关两句话不判同', isSameStatement('今天天气不错', '晚饭吃什么') === false)
}

// ── 9. 别名归一 ───────────────────────────────────────────────────────────
{
  const al = new AliasTable()
  al.link('1802352763', ['Ailler', '小A', '1802352763'])
  ok('昵称归一到账号', al.resolve('Ailler') === '1802352763')
  ok('备注名归一到账号', al.resolve('小A') === '1802352763')
  ok('账号本身不变', al.resolve('1802352763') === '1802352763')
  ok('未登记的名字原样返回（不丢）', al.resolve('陌生人') === '陌生人')
}

// ── 10. 召回：词法命中与排序 ──────────────────────────────────────────────
{
  const s = store()
  s.write({ text: '他喜欢在深夜喝冰美式。', scope: me })
  s.write({ text: '他养了一只叫豆豆的猫。', scope: me })
  s.write({ text: '他下个月要去出差。', scope: me })

  const hit = s.recall(me, '咖啡 美式', 5)
  ok('按关键词召回命中', hit.length >= 1 && hit[0].text.indexOf('冰美式') >= 0,
    JSON.stringify(hit.map((r) => r.text)))
  ok('无关项不被召回', hit.every((r) => r.text.indexOf('猫') < 0),
    JSON.stringify(hit.map((r) => r.text)))
}

// ── 11. 召回遵守隔离 ─────────────────────────────────────────────────────
{
  const s = store()
  s.write({ text: '他私聊里说讨厌咖啡。', scope: me })
  const inGroup = s.recall(groupA, '咖啡', 5)
  ok('群里查"咖啡"召不到私聊那条', inGroup.length === 0, JSON.stringify(inGroup))
}

// ── 12. 嵌入：有硬预算，不一股脑灌 ───────────────────────────────────────
{
  const s = store()
  for (let i = 0; i < 40; i += 1) {
    s.write({ text: '这是第' + i + '条关于咖啡的记忆，用来把预算撑满。', scope: me })
  }
  const e = s.embed(me, '咖啡', 200)
  ok('嵌入遵守字符预算', e.chars <= 200, 'chars=' + e.chars)
  ok('嵌入不会全选', e.picked < 40, 'picked=' + e.picked)
  ok('嵌入文本非空', e.text.length > 0)
  ok('无相关记忆时嵌入为空', s.embed(me, '量子力学完全无关的词', 200).text === '')
}

// ── 13. 只读快照不可写 ───────────────────────────────────────────────────
{
  const s = store()
  s.write({ text: '他喜欢冰美式。', scope: me })
  const ro = s.readonly(me, '咖啡')
  ok('只读快照带 writable=false 标记', ro.writable === false)
  ok('只读快照是冻结的', Object.isFrozen(ro) === true)
  ok('texts 也是冻结的', Object.isFrozen(ro.texts) === true)
  ok('只读快照不含写入方法', typeof ro.write === 'undefined')
}

// ── 14. 容错 ─────────────────────────────────────────────────────────────
{
  const s = store()
  ok('load 畸形输入返回 0', s.load(null) === 0 && s.load([null, undefined, {}]) === 0)
  ok('write 空文本被拒', s.write({ text: '   ', scope: me }).added === false)
  ok('write 缺 scope 被拒', s.write({ text: 'x' }).added === false)
  ok('terms 空输入安全', Object.keys(terms('')).length === 0 && Object.keys(terms(null)).length === 0)
  ok('score 空 query 为 0', score('x', {}) === 0)
}

console.log('\nmemory 测试：' + pass + ' 通过 / ' + fail + ' 失败')
process.exit(fail === 0 ? 0 : 1)
