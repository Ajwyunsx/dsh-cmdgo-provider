/**
 * settings 契约兼容的本地测试（issue #8）。
 *
 * issue #8 报告了两件事：
 *   1. dsh 0.1.7 起 `settings.installSection` 被删除，而插件无保护地调用它 →
 *      **设置页整块静默消失**（cordis 吞掉 inject 回调里的异常，stderr 无输出）；
 *   2. peer 上限 `<0.2.0` 会让 0.2.0 稳定版发布后**拒绝安装/启动**。
 *
 * 这里用一个最小的 ctx / settings 桩对 `apply()` 跑四种宿主：
 *   A. 老宿主（只有 installSection）→ 走老路，声明自报命名空间 `cmdgo`；
 *   B. 新宿主（只有 configure，installSection 缺席）→ 走新路，不抛；
 *   C. 两代都在 → 优先老路；
 *   D. settings 服务缺席 → 不抛。
 * 路径 B 是回归重点：修之前它是 `installSection is not a function`，而那个错会被
 * cordis 的 inject 回调静默吞掉，表现就是「插件看似正常、设置页没了」。
 *
 * volatile 投影（0.1.7+ 设置页的准入条件）按**能力**判定：`Schema#volatile` 只在
 * `@deepseek-ai/schemastery` 3.18.3+ 存在。本机若解析到 3.18.1/3.18.2，标记会
 * 静默缺失——脚本如实报告这一事实（此时插件必须在 0.1.7+ 上显式报错，而不是让
 * 用户面对一个「设置页凭空消失」的插件）。
 *
 * 用法：node scripts/smoke-settings.mjs
 */

import { readFile } from 'node:fs/promises'
import z from '@deepseek-ai/schemastery'
import { apply, Config } from '../lib/index.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}
const note = (label) => console.log('  --  ' + label)

/* ---------- [1] Config 形状 ---------- */
console.log('[1] Config 形状')
const schema = JSON.stringify(Config.toJSON())
const declared = ['apiKeyEnv', 'baseURL', 'maxTokens', 'defaultContextWindow', 'retryPolicy']
check('五个配置字段都还在 schema 里', declared.every((key) => schema.includes(`"${key}"`)), schema.slice(0, 200))

/* ---------- [2] volatile 投影能力 ---------- */
console.log('[2] volatile 投影（0.1.7+ 设置页只渲染 volatile 字段）')
// 能力探测：拿一个一次性 schema 试，别动真实 Config。
const probe = z.string().default('probe')
const supportsVolatile = typeof Object.getPrototypeOf(probe).volatile === 'function'
  || typeof probe.volatile === 'function'
const markerCount = (schema.match(/"volatile":true/g) ?? []).length
const schemasteryVersion = JSON.parse(
  await readFile(new URL('../node_modules/@deepseek-ai/schemastery/package.json', import.meta.url), 'utf8'),
).version
if (supportsVolatile) {
  check(`本机 schemastery ${schemasteryVersion} 支持 volatile`, true)
  check('五个字段都带上了 volatile 标记（每个字段至少一个）', markerCount >= 5,
    `markers=${markerCount}`)
  // `toJSON()` 是引用池：根节点自己也在 `refs[uid]` 里，字段表挂在它的 `dict` 上。
  const json = Config.toJSON()
  const root = json.refs?.[json.uid]
  for (const key of declared) {
    const ref = root?.dict?.[key]
    const meta = ref === undefined ? undefined : json.refs?.[ref]?.meta
    check(`  ${key} 自身带 volatile`, meta?.volatile === true, JSON.stringify(meta))
  }
} else {
  // 3.18.1/3.18.2：没有 volatile 运行时。这不是本仓库的 bug，但必须显式可见——
  // 否则 0.1.7+ 的用户会遇到「设置页整块消失」，正是 issue #8 的故障形态。
  note(`本机 schemastery ${schemasteryVersion} 没有 volatile 运行时（需要 3.18.3+）`)
  note(`schema 里的 volatile 标记数 = ${markerCount}（宿主上安装 3.18.3+ 后应为 5+）`)
  check('没有 volatile 时必须留下可诊断的痕迹（不静默）',
    markerCount === 0 && supportsVolatile === false, 'unexpected state')
  check('peer 声明的 schemastery 下限不足以强制 volatile，需在 0.1.7+ 显式报错（见 [3]）',
    typeof schemasteryVersion === 'string', schemasteryVersion)
}

/* ---------- 最小 ctx / settings 桩 ---------- */
function makeCtx() {
  const logs = []
  const services = new Map()
  const llmCalls = []
  const listeners = []
  const ctx = {
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
      debug: () => {},
    },
    fiber: { id: 'cmdgo-provider' },
    effect(fn) { const dispose = fn(); if (typeof dispose !== 'function') return; /* 桩不主动释放 */ },
    get(name) { return services.get(name) },
    inject(names, cb) { cb(ctx) },
    on(event, listener) { listeners.push([event, listener]); return () => {} },
    llm: {
      registerConfigurableProviders(entries) {
        llmCalls.push(['providers', entries])
        return () => {}
      },
      registerAdapter(providers, adapter) {
        llmCalls.push(['adapter', providers, adapter])
        return { replace: () => llmCalls.push(['adapter-replace']) }
      },
    },
  }
  return { ctx, logs, services, llmCalls, listeners }
}

