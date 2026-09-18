/**
 * Go 档位判定的本地单元测试（直接跑编译产物 lib/models.js，无网络依赖）。
 *
 * 这里钉的是 issue #7 暴露的两层判据：
 *
 * [A] 解析官方表的 `Min plan` 列：
 *     1. `Go and above` → Go；`Pro and above` / `GOAT and above` / `Max` → 非 Go；
 *     2. 表头与分隔行（非反引号 id）不得混进结果；
 *     3. `—` 不产生判定。
 *
 * [B] 静态基线（快速路径，不额外联网）：
 *     4. `muse-spark-1.3-contributor` 必须在列——它曾因硬编码停在 1.2 而漏掉（#7）；
 *     5. 同品牌的非 Contributor 变体仍应被排除。
 *
 * [C] 权威覆盖（第二层，官方升/降档无需插件发版）：
 *     6. 基线排除的模型，被表判为 Go 时要能补回来（模拟下一次官方升版）；
 *     7. 基线收录的模型，被判为非 Go 时要能移出去；
 *     8. 表里没有的 id 仍按基线判。
 *
 * 用法：node scripts/smoke-go-plan.mjs
 */

import { fetchGoModels, isGoModel, parseCatalogPlans } from '../lib/models.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

// 与官方 models.md 同形的合成表：列序 = id | Name | Context | Efforts | 价格 | Min plan | Best for
const CATALOG = [
  '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |',
  '|---|---|---|---|---|---|---|',
  '| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro | 1M | high, max | $0.66 | Go and above | long context |',
  '| `claude-sonnet-5` | Claude Sonnet 5 | 1M | low, high | $9 | Max | frontier |',
  '| `google/gemini-3.8-flash` | Gemini 3.8 Flash | 1M | low | $1 | GOAT and above | fast |',
  '| `zai-org/GLM-5.3` | GLM-5.3 | 1M | — | $1.4 | Pro and above | coding |',
  '| `meta/muse-spark-1.3-contributor` | Muse Spark 1.3 Contributor | 1.05M | low, high | $0.1 | Go and above | cheap |',
  '| `meta/muse-spark-9.9-contributor` | Muse Spark 9.9 Contributor | 1.05M | low | $0.1 | Go and above | future |',
].join('\n')

const LISTING = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro', context_length: 1_000_000 },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1_000_000 },
    { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash', context_length: 1_000_000 },
    { id: 'zai-org/GLM-5.3', name: 'GLM-5.3', context_length: 1_000_000 },
    { id: 'meta/muse-spark-1.3-contributor', name: 'Muse Spark 1.3 Contributor', context_length: 1_048_576 },
    { id: 'meta/muse-spark-9.9-contributor', name: 'Muse Spark 9.9 Contributor', context_length: 1_048_576 },
    { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3', context_length: 1_048_576 },
  ],
}

const stubFetch = async () => new Response(JSON.stringify(LISTING), { status: 200, headers: { 'content-type': 'application/json' } })
const ids = (models) => models.map(m => m.id).sort()

console.log('[A] 解析 Min plan 列')
const plans = parseCatalogPlans(CATALOG)
check('Go and above → true', plans.get('deepseek/deepseek-v4-pro') === true, plans.get('deepseek/deepseek-v4-pro'))
check('Max → false', plans.get('claude-sonnet-5') === false, plans.get('claude-sonnet-5'))
check('GOAT and above → false（不算 Go）', plans.get('google/gemini-3.8-flash') === false, plans.get('google/gemini-3.8-flash'))
check('Pro and above → false', plans.get('zai-org/GLM-5.3') === false, plans.get('zai-org/GLM-5.3'))
check('表头未混入', !plans.has('Id (use EXACTLY this)'), [...plans.keys()].join(','))
check('分隔行未混入', !plans.has('---'), [...plans.keys()].join(','))

console.log('[B] 静态基线（快速路径）')
check('muse-spark-1.3-contributor 在列（#7 回归）', isGoModel('meta/muse-spark-1.3-contributor') === true)
check('muse-spark-1.2-contributor 仍在列', isGoModel('meta/muse-spark-1.2-contributor') === true)
check('同品牌非 Contributor 变体仍被排除', isGoModel('meta/muse-spark-1.3') === false)
check('基线不认识 muse-spark-9.9', isGoModel('meta/muse-spark-9.9-contributor') === false)

console.log('[C] 权威覆盖')
check('表判为 Go 时可补回基线排除的模型', isGoModel('meta/muse-spark-9.9-contributor', plans) === true)
const demoted = new Map(plans)
demoted.set('deepseek/deepseek-v4-pro', false)
check('表判为非 Go 时可移除基线收录的模型', isGoModel('deepseek/deepseek-v4-pro', demoted) === false)
check('表里没有的 id 仍按基线（默认收录）', isGoModel('unknownprovider/brand-new', plans) === true)
check('表里没有的 id 仍按基线（品牌黑名单）', isGoModel('claude-brand-new', plans) === false)

console.log('[D] fetchGoModels 贯通 plan 参数')
const noPlan = await fetchGoModels(undefined, stubFetch)
const withPlan = await fetchGoModels(undefined, stubFetch, undefined, plans)
check('无 plan：基线结果不含 9.9', !ids(noPlan).includes('meta/muse-spark-9.9-contributor'), ids(noPlan).join(','))
check('有 plan：补回 9.9', ids(withPlan).includes('meta/muse-spark-9.9-contributor'), ids(withPlan).join(','))
check('有 plan：剔除 Gemini（GOAT 档）', !ids(withPlan).includes('google/gemini-3.8-flash'), ids(withPlan).join(','))
check('有 plan：剔除 Claude（Max 档）', !ids(withPlan).includes('claude-sonnet-5'), ids(withPlan).join(','))
check('有 plan：保留真正 Go 的模型', ids(withPlan).includes('deepseek/deepseek-v4-pro') && ids(withPlan).includes('meta/muse-spark-1.3-contributor'), ids(withPlan).join(','))
check('输出按 id 稳定排序', JSON.stringify(ids(withPlan)) === JSON.stringify(withPlan.map(m => m.id)), withPlan.map(m => m.id).join(','))

if (failures.length > 0) {
  console.error('\nGo 档位测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\nGo 档位测试全部通过。')
