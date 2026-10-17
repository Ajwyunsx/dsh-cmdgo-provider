/**
 * dsh-cmdgo-provider — CommandCode Go 套餐供应商。
 *
 * Go 套餐是 Command Code 唯一没有 Provider API 的套餐：OpenAI 兼容端点对 Go
 * 订阅返回 403 `upgrade_required`，所有请求必须走 CLI 私有网关
 * `POST /alpha/generate`。本插件：
 *
 * 1. 扫描公开模型目录（`/provider/v1/models`，免鉴权），按 Go 套餐规则筛选
 *    （开源模型 + 少量 premium 例外），定时刷新；reasoning effort 元数据从
 *    官方 CLI catalog（jsDelivr）合并。筛选后的模型注册进 `ctx.llm`，
 *    Web 的 Models 页面即可直接选择 Command Code Go 供应商与模型。
 * 2. 把 `cmd login` 的 OAuth 流程提取成设置页可用的登录服务：本机回调
 *    服务器 + Studio 授权地址（登录地址），浏览器授权后自动回收 API Key
 *    并写入凭据存储（默认 COMMANDCODE_API_KEY）。
 * 3. 暴露 `/api/cmdgo/*` HTTP 路由供客户端「CommandCode Go」设置页调用：
 *    生成登录地址、等待回调状态、退出登录、账号启停/移除、额度刷新。
 * 4. 通过与官方 CLI `/usage` 同源的账单接口读取每个账号的额度，在设置页
 *    按账号展示 5 小时 / 周滚动窗口与月度额度（见 `usage.ts`）。
 *
 * @module cmdgo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm'
import type { RetryPolicyConfig } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './adapter.js'
import type { CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
import { applyModalities, fetchAllModels, fetchCatalog, fetchCatalogModalities, hasKnownModality, selectGoModels } from './models.js'
import type { ModelPricing } from './models.js'
import { DEFAULT_STUDIO_BASE, CommandCodeLoginManager } from './oauth.js'
import type { LoginSuccessInfo, LoginStatus } from './oauth.js'
import { AccountPool } from './pool.js'
import type { PoolAccount } from './pool.js'
import { UsageReader } from './usage.js'
import type { UsageStatus } from './usage.js'
import { CallMeter } from './meter.js'
import type { MeterSnapshot } from './meter.js'
import { RequestStats } from './request-stats.js'
import type { RequestStatsView } from './request-stats.js'
import { CmdgoPrefs, isCmdgoThemePreference, type CmdgoThemePreference } from './prefs.js'
import type { GoModel } from './models.js'
import type { ImageResolver } from './protocol.js'

export {
  CommandCodeGoAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from './adapter.js'
export type { CommandCodeGoAdapterOptions, CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
export { fetchCatalog, fetchCatalogEfforts, fetchGoModels, isGoModel, parseCatalogEfforts, parseCatalogPlans, parseCatalogPricing, selectGoModels } from './models.js'
export type { ModelPricing } from './models.js'
export { CommandCodeLoginManager, DEFAULT_STUDIO_BASE } from './oauth.js'
export type { LoginStatus, LoginSuccessInfo } from './oauth.js'
export { UsageReader, normalizeUsage, resolvePlan } from './usage.js'
export { CallMeter, MIN_METER_CALLS, MIN_METER_SAMPLES } from './meter.js'
export type { CallMeterOptions, MeterSnapshot } from './meter.js'
export { cacheHitRate, RequestStats, DEFAULT_MAX_SESSION_ROWS } from './request-stats.js'
export type {
  RequestStatsCounters,
  RequestStatsLast,
  RequestStatsRow,
  RequestStatsSample,
  RequestStatsView,
} from './request-stats.js'
export type {
  PlanSpec,
  UsageMonthly,
  UsagePlanView,
  UsageReaderOptions,
  UsageSnapshot,
  UsageStatus,
  UsageWindow,
} from './usage.js'

export const name = 'dsh-cmdgo-provider'
/** llm 是硬依赖（供应商路由）；webServer / credentials 可选，按需 ctx.get。 */
export const inject = ['llm']

const NS = 'cmdgo'
const PROVIDER = 'commandcode'
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** 网关 base；`/alpha/generate` 自动追加。 */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai'
/** 目录扫描周期；模型列表稳定，慢轮询足够。 */
const REFRESH_MS = 15 * 60 * 1000

/** 请求图像投影预算（与 dsh 内置 provider 同量级：0.64 MP / 1 MiB）。 */
const DEFAULT_REQUEST_IMAGE_PIXELS = 640_000
const DEFAULT_REQUEST_IMAGE_BYTES = 1024 * 1024
/** 实时模态注册表最多多久重拉一次（2.5 MB，只在目录出现未知模型时才拉）。 */
const MODALITY_REFRESH_MS = 6 * 60 * 60 * 1000

/**
 * 附件服务的结构契约。只用到读取请求图像这一个方法，因此按结构声明而不是
 * 新增 peer 依赖（`attachments` 是可选服务，缺席时图片降级为占位文字）。
 * `ctx.get()` 的返回类型是 any，所以这里显式断言，避免接口沦为死代码。
 */
interface ImageAttachmentRefLike {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
}

/**
 * `readImageRequest` 的第二参数按宿主版本有**两种形状**（issue #12）：
 *
 * - dsh 0.1.x：`ImageRequestPolicy`（`{ maxPixels, maxBytes }`）——宿主自己拿
 *   ref 的宽高算投影尺寸；
 * - dsh 0.2.x：`ImageRequestTarget`（`{ width, height, maxBytes }`）——路由方
 *   （也就是本插件）必须先算好目标尺寸再要图，缺 `width`/`height` 会被
 *   `validateTarget()` 直接抛错。
 *
 * 两种形状的字段都是必填的正整数，这里按并集声明，运行时按「先试新形状、
 * 失败回退旧形状」处理（见 `readRequestImage`）。
 */
interface ImageRequestShape {
  maxPixels?: number
  maxBytes?: number
  width?: number
  height?: number
}

interface ImageAttachmentService {
  readImageRequest(
    ref: ImageAttachmentRefLike,
    shape: ImageRequestShape,
    signal: AbortSignal | undefined,
  ): Promise<{ data: Uint8Array; mediaType: string }>
}

/**
 * 宿主 0.1.x `requestImageDimensions()` 的内联副本（`@deepseek-ai/dsh-attachment`
 * 的 request-projection 纯函数）：保纵横比的整数投影，收敛到 `maxPixels` 以内、
 * 不放大。与宿主逐位一致很重要——0.2.x 把 target 的宽高与字节预算一起哈希进
 * 缓存变体身份（`requestImageVariantId`），尺寸算得不同只会多生成一份缓存变体；
 * 而超出像素预算可能被宿主的 `assertImagesFit` 判成需要 offload。所以这里复刻
 * 算法而不是「差不多就行」。
 */
function requestImageDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}

/**
 * dsh-client-connection 提供的 Host 连接服务。只用它自带的
 * `requestRejection`：那是 harness 保护自身 `/api/*` 的同一套闸门
 * （Host/Origin 围墙 + 浏览器会话鉴权），返回 403 / 401 / undefined。
 */
interface ConnectionGate {
  requestRejection(request: { headers: Record<string, string | string[] | undefined> }): number | undefined
}

/** 本机回环主机名（含 IPv6 的带括号写法）。 */function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

/**
 * `connection` 服务缺席时的最小信任围墙（无浏览器的 composition）。
 *
 * 与 harness 自带闸门同一判据：Host 必须是本机回环，跨站标记一律拒绝，
 * 带 Origin 时 Origin 必须与 Host 同源。网络可达性与鉴权不在本函数范围——
 * 有 connection 服务时一律走它，那里才有真正的会话鉴权。
 *
 * @param headers - Node 请求头（小写键）。
 * @returns 拒绝时的 HTTP 状态码；放行时 undefined。
 */
export function browserTrustRejection(
  headers: Record<string, string | string[] | undefined>,
): number | undefined {
  const host = headers.host
  if (typeof host !== 'string' || host.length === 0) return 403
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return 403
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return 403
  if (headers['sec-fetch-site'] === 'cross-site') return 403
  const origin = headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      if (new URL(origin).host !== hostUrl.host) return 403
    } catch {
      return 403
    }
  }
  return undefined
}

/**
 * 插件配置：同时作为 Models 页里该供应商的设置区块形状。
 */
export interface Config {
  /** 凭据引用，按请求解析；默认 `COMMANDCODE_API_KEY`。 */
  apiKeyEnv?: string
  /** 网关 base URL；默认 `https://api.commandcode.ai`。 */
  baseURL?: string
  /** 单次请求输出上限（默认 64,000）；显式请求值优先。 */
  maxTokens?: number
  /** 模型无精确上下文时的兜底容量（默认 1,000,000）。 */
  defaultContextWindow?: number
  /** 供应商级重试策略；缺省走常规默认。 */
  retryPolicy?: RetryPolicyConfig
}

/**
 * settings 服务的两代形状。0.1.7 删掉了 `installSection`，改用
 * `configure(presentation, owner)`（页面策略，表单由 loader 的 volatile 投影生成）。
 * 两个方法都按可选声明，运行时按存在性分派，同一份代码在新旧宿主上都能装配。
 */
interface SettingsSectionHooks {
  setSource: (source: () => Config) => void
  onChange: () => void
}

interface SettingsServiceLike {
  installSection?: (
    owner: unknown,
    ns: string,
    schema: z<Config>,
    entry: Config,
    hooks: SettingsSectionHooks,
  ) => void
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
}

/**
 * 本插件在 settings 里的命名空间。
 *
 * dsh 0.1.7+ 由 loader 投影：`describe()` 用 `ns: entry.options.id`（profile 里
 * 就是 `cmdgo-provider`）。Models 页回查该供应商的配置时用的正是同一个键，所以
 * `registerConfigurableProviders` 必须报这个值；自报的 `NS` 只作为老宿主的回落。
 */
function settingsNamespace(ctx: Context): string {
  const entry = (ctx.fiber as { entry?: { options?: { id?: unknown } } } | undefined)?.entry
  const id = entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : NS
}

/**
 * schema（含嵌套）是否声明了至少一个 volatile 字段。
 *
 * 子 schema 挂在**节点本体**的 `dict` / `inner` / `list` 上，不在 `meta` 里；
 * 第一版写成 `meta.dict` 会永远返回 false（等于恒定误报「设置页不会显示」）。
 */
function hasVolatileField(schema: unknown): boolean {
  const node = schema as {
    meta?: { volatile?: boolean }
    dict?: Record<string, unknown>
    inner?: unknown
    list?: readonly unknown[]
  } | undefined
  if (node === undefined || node === null) return false
  if (node.meta?.volatile === true) return true
  return Object.values(node.dict ?? {}).some(child => hasVolatileField(child))
    || hasVolatileField(node.inner)
    || (node.list ?? []).some(child => hasVolatileField(child))
}

// `.volatile()` 只存在于 `@deepseek-ai/schemastery` 3.18.3+（3.18.2 及更早既没有
// 类型也没有运行时——裸 `schemastery` 更是永远没有）。这里按能力探测而不是按声明
// 的 peer 最低版：声明 `^3.18.1` 只保证**装得上**，装到 3.18.1/3.18.2 时标记会
// 静默缺失，等于设置页整块消失，所以 0.1.7+ 上必须显式报出来（见 apply()）。
/** 标明该字段可被 dsh 0.1.7+ 的设置页渲染为可编辑表单（0.1.5 忽略该 meta）。 */
function volatile<T extends object>(schema: T): T {
  // 字段级 API 在实例上（`Schema.prototype.volatile`），不在工厂函数 `z` 上。
  const mark = (schema as { volatile?: () => T }).volatile
  return typeof mark === 'function' ? mark.call(schema) : schema
}

export const Config: z<Config> = z.object({
  // 每个字段都必须 volatile：dsh 0.1.7 起设置页只渲染 volatile 字段
  // （`dsh-settings` 的 `volatileForm()`），漏标 = 该字段在设置页上不存在；
  // 这也是 0.1.5 的 `installSection` 路径与 0.1.7 的 loader 投影路径唯一能共用
  // 的写法（0.1.5 忽略该 meta）。
  apiKeyEnv: volatile(z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV)),
  baseURL: volatile(z.string().default(DEFAULT_BASE_URL)),
  maxTokens: volatile(z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS)),
  defaultContextWindow: volatile(z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)),
  retryPolicy: volatile(RetryPolicySchema),
}) as unknown as z<Config>

/**
 * volatile 配置引用的写入标记（`@deepseek-ai/cosmokit` 的
 * `Symbol.for('cosmokit.volatile.write')`）。
 *
 * 刻意**不** import cosmokit：`isVolatile` 只是「这个符号在不在」的包装，而
 * `Symbol.for` 是跨 realm / 跨 ESM-CJS 副本共享的注册表键，所以这里直接用同一个
 * 键判定即可。好处是插件在那个包缺席（老宿主、精简安装）时依然能装配——直接
 * import 一个可选的 peer 会让整个插件在它缺失时链接失败。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/**
 * 读取边界统一解引用：volatile 字段解析出来是 `{ get() }` 持有器，消费方
 * （adapter 连接事实、凭据 ref）要的是裸值。旧宿主给裸值，原样透传。
 *
 * 未知键原样保留：`Object.entries` 是 `string`，直接 `as Config` 会把「其实
 * 多带了键」这件事藏起来（`plainConfig` 在 loader/volatile-update 路径上还会
 * 吃到宿主给的整块对象）。
 */