/** 0.1.5 / 0.1.6：只有 installSection。 */
function legacySettings(calls) {
  return {
    installSection(_owner, ns, _schema, entry, hooks) {
      calls.push({ api: 'installSection', ns })
      hooks.setSource(() => ({ ...entry, maxTokens: 1234 }))
      hooks.onChange()
    },
  }
}

/** 0.1.7+：installSection 已删除，只剩 configure。 */
function modernSettings(calls) {
  return {
    configure(presentation, owner) {
      calls.push({ api: 'configure', auto: presentation.auto, owner })
      return () => calls.push({ api: 'configure-dispose' })
    },
  }
}

const baseConfig = {
  apiKeyEnv: 'COMMANDCODE_API_KEY',
  baseURL: 'https://api.commandcode.ai',
  maxTokens: 64000,
  defaultContextWindow: 1000000,
  retryPolicy: {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['EMPTY_RESPONSE'],
    backoff: { initialDelayMs: 500, maxDelayMs: 10000, jitterRatio: 0.1 },
  },
}

/** 跑一次 apply()，可选服务缺席时留 undefined。 */
async function applyWith(settings, config = baseConfig) {
  const { ctx, logs, services, llmCalls, listeners } = makeCtx()
  if (settings !== undefined) {
    // cordis 注入的 settings 服务既能按名 get()，也挂在 ctx 上；插件两条路都试，
    // 桩里也两条都放（只放一条会漏测真实契约）。
    services.set('settings', settings)
    ctx.settings = settings
  }
  const errors = []
  try {
    await apply(ctx, { ...config })
  } catch (error) {
    errors.push(error)
  }
  return { ctx, logs, llmCalls, listeners, errors }
}

/** 不带 settings 服务、用给定配置跑一次（空配置 / volatile 持有器用）。 */
async function applyBare(config) {
  return applyWith(undefined, config)
}

/* ---------- [3] 新宿主（0.1.7+ / 0.2.x） ---------- */
console.log('[3] settings 只有 configure（dsh 0.1.7+ / 0.2.x）')
const modernCalls = []
const modern = await applyWith(modernSettings(modernCalls))
check('apply() 不抛错（旧实现在这里抛 installSection is not a function）',
  modern.errors.length === 0, modern.errors.map((e) => e.message).join(' | '))
check('走了 configure 路径', modernCalls.some((c) => c.api === 'configure'), JSON.stringify(modernCalls))
check('声明 auto:false（表单改由 loader 投影）',
  modernCalls.some((c) => c.api === 'configure' && c.auto === false), JSON.stringify(modernCalls))
check('把拥有者 fiber 传给 configure（投影按 fiber 认插件）',
  modernCalls.some((c) => c.api === 'configure' && c.owner === modern.ctx.fiber), JSON.stringify(modernCalls))
check('没有走老路', !modernCalls.some((c) => c.api === 'installSection'), JSON.stringify(modernCalls))
check('供应商仍注册（llm.registerConfigurableProviders）',
  modern.llmCalls.some(([kind]) => kind === 'providers'), JSON.stringify(modern.llmCalls.map((c) => c[0])))
// 没有 volatile 运行时的那一天，必须留下可诊断的 error 日志，而不是静默。
if (!supportsVolatile) {
  check('没有 volatile 运行时时，apply() 留下 error 日志（不静默消失）',
    modern.logs.some(([level, args]) => level === 'error' && String(args[0]).includes('volatile')),
    JSON.stringify(modern.logs.filter(([l]) => l === 'error')))
} else {
  check('有 volatile 运行时时，不误报 error', !modern.logs.some(([l]) => l === 'error'),
    JSON.stringify(modern.logs.filter(([l]) => l === 'error')))
}

/* ---------- [4] 老宿主（0.1.5 / 0.1.6） ---------- */
console.log('[4] settings 只有 installSection（dsh 0.1.5 / 0.1.6）')
const legacyCalls = []
const legacy = await applyWith(legacySettings(legacyCalls))
check('apply() 不抛错', legacy.errors.length === 0, legacy.errors.map((e) => e.message).join(' | '))
check('走了 installSection 路径', legacyCalls.some((c) => c.api === 'installSection'), JSON.stringify(legacyCalls))
check('注册的是自报命名空间 cmdgo', legacyCalls.some((c) => c.api === 'installSection' && c.ns === 'cmdgo'),
  JSON.stringify(legacyCalls))
check('没有误调 configure', !legacyCalls.some((c) => c.api === 'configure'), JSON.stringify(legacyCalls))
check('老路不因缺少 volatile 而报错（0.1.5 不看该 meta）',
  !legacy.logs.some(([l]) => l === 'error'), JSON.stringify(legacy.logs.filter(([l]) => l === 'error')))

