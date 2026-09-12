/**
 * CallMeter 的本地单元测试（直接跑编译产物 lib/meter.js，无宿主依赖）。
 *
 * 计量是「理论调用次数」的唯一依据，所以逐条钉住它的语义：
 *   1. 样本不足时不给估算（不许编造单价）；
 *   2. 额度下降 + 区间内有调用 → 归因；
 *   3. 区间内没有调用（外部 cmd CLI 用量）→ **不归因**，否则单次成本被抬高；
 *   4. 额度上升（账单重置/购买）→ 不计消耗，且待归因的调用留到下一区间；
 *   5. 计数与基线跨重启保留；
 *   6. 文件缺失/损坏不抛错。
 *
 * 用法：node scripts/smoke-meter.mjs
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallMeter } from '../lib/meter.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}
const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps
const dir = mkdtempSync(join(tmpdir(), 'cmdgo-meter-'))
const file = join(dir, 'meter.json')

/* ---------- [1] 空状态：不给估算 ---------- */
console.log('[1] 空状态')
const m1 = new CallMeter({ file, flushDelayMs: 10 })
check('初始没有调用/消耗', m1.snapshot().totalCalls === 0 && m1.snapshot().consumed === 0)
check('初始 perCall 缺省', m1.snapshot().perCall === undefined)
check('初始 ready=false', m1.snapshot().ready === false)
check('remaining=undefined 被忽略', (m1.noteUsage('A', undefined), m1.snapshot().samples === 0))

/* ---------- [2] 只有调用、没有额度差：仍不给估算 ---------- */
console.log('[2] 只有调用')
for (let i = 0; i < 3; i += 1) m1.noteCall('A')
check('计数到 3 次', m1.snapshot().totalCalls === 3)
check('没有样本 → perCall 缺省', m1.snapshot().perCall === undefined)
check('ready 仍为 false', m1.snapshot().ready === false)

/* ---------- [3] 基线 → 归因 ---------- */
console.log('[3] 额度下降 + 有调用 → 归因')
m1.noteUsage('A', 10) // 首个快照：只设基线，不归因
check('首个快照不产生样本', m1.snapshot().samples === 0)
m1.noteUsage('A', 9.4) // 以上 3 次调用共消耗 0.6
let s = m1.snapshot()
check('样本数 1', s.samples === 1, JSON.stringify(s))
check('消耗 0.6', near(s.consumed, 0.6), String(s.consumed))
check('归因调用 3', s.attributedCalls === 3)
check('样本不足仍 ready=false（需 2 个样本）', s.ready === false)

console.log('[3b] 第二个样本 → 可以估算')
for (let i = 0; i < 4; i += 1) m1.noteCall('A') // 4 次
m1.noteUsage('A', 8.8) // 消耗 0.6
s = m1.snapshot()
check('消耗累计 1.2', near(s.consumed, 1.2), String(s.consumed))
check('归因调用 7', s.attributedCalls === 7)
check('总调用 7', s.totalCalls === 7)
check('perCall ≈ 1.2/7', Math.abs(s.perCall - 1.2 / 7) < 1e-4, String(s.perCall))
check('perCall 快照保留 4 位小数 = 0.1714', s.perCall === 0.1714, String(s.perCall))
check('ready=true', s.ready === true)

/* ---------- [4] 区间内没有调用 → 不归因外部消耗 ---------- */
console.log('[4] 外部用量不归因')
m1.noteUsage('A', 8.0) // 再降 0.8，但这段区间我们没有发起调用
s = m1.snapshot()
check('消耗不变（外部 cmd 用量被排除）', near(s.consumed, 1.2), String(s.consumed))
check('样本数不变', s.samples === 2)

/* ---------- [5] 额度上升 = 重置/购买：不计消耗，pending 留到下一区间 ---------- */
console.log('[5] 重置/购买')
m1.noteCall('A') // 1 次待归因
m1.noteUsage('A', 12) // 额度上升
s = m1.snapshot()
check('重置不产生消耗', near(s.consumed, 1.2), String(s.consumed))
check('重置不产生样本', s.samples === 2)
m1.noteUsage('A', 11.7) // 下降 0.3，应归因给上一次留下的 1 次调用
s = m1.snapshot()
check('重启值确认后归因 1 次调用', s.attributedCalls === 8, String(s.attributedCalls))
check('消耗 1.5', near(s.consumed, 1.5), String(s.consumed))
check('样本 3', s.samples === 3)

/* ---------- [6] 跨重启保留 ---------- */
console.log('[6] 跨重启')
m1.noteCall('A')
await m1.flushNow()
const m2 = new CallMeter({ file, flushDelayMs: 10 })
// 触发一次载入：noteUsage 内部会 await ensureLoaded，给它一个宏任务落地。
m2.noteUsage('A', 11.7)
await new Promise((r) => setTimeout(r, 20))
const s2 = m2.snapshot()
check('重启后仍记得总调用', s2.totalCalls === 9, String(s2.totalCalls))
check('重启后仍记得消耗', near(s2.consumed, 1.5), String(s2.consumed))
check('重启后样本保留', s2.samples === 3, String(s2.samples))
check('重启后 pending 未丢（上次 noteCall 的 1 次仍待归因）', s2.attributedCalls === 8, String(s2.attributedCalls))

/* ---------- [7] 文件损坏不抛错 ---------- */
console.log('[7] 损坏文件')
const bad = join(dir, 'bad.json')
writeFileSync(bad, '{ this is not json', 'utf8')
const m3 = new CallMeter({ file: bad, flushDelayMs: 10 })
m3.noteCall('X')
m3.noteUsage('X', 5)
m3.noteUsage('X', 4)
check('损坏后仍可记账', m3.snapshot().totalCalls === 1, String(m3.snapshot().totalCalls))
check('损坏后归因逻辑仍生效', near(m3.snapshot().consumed, 1), String(m3.snapshot().consumed))

m1.dispose()
m2.dispose()
m3.dispose()

if (failures.length > 0) {
  console.error('\n计量测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n计量测试全部通过。')