function plainConfig(config: Config): Config {
  if (typeof config !== 'object' || config === null) return config
  // 持有器：解引用一次（`get()` 返回的是不可变快照，直接消费即可）。
  const write = (config as { [VOLATILE_WRITE]?: unknown })[VOLATILE_WRITE]
  if (write !== undefined && typeof (config as { get?: () => unknown }).get === 'function') {
    return plainConfig((config as unknown as { get: () => Config }).get())
  }
  // 数组整体保留形状：逐个键递归会把数组变成 `{"0":…}`，下游的
  // `retryableCodes.some(...)` 之类会直接炸掉。
  if (Array.isArray(config)) {
    return config.map(entry => plainConfig(entry as Config)) as unknown as Config
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(config)) {
    out[key] = plainConfig((config as Record<string, unknown>)[key] as Config)
  }
  return out as Config
}

/** 从原始配置到已校验连接事实的唯一归一化步骤。 */
export function resolveAdapterOptions(config: Config, scanned: readonly CommandCodeGoModel[]): CommandCodeGoConnectionOptions {
  if (config.defaultContextWindow !== undefined
    && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error('cmdgo: defaultContextWindow must be a positive integer')
  }
  if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error('cmdgo: maxTokens must be a positive safe integer')
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models: scanned,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, 'cmdgo: retryPolicy'),
  }
}