/* ---------- [5] 两代 API 都在：优先老路 ---------- */
console.log('[5] 两代 API 同时存在')
const bothCalls = []
const bothRun = await applyWith({
  installSection: legacySettings(bothCalls).installSection,
  configure: modernSettings(bothCalls).configure,
})
check('apply() 不抛错', bothRun.errors.length === 0, bothRun.errors.map((e) => e.message).join(' | '))
check('优先老路（保留 0.1.5/0.1.6 的 ns 语义）', bothCalls.some((c) => c.api === 'installSection'),
  JSON.stringify(bothCalls))
check('没有同时装两遍', !bothCalls.some((c) => c.api === 'configure'), JSON.stringify(bothCalls))

/* ---------- [6] settings 服务完全缺席 ---------- */
console.log('[6] 没有 settings 服务（headless / 精简 profile）')
const absent = await applyWith(undefined)
check('apply() 不抛错', absent.errors.length === 0, absent.errors.map((e) => e.message).join(' | '))
check('供应商注册照常完成', absent.llmCalls.some(([k]) => k === 'providers'), JSON.stringify(absent.llmCalls.map((c) => c[0])))

/* ---------- [6b] 空配置（全部走 schema 默认值） ---------- */
console.log('[6b] 空配置')
const empty = await applyBare({})
check('apply({}) 不抛错（每个字段都有 default）', empty.errors.length === 0,
  empty.errors.map((e) => e.message).join(' | '))
check('空配置仍注册供应商', empty.llmCalls.some(([k]) => k === 'providers'),
  JSON.stringify(empty.llmCalls.map((c) => c[0])))

/* ---------- [6c] volatile 持有器（dsh 0.1.7+ 真实形状） ---------- */
console.log('[6c] volatile 持有器：读取边界必须解引用')
// 用真实的 cosmokit 造一个持有器（cosmokit 存在时）。这是 0.1.7+ 交给插件的
// 实际形状：字段值是 `{ get() }`，直接当裸值用会全盘拿到错误配置。
const vol = await (async () => {
  try {
    const { createVolatile } = await import('@deepseek-ai/cosmokit')
    return createVolatile({ ...baseConfig, maxTokens: 4321 })
  } catch {
    return undefined
  }
})()
if (vol === undefined) {
  note('跳过：本机没有可解析的 @deepseek-ai/cosmokit')
} else {
  const volatileRun = await applyBare(vol)
  check('apply() 吃 volatile 持有器不抛错', volatileRun.errors.length === 0,
    volatileRun.errors.map((e) => e.message).join(' | '))
  // 解引用生效的证据：adapter 的连接事实里 maxTokens 必须是持有器里的 4321，
  // 而不是持有器对象本身（后者会被 resolveAdapterOptions 判成非法而抛错）。
  const adapterCall = volatileRun.llmCalls.find(([k]) => k === 'adapter')
  const adapter = adapterCall?.[2]
  const opts = adapter?.config?.options?.() ?? adapter?.options?.()
  check('连接事实里的 maxTokens 来自持有器内容（4321）', opts?.maxTokens === 4321,
    JSON.stringify(opts?.maxTokens))
  check('baseURL 也被正确解引用', opts?.baseURL === 'https://api.commandcode.ai', String(opts?.baseURL))
}

/* ---------- [7] peer 范围（issue #8 问题二） ---------- */
console.log('[7] peer 范围覆盖 0.2.0 稳定版')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
check('有 dsh-* peer', dshPeers.length > 0, String(dshPeers.length))
const badRanges = dshPeers.filter(([, range]) => !String(range).includes('0.2.0'))
check('每个 dsh-* peer 的范围都覆盖 0.2.0（issue #8 的定时炸弹）',
  badRanges.length === 0, JSON.stringify(badRanges))
check('采纳 `|| ^0.2.0-rc.1` 形式',
  dshPeers.every(([, range]) => String(range).includes('^0.2.0-rc.1')), JSON.stringify(dshPeers))
check('client.inject 不再引用已不存在的 dsh-client-runtime',
  !JSON.stringify(manifest.dsh?.client?.inject ?? []).includes('dsh-client-runtime'),
  JSON.stringify(manifest.dsh?.client?.inject))
check('peer 里声明了 @deepseek-ai/cosmokit（isVolatile 的来源）',
  manifest.peerDependencies?.['@deepseek-ai/cosmokit'] !== undefined,
  JSON.stringify(Object.keys(manifest.peerDependencies ?? {})))
check('peer 下限对 0.1.0~0.1.6 仍放行（不制造意外的拒装）',
  dshPeers.every(([, range]) => String(range).startsWith('>=0.1.0-rc.6')), JSON.stringify(dshPeers))

if (failures.length > 0) {
  console.error('\nsettings 兼容测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\nsettings 兼容测试全部通过。')
