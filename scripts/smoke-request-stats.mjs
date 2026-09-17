/**
 * RequestStats 的本地单元测试（直接跑编译产物 lib/request-stats.js，无宿主依赖）。
 *
 * 缓存台账是 issue #6 补充诉求的落点，所以钉住这几条：
 *   1. 空台账不给任何数字（没有请求就没有 last/sessions）；
 *   2. 累计按会话聚合，最近使用的排最前；
 *   3. `current` 只在请求里点名了会话命中时才出现（客户端在会话头部时用）；
 *   4. 网关没报缓存字段时 `cacheReported=false`、不算命中率；
 *   5. 会话只以短哈希标签对外，完整 sessionId 不出现在快照里；
 *   6. 会话数有上限，超出淘汰最久未用的一条。
 *
 * 用法：node scripts/smoke-request-stats.mjs
 */

import { cacheHitRate, RequestStats } from '../lib/request-stats.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}
const near = (a, b, eps = 1e-9) => typeof a === 'number' && Math.abs(a - b) < eps

/* ---------- [1] 空台账 ---------- */
console.log('[1] 空台账')
const empty = new RequestStats()
const v0 = empty.view()
check('没有 last', v0.last === undefined)
check('累计全 0', v0.total.requests === 0 && v0.total.cacheReadTokens === 0)
check('没有会话行', v0.sessions.length === 0)
check('没有 current', v0.current === undefined)

/* ---------- [2] 按会话聚合 + 最近优先 ---------- */
console.log('[2] 按会话聚合')
const stats = new RequestStats()
stats.record({ sessionId: 'sess_aaaa1111', model: 'm-a', inputTokens: 100, outputTokens: 10, cacheReadTokens: 900, cacheWriteTokens: 0, at: 1000 })
stats.record({ sessionId: 'sess_bbbb2222', model: 'm-b', inputTokens: 50, outputTokens: 5, cacheReadTokens: 50, at: 2000 })
stats.record({ sessionId: 'sess_aaaa1111', model: 'm-a', inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 100, at: 3000 })

const v = stats.view('sess_aaaa1111')
check('累计请求数 3', v.total.requests === 3, String(v.total.requests))
check('累计未命中输入 350', v.total.inputTokens === 350, String(v.total.inputTokens))
check('累计缓存读 2750', v.total.cacheReadTokens === 2750, String(v.total.cacheReadTokens))
check('累计缓存写 100', v.total.cacheWriteTokens === 100, String(v.total.cacheWriteTokens))
check('两次会话行', v.sessions.length === 2, String(v.sessions.length))
check('最近使用的会话排最前', v.sessions[0].label === v.current.label, v.sessions.map((r) => r.label).join(','))
check('会话 A 聚合了两次请求', v.current.requests === 2 && v.current.cacheReadTokens === 2700, JSON.stringify(v.current))
check('会话 A 最近一次模型被记住', v.current.model === 'm-a')
check('current 命中时给出会话行', v.current !== undefined)
check('未点名会话时没有 current', stats.view().current === undefined)
check('点名不存在的会话时也没有 current', stats.view('sess_zzz').current === undefined)

/* ---------- [3] last 与命中率 ---------- */
console.log('[3] 最近一次请求')
check('last 是最后一次请求的模型', v.last.model === 'm-a')
check('last 时间戳正确', v.last.at === 3000)
check('命中率 = 1800/(200+1800+100)', near(v.last.cacheHitRate, 1800 / 2100), String(v.last.cacheHitRate))
check('报了缓存字段 → cacheReported', v.last.cacheReported === true)
const noCache = new RequestStats()
noCache.record({ sessionId: 's', model: 'm', inputTokens: 10, outputTokens: 1, at: 1 })
const nv = noCache.view()
check('网关没报缓存字段 → cacheReported=false', nv.last.cacheReported === false)
check('没报缓存字段时命中率为 0（不编造）', nv.last.cacheHitRate === 0)
check('没报缓存字段时不带 cacheReadTokens 字段', nv.last.cacheReadTokens === undefined)
check('纯函数命中率：无输入时返回 0', cacheHitRate({ inputTokens: 0 }) === 0)

/* ---------- [4] 标签不泄露完整会话 id ---------- */
console.log('[4] 会话标签')
check('标签是 8 位十六进制哈希', /^[0-9a-f]{8}$/.test(v.current.label), v.current.label)
check('快照里不含完整 sessionId', !JSON.stringify(v).includes('sess_aaaa1111'))

/* ---------- [5] 上限淘汰 ---------- */
console.log('[5] 会话数上限')
const bounded = new RequestStats({ maxSessions: 2 })
bounded.record({ sessionId: 'a', model: 'm', inputTokens: 1, outputTokens: 1, at: 1 })
bounded.record({ sessionId: 'b', model: 'm', inputTokens: 1, outputTokens: 1, at: 2 })
bounded.record({ sessionId: 'c', model: 'm', inputTokens: 1, outputTokens: 1, at: 3 })
check('只保留 2 个会话行', bounded.view().sessions.length === 2, String(bounded.view().sessions.length))
check('最久未用的 a 被淘汰', bounded.view('a').current === undefined)
check('累计不受淘汰影响（仍是 3 次）', bounded.view().total.requests === 3, String(bounded.view().total.requests))

if (failures.length > 0) {
  console.error('\n缓存台账测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n缓存台账测试全部通过。')