export function apply(ctx: Context, config: Config): void {
  // 实时扫描的目录放在 settings 快照之外：扫描结果不能被设置写入覆盖；
  // adapter 通过 thunk 读合并视图。
  let scanned: CommandCodeGoModel[] = []
  // 首个快照就要解引用：0.1.7+ 丢给插件的 config 里 volatile 字段是 `{ get() }`
  // 持有器（见 plainConfig）。apply 因此保持同步——cordis 不 await 插件回调，
  // 这里一旦改成 async，它后面的注册代码就会和 fiber 的装载赛跑。
  let current: () => Config = () => plainConfig(config)
  let cache: { raw: Config; scanned: readonly CommandCodeGoModel[]; options: CommandCodeGoConnectionOptions } | undefined
  const options = (): CommandCodeGoConnectionOptions => {
    const raw = current()
    if (cache !== undefined && cache.raw === raw && cache.scanned === scanned) {
      return cache.options
    }
    try {
      const next = resolveAdapterOptions(raw, scanned)
      cache = { raw, scanned, options: next }
      return next
    } catch (error) {
      if (cache === undefined) throw error
      ctx.logger.error('cmdgo: 设置区块非法，沿用上一次有效配置')
      ctx.logger.error(error)
      cache = { raw, scanned: cache.scanned, options: cache.options }
      return cache.options
    }
  }
  options()

  const currentRef = (): CredentialRef => options().apiKeyEnv

  // --- 多账号池：每个 OAuth 登录的 key 独立成账号，轮询调度摊薄额度 ---
  const pool = new AccountPool(currentRef(), (message) => { ctx.logger.info(message) })
  ctx.inject(['credentials'], (cctx) => { void pool.adoptLegacy(cctx.get('credentials')) })
  // 收编兜底：冷启动竞态下首试可能扑空，慢轮询重试直到池非空（此后为无害空转）。
  const adoptTimer = setInterval(() => {
    void pool.adoptLegacy(ctx.get('credentials'))
  }, 30_000)
  adoptTimer.unref?.()
  ctx.effect(() => () => { clearInterval(adoptTimer) })

  // --- 账号额度：5 小时 / 周滚动窗口 + 月度额度（官方 CLI `/usage` 同源接口）---
  // 状态接口每 2.5s 被前端轮询一次，所以这里只读缓存、按 TTL 在后台补刷新，
  // 保证 /status 永远不会被上游额度请求拖慢。
  const usageReader = new UsageReader({
    baseURL: () => options().baseURL,
    log: (message) => { ctx.logger.info(message) },
  })

  // --- 调用计量：实测「平均单次消耗」，用于估算理论剩余调用次数 ---
  // 网关不返回调用次数，只能自己把「请求计数」与「额度差」对齐（见 meter.ts）。
  const meter = new CallMeter({ log: (message) => { ctx.logger.info(message) } })
  ctx.effect(() => () => { meter.dispose() })

  // --- 请求用量台账：缓存读 / 写按会话聚合，供 HUD 验证缓存亲和（issue #6） ---
  // 纯内存，进程内有效；不落盘、不含凭据。
  const requestStats = new RequestStats()

  // --- 用户偏好：模型可见性（黑名单）+ 会话头部 HUD 开关 ---
  // 落盘 ~/.dsh/cmdgo-prefs.json。模型开关只影响 profile 里的目录展示，
  // 不参与请求路由（见 adapter.listModels 注释）。
  const prefs = new CmdgoPrefs(undefined, (message) => { ctx.logger.info(message) })
  // 立即加载：listModels() 可能在首个请求就同步读取 hiddenIds。
  void prefs.ensureLoaded()

  /** 取账号的 API key；池账号与主 ref 通用（只用 account.ref）。 */
  const accountKey = async (account: { ref: CredentialRef }): Promise<string | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    return pool.keyOf(credentials, account)
  }

  /** 即发即忘地补一次额度快照；TTL 内或已有请求在飞时直接跳过。 */
  const refreshUsage = (account: { ref: CredentialRef }): void => {
    if (!usageReader.stale(account.ref)) return
    void accountKey(account).then((key) => {
      if (key === undefined) {
        usageReader.markMissing(account.ref)
        return undefined
      }
      return usageReader.refresh(account.ref, key).then((snapshot) => {
        meter.noteUsage(account.ref, snapshot.monthly.remaining)
        return snapshot
      })
    }).catch(() => { /* 失败原因已记录在 reader 里，UI 会显示 warning */ })
  }

  /** 强制刷新（设置页「刷新额度」），等待完成后返回。 */
  const forceRefreshUsage = async (account: { ref: CredentialRef }): Promise<void> => {
    const key = await accountKey(account)
    if (key === undefined) {
      usageReader.markMissing(account.ref)
      return
    }
    await usageReader.refresh(account.ref, key, { force: true })
      .then((snapshot) => { meter.noteUsage(account.ref, snapshot.monthly.remaining) })
      .catch(() => {})
  }

  const resolveApiKey = async (): Promise<string> => {
    const ref = currentRef()
    const credentials = ctx.get('credentials')
    // 账号池就绪时走轮询调度；冷却中的账号由 pool.pick() 自动跳过。
    if (pool.size > 0 && credentials !== undefined) {
      const account = pool.pick()
      if (account !== undefined) {
        const key = await pool.keyOf(credentials, account)
        if (key !== undefined) return assertUsableApiKey(key, 'cmdgo', account.ref)
      }
      throw new LlmError(
        `cmdgo: 账号池 ${pool.size} 个账号当前均不可用（全部冷却或凭据缺失）；请到 设置 → CommandCode Go 查看账号状态`,
        'MISSING_CREDENTIAL',
      )
    }
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'cmdgo', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'cmdgo', ref)
      }
    }
    throw new LlmError(
      `cmdgo: 供应商路由 "${PROVIDER}" 没有 API key；请到 设置 → CommandCode Go 完成登录，`
      + `或在凭据中配置 ${ref}`,
      'MISSING_CREDENTIAL',
    )
  }

  // --- OAuth 登录管理器 ---
  const login = new CommandCodeLoginManager((message) => { ctx.logger.info(message) })
  let loginPromise: Promise<LoginSuccessInfo> | undefined

  ctx.effect(() => () => { void login.stop('plugin disposed') })

  /** 回调成功后的持久化：key 入池（重复登录只刷新标签），立即生效。 */
  async function persistKey(info: LoginSuccessInfo): Promise<void> {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      ctx.logger.warn('[cmdgo] credentials 服务不可用，API key 无法落盘；请手动写入 ~/.dsh/.credentials.yaml')
      return
    }
    try {
      const known = await pool.findByKey(credentials, info.apiKey)
      if (known !== undefined) {
        pool.touchMeta(known, { userName: info.userName, keyName: info.keyName })
        ctx.logger.info(`[cmdgo] 该 key 已在账号池（${known.id}），仅刷新标签`)
        return
      }
      const account = await pool.add(credentials, info)
      ctx.logger.info(`[cmdgo] API key 已入池 ${account.ref}${info.userName === undefined ? '' : `（user=${info.userName}）`}`)
      // 新账号立即拉一次额度，设置页无需等待 TTL。
      void forceRefreshUsage(account)
    } catch (error) {
      ctx.logger.error('[cmdgo] 凭据写入失败')
      ctx.logger.error(error)
    }
  }

  /** 开始一次登录：幂等——等待中重复调用返回同一个登录地址。 */
  async function beginLogin(): Promise<{ authUrl: string; callbackUrl: string }> {
    const started = await login.start({ studioBase: DEFAULT_STUDIO_BASE })
    if (loginPromise === undefined || !login.isWaiting()) {
      loginPromise = login.waitForCallback().then(
        (info) => { void persistKey(info); return info },
        (error: unknown) => {
          ctx.logger.warn('[cmdgo] 登录结束：%s', error instanceof Error ? error.message : String(error))
          throw error
        },
      )
      // 后台等待；拒绝由上面分支记录，避免 unhandled rejection。
      loginPromise.catch(() => {})
    }
    return started
  }

  /** 客户端可见的状态快照（绝不携带 API key 明文）。 */
  async function statusSnapshot(forSessionId?: string): Promise<{
    provider: string
    credentialRef: string
    credentialConfigured: boolean
    credentialSource?: string
    modelCount: number
    login: LoginStatus
    activeAccounts: number
    accounts: Array<{
      id: string
      ref: string
      userName?: string
      keyName?: string
      addedAt: number
      enabled: boolean
      failCount: number
      cooling: boolean
      lastError?: string
      configured: boolean
      /** 池为空时为主 ref 的只读展示行（不可启停/移除）。 */
      synthetic?: boolean
      /** 该账号的额度快照；首次轮询时可能尚未就绪。 */
      usage?: UsageStatus
    }>
    /** 实测调用计量：平均单次消耗 → 理论剩余调用次数。 */
    meter: MeterSnapshot
    /** 缓存读 / 写台账（按会话聚合，见 request-stats.ts）。 */
    cache: RequestStatsView
    /** 最近一次目录同步的错误；为空表示目录已就绪。 */
    catalogError?: string
    /** 当前**可见**的模型 id（已应用模型开关），供设置页渲染开关列表。 */
    models: string[]
    /**
     * 每个模型的每 100 万 token 费率，按模型 id 索引。
     *
     * 只有官方 CLI 目录到货的模型才在表里 —— 拿不到目录时整个字段为空对象，
     * 设置页据此不显示价格（而不是显示 0）。
     */
    pricing: Record<string, ModelPricing>
    /** 用户偏好：关闭的模型 + HUD 开关 + 设置页配色方案。 */
    prefs: { hiddenModels: string[]; hudEnabled: boolean; theme: CmdgoThemePreference }
  }> {
    const ref = currentRef()
    const credentials = ctx.get('credentials')
    let configured = false
    let source: string | undefined
    if (credentials !== undefined) {
      const info = await credentials.describe(ref)
      if (info !== undefined) {
        configured = info.configured
        source = info.source
      }
    }
    const now = Date.now()
    const pooled = await pool.list()
    // 池为空但主 ref 有 key 时也展示一行：升级用户在被收编前同样能看到额度。
    const listed: Array<PoolAccount & { synthetic?: boolean }> = pooled.length > 0
      ? pooled
      : (configured ? [{ id: 'default', ref, addedAt: 0, enabled: true, failCount: 0, synthetic: true }] : [])
    const rows = await Promise.all(listed.map(async (account) => {
      let accountConfigured = false
      if (credentials !== undefined) {
        try { accountConfigured = (await credentials.describe(account.ref)).configured } catch (_describeFailure) { /* 视为缺失 */ }
      }
      refreshUsage(account)
      return {
        id: account.id,
        ref: account.ref,
        ...(account.userName === undefined ? {} : { userName: account.userName }),
        ...(account.keyName === undefined ? {} : { keyName: account.keyName }),
        addedAt: account.addedAt,
        enabled: account.enabled,
        failCount: account.failCount,
        cooling: (account.cooldownUntil ?? 0) > now,
        ...(account.lastError === undefined ? {} : { lastError: account.lastError }),
        configured: accountConfigured,
        ...(account.synthetic === true ? { synthetic: true } : {}),
        usage: usageReader.snapshot(account.ref),
      }
    }))
    return {
      provider: PROVIDER,
      credentialRef: ref,
      credentialConfigured: configured,
      ...(source === undefined ? {} : { credentialSource: source }),
      modelCount: scanned.length,
      ...(catalogError === undefined ? {} : { catalogError }),
      login: login.status,
      activeAccounts: pool.activeCount(now),
      meter: meter.snapshot(),
      cache: requestStats.view(forSessionId),
      accounts: rows,
      // 完整目录（含被关闭的）：设置页要能列出隐藏项才能把它们打开。
      models: scanned.map((model) => model.id),
      // 费率表：只含官方目录公布过价格的模型。
      pricing: Object.fromEntries(
        scanned
          .filter((model): model is typeof model & { pricing: ModelPricing } => model.pricing !== undefined)
          .map((model) => [model.id, model.pricing]),
      ),
      prefs: prefs.snapshot(),
    }
  }

  // --- /api/cmdgo HTTP 路由（供客户端设置页调用） ---
  // webServer 是可选服务且挂载顺序不受本插件控制：一次性 ctx.get 在冷启动时
  // 可能拿到 undefined 导致路由永远缺失（前端面板在、点登录却 404）。
  // 用 inject 回调：服务何时就绪何时注册，随 fiber 卸载自动撤销。
  const installRoutes = (sctx: Context): void => {
    const webServer = sctx.get('webServer') as {
      register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => () => void
    } | undefined
    if (webServer === undefined) return
    const readJson = async (req: { on: (event: string, cb: (chunk?: Buffer) => void) => void }): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      let size = 0
      await new Promise<void>((resolve) => {
        req.on('data', (chunk?: Buffer) => {
          size += chunk?.length ?? 0
          if (size <= 64 * 1024 && chunk !== undefined) chunks.push(chunk)
        })
        req.on('end', () => resolve())
        req.on('error', () => resolve())
      })
      if (chunks.length === 0) return {}
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : {}
      } catch {
        return {}
      }
    }

    const sendJson = (rawRes: unknown, statusCode: number, body: unknown): void => {
      const res = rawRes as { statusCode?: number; setHeader: (k: string, v: string) => void; end: (data?: string) => void }
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(body))
    }

    const route = {
      kind: 'prefix',
      path: '/api/cmdgo',
      handler: async (rawReq: unknown, rawRes: unknown): Promise<void> => {
        const req = rawReq as {
          method?: string
          url?: string
          headers?: Record<string, string | string[] | undefined>
          on: (event: string, cb: (chunk?: Buffer) => void) => void
        }
        const pathname = (req.url ?? '/').split('?')[0].replace(/\/+$/, '')
        const action = pathname.slice('/api/cmdgo'.length) || '/'
        // 会话头部传来的 sessionId：只用于把缓存台账定位到「本会话」。
        const query = (req.url ?? '').split('?')[1] ?? ''
        const forSessionId = new URLSearchParams(query).get('sessionId') ?? undefined
        // --- 浏览器信任 / 鉴权闸门 ---
        // 这些路由此前既无鉴权也不校验 Origin/Content-Type：恶意页面能用
        // CORS 安全列表类型（text/plain，不触发预检）跨站 POST，静默触发
        // /usage/refresh（消耗额度）或 /account/remove（删除账号）。
        // 优先复用 connection 服务自带的闸门（与 harness 保护 /api/* 同一套），
        // 它在 0.0.0.0 部署与 LAN 访问下也正确；缺席时退化为本机最小围墙。
        const headers = req.headers ?? {}
        const connection = ctx.get('connection') as ConnectionGate | undefined
        const rejection = connection !== undefined
          ? connection.requestRejection({ headers })
          : browserTrustRejection(headers)
        if (rejection !== undefined) {
          ctx.logger.warn('[cmdgo] 已拒绝 %s %s（HTTP %d）', req.method ?? 'GET', pathname, rejection)
          sendJson(rawRes, rejection, {
            ok: false,
            error: rejection === 401
              ? '需要浏览器会话凭据：请从 dsh web 打印的地址打开页面'
              : '已拒绝跨站或非本机请求',
          })
          return
        }
        // 跨站「简单请求」兜底：只接受 JSON 正文（其它类型会被浏览器
        // 当安全列表请求直接发出，从而绕过预检）。
        if (req.method === 'POST' && !/application\/json/i.test(String(headers['content-type'] ?? ''))) {
          sendJson(rawRes, 415, { ok: false, error: 'Content-Type 必须是 application/json' })
          return
        }
        try {
          if (req.method === 'GET' && (action === '/status' || action === '/')) {
            sendJson(rawRes, 200, { ok: true, ...(await statusSnapshot(forSessionId)) })
            return
          }
          if (req.method === 'POST' && action === '/login') {
            await readJson(req)
            const started = await beginLogin()
            sendJson(rawRes, 200, { ok: true, ...started })
            return
          }
          if (req.method === 'POST' && action === '/cancel') {
            await readJson(req)
            await login.stop('用户取消')
            sendJson(rawRes, 200, { ok: true })
            return
          }
          if (req.method === 'POST' && action === '/account/toggle') {
            const body = await readJson(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const enabled = body.enabled === true
            const changed = id.length > 0 && pool.toggle(id, enabled)
            sendJson(rawRes, changed ? 200 : 404, changed
              ? { ok: true }
              : { ok: false, error: '账号不存在或状态未变化' })
            return
          }
          if (req.method === 'POST' && action === '/account/remove') {
            const body = await readJson(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (id.length === 0) {
              sendJson(rawRes, 400, { ok: false, error: 'missing id' })
              return
            }
            const removed = await pool.remove(ctx.get('credentials'), id)
            sendJson(rawRes, removed ? 200 : 404, removed
              ? { ok: true }
              : { ok: false, error: '账号不存在' })
            return
          }
          if (req.method === 'POST' && action === '/usage/refresh') {
            const body = await readJson(req)
            const id = typeof body.id === 'string' ? body.id : ''
            const pooled = await pool.list()
            const targets = id.length > 0 ? pooled.filter((a) => a.id === id) : pooled
            // 池为空时刷新主 ref（与 /status 的合成行对应）。
            const accounts: Array<{ ref: CredentialRef }> = targets.length > 0 ? targets : [{ ref: currentRef() }]
            await Promise.all(accounts.map((account) => forceRefreshUsage(account)))
            sendJson(rawRes, 200, { ok: true, refreshed: accounts.length })
            return
          }
          if (req.method === 'POST' && action === '/logout') {
            await readJson(req)
            const credentials = ctx.get('credentials')
            const removed = await pool.clear(credentials)
            // 兼容旧语义：池为空时仍清掉主 ref（未入池的手动 key）。
            if (removed === 0 && credentials !== undefined) await credentials.unset(currentRef())
            sendJson(rawRes, 200, { ok: true, removed })
            return
          }
          // --- 模型开关 ---
          // 关闭/打开单个模型。语义为黑名单：只有被显式关闭的才进 hidden。
          if (req.method === 'POST' && action === '/model/toggle') {
            const body = await readJson(req)
            const id = typeof body.id === 'string' ? body.id : ''
            if (id.length === 0) {
              sendJson(rawRes, 400, { ok: false, error: 'missing id' })
              return
            }
            await prefs.setModelHidden(id, body.hidden === true)
            // 目录变了要让 Models 页与 composer 立刻重取：replace 会广播
            // `llm/adapters-updated`，客户端的 catalog.refresh() 随之触发。
            registration.replace([PROVIDER])
            sendJson(rawRes, 200, { ok: true, ...prefs.snapshot() })
            return
          }
          // 批量关闭当前目录里的全部模型（「全部关闭」）。
          if (req.method === 'POST' && action === '/model/hide-all') {
            await readJson(req)
            await prefs.hideMany(scanned.map((model) => model.id))
            registration.replace([PROVIDER])
            sendJson(rawRes, 200, { ok: true, ...prefs.snapshot() })
            return
          }
          // 清空黑名单（「全部打开」）。刻意不看当前目录，直接清空所有键。
          if (req.method === 'POST' && action === '/model/show-all') {
            await readJson(req)
            await prefs.clearHidden()
            registration.replace([PROVIDER])
            sendJson(rawRes, 200, { ok: true, ...prefs.snapshot() })
            return
          }
          // --- 会话头部 HUD 开关 ---
          if (req.method === 'POST' && action === '/hud/toggle') {
            const body = await readJson(req)
            await prefs.setHudEnabled(body.enabled !== false)
            sendJson(rawRes, 200, { ok: true, ...prefs.snapshot() })
            return
          }
          // --- 设置页配色方案（light / dark / system） ---
          // 只存偏好，不碰宿主的主题：本插件自己的面板可以独立于 harness 的
          // 外观设置（见 prefs.ts 的 CmdgoThemePreference 注释）。
          if (req.method === 'POST' && action === '/theme/set') {
            const body = await readJson(req)
            // 边界校验：body 来自 HTTP，可能是任意值。认不出来就 400，
            // 而不是静默写一个脏值进存档（那样下次启动会退回默认，用户会
            // 觉得"点了没反应"）。
            if (!isCmdgoThemePreference(body.theme)) {
              sendJson(rawRes, 400, { ok: false, error: 'invalid theme' })
              return
            }
            await prefs.setThemePreference(body.theme)
            sendJson(rawRes, 200, { ok: true, ...prefs.snapshot() })
            return
          }
          sendJson(rawRes, 404, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          sendJson(rawRes, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    // effect 必须挂在 inject 回调的作用域 ctx 上：挂外层 ctx 时 entry 移除
    // 可能不触发本作用域的 disposer，路由就成了清不掉的孤儿（0.1.2 教训）。
    sctx.effect(() => webServer.register(route))
  }

  ctx.inject(['webServer'], (sctx) => { installRoutes(sctx) })

  // --- 供应商注册 ---
  /** 找到 key 所属账号（池记账用）；找不到返回 undefined。 */
  const accountForKey = async (apiKey: string): Promise<PoolAccount | undefined> => {
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    return pool.findByKey(credentials, apiKey)
  }
  // --- 图像输入：把 harness 的附件引用解析成网关要的 data URL ---
  // 附件服务是可选的：没有它时适配器会把图片降级成占位文字，绝不静默丢图。
  const requestImageEncoding = { maxPixels: DEFAULT_REQUEST_IMAGE_PIXELS, maxBytes: DEFAULT_REQUEST_IMAGE_BYTES }
  // 图片读取失败每个 attachmentId 只告警一次：同一张图会在重试/续写里反复出现，
  // 刷屏没有意义；但一条都不发，用户就只能靠模型念占位文字来发现视觉挂了（#12）。
  const imageWarned = new Set<string>()

  /**
   * 按宿主版本选 `readImageRequest` 的第二参数（issue #12）：
   *
   * - 0.2.x 要 `ImageRequestTarget`（`{ width, height, maxBytes }`）：用宿主同一套
   *   `requestImageDimensions()` 几何从 ref 投影出目标尺寸，`validateTarget()` 才放行；
   * - 0.1.x 要 `ImageRequestPolicy`（`{ maxPixels, maxBytes }`）：宿主自己投影。
   *
   * 运行时无法可靠探测宿主版本（0.2.x 的类型在旧 peer 里不存在），所以先发新
   * 形状、`validateTarget` 拒了再回退旧形状——两侧各只走一次，结果按 ref 缓存，
   * 不会在每次请求里反复试错。
   */
  const shapeCache = new Map<string, ImageRequestShape>()
  const readRequestImage = async (
    attachments: ImageAttachmentService,
    ref: ImageAttachmentRefLike,
  ): Promise<{ data: Uint8Array; mediaType: string }> => {
    const cached = shapeCache.get(ref.attachmentId)
    if (cached !== undefined) return attachments.readImageRequest(ref, cached, undefined)
    const target: ImageRequestShape = {
      ...requestImageDimensions(ref.width, ref.height, requestImageEncoding.maxPixels),
      maxBytes: requestImageEncoding.maxBytes,
    }
    try {
      const projected = await attachments.readImageRequest(ref, target, undefined)
      shapeCache.set(ref.attachmentId, target)
      return projected
    } catch (error) {
      // 回退旧形状前先看新形状是不是真的被拒了：其它错误（附件缺失、解码失败）
      // 在旧宿主上同样会失败，不该再试一次。判据用 0.2.x validateTarget 的
      // 实际报错文本（"Image request width must be a positive integer."）。
      const message = error instanceof Error ? error.message : String(error)
      if (!/Image request (width|height|maxBytes)/.test(message)) throw error
      const legacy: ImageRequestShape = { ...requestImageEncoding }
      const projected = await attachments.readImageRequest(ref, legacy, undefined)
      shapeCache.set(ref.attachmentId, legacy)
      return projected
    }
  }

  /** 读取一份附件的请求版本并编码成 `data:<mediaType>;base64,<bytes>`。 */
  const resolveImage: ImageResolver = async (block) => {
    const attachments = ctx.get('attachments') as ImageAttachmentService | undefined
    if (attachments === undefined) return undefined
    try {
      const projected = await readRequestImage(attachments, block.attachment)
      return `data:${projected.mediaType};base64,${Buffer.from(projected.data).toString('base64')}`
    } catch (error) {
      // 占位文字仍由协议层给出（半截成功不能被翻成整轮失败），但原因必须留下：
      // 这次 issue 就是靠模型念出占位文字才定位到根因的。
      const message = error instanceof Error ? error.message : String(error)
      const id = String(block.attachment.attachmentId)
      if (!imageWarned.has(id)) {
        imageWarned.add(id)
        ctx.logger.warn(
          '[cmdgo] 附件 %s 的请求图像读取失败，本轮以占位文字替代：%s',
          id.slice(0, 23),
          message,
        )
      }
      throw error
    }
  }

  const adapter = new CommandCodeGoAdapter({
    options,
    resolveApiKey,
    resolveImage,
    poolSize: () => Math.max(1, pool.size),
    // 模型开关：只过滤 listModels() 的目录展示，不影响请求路由。
    hiddenIds: () => prefs.hiddenIds,
    onKeySuccess: async (apiKey) => {
      const account = await accountForKey(apiKey)
      if (account !== undefined) {
        pool.reportSuccess(account)
        meter.noteCall(account.ref)
        return
      }
      // 未入池（池为空时的主 ref / env key）：与 /status 的合成行同 ref 记账。
      meter.noteCall(currentRef())
    },
    onKeyFailure: async (apiKey, message) => {
      const account = await accountForKey(apiKey)
      if (account !== undefined) pool.reportFailure(account, message)
    },
    // 每次完成的请求都把用量（含缓存读 / 写）记进台账：HUD 用它能直接看出
    // 缓存有没有命中（issue #6 的补充诉求）。
    onRequestUsage: (usage) => { requestStats.record(usage) },
    // 网关判「某个 tool-call 缺结果」时的自愈：丢掉它重发，让卡死的会话能继续
    // （issue #5）。这条日志是用户判断「为什么这一轮重试了」的唯一线索。
    onRepair: (info) => {
      ctx.logger.warn(
        '[cmdgo] 请求形状自愈：网关报缺工具结果，丢掉 %s 后重试（model=%s）',
        info.toolCallIds.join(', '),
        info.model,
      )
    },
  })
  ctx.llm.registerConfigurableProviders([
    // 命名空间必须跟 dsh 0.1.7+ 的 settings 投影一致：那一代 `describe()` 用
    // `ns: entry.options.id`（profile 里的 `cmdgo-provider`），而不是插件自报的
    // `cmdgo`——两者不一致时 Models 页按 settingsNs 回查配置会找不到（issue #8
    // 的第三节）。老宿主上 entry 不存在，回落到自报 NS。
    { provider: PROVIDER, displayName: 'Command Code Go', settingsNs: settingsNamespace(ctx), settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  // dsh 0.1.7+ 的 loader 会在 volatile 配置被提交后向拥有者 fiber 派发
  // `loader/volatile-update`。settings 的 volatile 快照是**原地更新**的稳定引用
  // （config 对象身份不变），所以插件里按身份做键的 `options()` 缓存永远不会自己
  // 失效——不监听就会出现「设置页改了值但不生效」。`ensureRegistrationFacts` 顺带
  // 承担重读（retryPolicy 变了要重新注册路由）。旧宿主不发这个事件，监听是空转。
  // 事件名按字符串走 cordis 的运行期事件总线：0.1.7 的 Events 表里有它，旧宿主的
  // 类型里没有，写死字符串 + 断言即可，不必为这个可选事件抬高类型下限。
  ;(ctx as unknown as { on: (event: string, listener: () => void) => void })
    .on('loader/volatile-update', () => {
      ensureRegistrationFacts()
    })

  // settings 区块注册：两代 API 都要支持，而且都必须在注入回调里注册
  // （旧版是顶层函数 installSettingsSection）。
  //
  // - dsh 0.1.5 / 0.1.6：`settings.installSection(owner, ns, schema, entry, hooks)`
  //   —— 由插件主动装一个区块，ns 由插件自报。
  // - dsh 0.1.7+：`installSection` 已被删除。settings 翻转为「投影 loader 配置」：
  //   带 `.volatile()` 的字段由 `volatileForm()` 渲染成可编辑表单，命名空间键是
  //   **entry id**（`entry.options.id`，即 profile 里的 `cmdgo-provider`），而不是
  //   插件自报的 NS。因此这里改用 `configure({ auto: false }, ctx.fiber)`，并让
  //   `registerConfigurableProviders` 的 settingsNs 跟随 entry id。
  ctx.inject(['settings'], (settingsCtx) => {
    // cordis 注入的服务既在 `get()` 表里也挂成访问器；两条都试，任一条可用即可。
    // 两条都拿不到时不注册（而不是抛错）：一次注入竞态不该炸掉整个插件装配。
    const settings = (settingsCtx.get('settings') ?? settingsCtx.settings) as SettingsServiceLike | undefined
    if (settings === undefined) {
      ctx.logger.warn('[cmdgo] settings 服务不可用，设置页区块本次未注册')
      return
    }
    settingsCtx.effect(() => {
      if (typeof settings.installSection === 'function') {
        // 老路：0.1.5/0.1.6 的主动安装。ns 用自报值（那代 describe() 也用这个键）。
        settings.installSection(ctx, NS, Config, config, {
          setSource: (source) => {
            current = () => plainConfig(source())
          },
          onChange: ensureRegistrationFacts,
        })
        return () => {}
      }
      if (typeof settings.configure !== 'function') return () => {}
      // 新路：只声明页面策略，表单由 loader 投影产生（见上）。
      const dispose = settings.configure({ auto: false }, ctx.fiber)
      // 配置目录里没有 volatile 字段时设置页会整块消失——0.1.7 起最常见的
      // 故障形态就是「插件看着正常、设置页没了且 stderr 无输出」。显式报错，
      // 别让它再静默。
      if (!hasVolatileField(Config)) {
        ctx.logger.error('[cmdgo] Config 没有任何 volatile 字段，设置页不会显示该区块（dsh 0.1.7+ 的投影契约）')
      }
      return dispose
    })
  })

  // --- 模型目录实时同步 ---
  // 用 setTimeout 链而不是 setInterval：首扫失败必须立刻重试，不能干等 15 分钟。
  let refreshTimer: ReturnType<typeof setTimeout> | undefined

  ctx.effect(() => () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = undefined
  })

  // 实时模态注册表：离线快照没见过的模型才去拉（2.5 MB），且最多 6 小时一次。
  let liveModalities: Map<string, string[]> | undefined
  let modalityAttemptAt = 0

  /**
   * 补齐离线快照里没有的模型模态。目录里全是已知 id 时零网络开销；
   * 失败按同样的时间窗退避，不会每次 sync 重试拖慢目录刷新。
   */
  async function ensureModalities(ids: readonly string[]): Promise<Map<string, string[]> | undefined> {
    const unknown = ids.filter((id) => !hasKnownModality(id) && liveModalities?.get(id) === undefined)
    if (unknown.length === 0) return liveModalities
    if (Date.now() - modalityAttemptAt < MODALITY_REFRESH_MS) return liveModalities
    modalityAttemptAt = Date.now()
    try {
      liveModalities = await fetchCatalogModalities()
      ctx.logger.info('[cmdgo] 已同步实时模态注册表（%d 条）：%s', liveModalities.size, unknown.join(', '))
    } catch (error) {
      ctx.logger.warn('[cmdgo] 模态注册表拉取失败（沿用离线快照）: %s', error instanceof Error ? error.message : String(error))
    }
    return liveModalities
  }

  /** 把目录条目转成 adapter 视图；effort 可用时一并带上。 */
  /** 把目录条目转成 adapter 视图；effort / 价格可用时一并带上。 */
  const toScanned = (
    entries: readonly GoModel[],
    efforts?: ReadonlyMap<string, string[]>,
    pricing?: ReadonlyMap<string, ModelPricing>,
  ): CommandCodeGoModel[] =>
    entries.map((entry) => {
      const effort = efforts?.get(entry.id)
      // 价格优先用官方表里的（实时），退回到条目自带的（离线快照）。
      const rate = pricing?.get(entry.id) ?? entry.pricing
      return {
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        inputModalities: entry.inputModalities,
        ...(effort === undefined ? {} : { efforts: effort }),
        ...(rate === undefined ? {} : { pricing: rate }),
      }
    })

  /**
   * 客户端目录投影里会变的部分：id / name / efforts。
   *
   * `buildModelCatalog` 只投影这些字段（外加 description），**不含
   * inputModalities**——所以模态变化不必惊动客户端，effort 变化则必须。
   */
  const clientCatalogKey = (models: readonly CommandCodeGoModel[]): string =>
    models.map(m => `${m.id}\u0000${m.name}\u0000${m.efforts?.join(',') ?? ''}`).join('\u0001')

  /**
   * 换入新目录视图；无变化时不写、不刷屏。
   *
   * **目录到货后必须宣告一次**：`apply()` 里 adapter 是在目录为空时注册的，
   * 而客户端的 `ModelCatalogDirectory` 只在这几个事件上失效——
   * `llm/adapters-updated` / `settings/document-updated` /
   * `credentials/reference-updated`。若页面在首扫完成前加载，它会缓存
   * 「commandcode 有 0 个模型」的快照，随后 host 侧的
   * `buildModelCatalog` 又会把 0 模型的供应商分组过滤掉，于是重启后先打开页面
   * 就看不到该供应商，直到手动刷新。（登录后能看到，是因为写凭据会触发
   * `credentials/reference-updated`，把这个问题掩盖了。）
   *
   * `registration.replace()` 正是发布 `llm/adapters-updated` 的入口——dsh-llm 的
   * 注释写明「a `replace` announces itself exactly like a first registration」。
   * 只在与客户端可见投影真正变化时宣告，避免纯模态变化造成无谓的客户端重载。
   */
  const publish = (next: CommandCodeGoModel[]): void => {
    if (deepEqualJson(next, scanned)) return
    const changedForClient = clientCatalogKey(next) !== clientCatalogKey(scanned)
    scanned = next
    const visionCount = next.filter(m => m.inputModalities?.includes('image')).length
    ctx.logger.info('[cmdgo] synced %d Go model(s)（%d 个支持图像）: %s', next.length, visionCount, next.map(m => m.id).join(', '))
    if (changedForClient) registration.replace([PROVIDER])
  }

  /**
   * 扫描 Go 目录并换入 adapter 视图。
   *
   * 顺序很关键：**先发布模型列表，再补可选元数据**。模型模态来自离线快照
   * （同步且完整），因此列表本身不必等 jsDelivr 的 effort 元数据，更不必等
   * 那 2.5 MB 的实时注册表——否则上游一慢，用户在整个等待期看到的就是
   * 「0 个模型」，而 dsh 会把 0 模型的供应商分组整个过滤掉。
   */
  async function sync(): Promise<void> {
    // 目录只拉一次、且**不过滤**：官方表格到货后要能用它的档位判据重新筛选，
    // 而预先过滤掉的模型无法再捞回来（#7）。
    const all = await fetchAllModels()
    if (all.length === 0) {
      throw new Error('provider listing is empty; keeping the previous catalog')
    }
    let entries = selectGoModels(all)
    if (entries.length === 0) {
      throw new Error('no Go models found; keeping the previous catalog')
    }
    publish(toScanned(entries))
    // effort / 档位 / 费率来自同一张官方表，一次抓取同时得到三者。
    // 尽力而为：慢或被墙都不影响已经可用的模型列表。
    let efforts: Map<string, string[]> | undefined
    let pricing: Map<string, ModelPricing> | undefined
    let plans: Map<string, boolean> | undefined
    try {
      ({ efforts, pricing, plans } = await fetchCatalog())
    } catch (error) {
      ctx.logger.warn('[cmdgo] effort catalog scan failed: %s', error instanceof Error ? error.message : String(error))
    }
    // 官方 `Min plan` 列是档位的权威判据：既能把静态规则漏掉的补回来
    // （被官方升档的模型，如 muse-spark-1.3-contributor），也能把降档的移出去，
    // 无需等插件发版。
    if (plans !== undefined) {
      const overlaid = selectGoModels(all, plans)
      if (overlaid.length === 0) {
        ctx.logger.warn('[cmdgo] 官方档位表把所有模型都判为非 Go，沿用静态规则结果')
      } else {
        entries = overlaid
        publish(toScanned(entries, efforts, pricing))
      }
    } else if (efforts !== undefined || pricing !== undefined) {
      publish(toScanned(entries, efforts, pricing))
    }
    // 目录出现快照未知的模型时，才补拉实时模态注册表。
    const live = await ensureModalities(entries.map(entry => entry.id))
    if (live !== undefined) publish(toScanned(applyModalities(entries, live), efforts, pricing))
  }

  // 首扫失败必须快速重试：设备刚启动时网络往往还没就绪，若沿用 15 分钟周期，
  // 模型列表会整整空 15 分钟（UI 表现为「同步模型 0」）。
  const RETRY_BACKOFF_MS = [3_000, 10_000, 30_000, 60_000]
  let retryIndex = 0
  let catalogError: string | undefined

  const schedule = (delayMs: number): void => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { void runSync() }, delayMs)
    refreshTimer.unref?.()
  }

  async function runSync(): Promise<void> {
    try {
      await sync()
      retryIndex = 0
      catalogError = undefined
      schedule(REFRESH_MS)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      catalogError = message
      // 已有目录时按常规周期重试；一次都还没成功则快速退避重试。
      const delay = scanned.length > 0
        ? REFRESH_MS
        : RETRY_BACKOFF_MS[Math.min(retryIndex, RETRY_BACKOFF_MS.length - 1)]!
      retryIndex += 1
      ctx.logger.warn('[cmdgo] 模型目录同步失败（%ds 后重试）: %s', Math.round(delay / 1000), message)
      schedule(delay)
    }
  }

  void runSync()
}
