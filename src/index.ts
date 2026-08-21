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
 *    生成登录地址、等待回调状态、退出登录。
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
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './adapter.js'
import type { CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
import { fetchCatalogEfforts, fetchGoModels } from './models.js'
import { DEFAULT_STUDIO_BASE, CommandCodeLoginManager } from './oauth.js'
import type { LoginSuccessInfo, LoginStatus } from './oauth.js'

export {
  CommandCodeGoAdapter,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
} from './adapter.js'
export type { CommandCodeGoAdapterOptions, CommandCodeGoConnectionOptions, CommandCodeGoModel } from './adapter.js'
export { fetchCatalogEfforts, fetchGoModels, isGoModel, parseCatalogEfforts } from './models.js'
export { CommandCodeLoginManager, DEFAULT_STUDIO_BASE } from './oauth.js'
export type { LoginStatus, LoginSuccessInfo } from './oauth.js'

export const name = 'dsh-cmdgo-provider'
/** llm 是硬依赖（供应商路由）；webServer / credentials 可选，按需 ctx.get。 */
export const inject = ['llm']

const NS = settingsNamespace('cmdgo')
const PROVIDER = 'commandcode'
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY'

/** 网关 base；`/alpha/generate` 自动追加。 */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai'
/** 目录扫描周期；模型列表稳定，慢轮询足够。 */
const REFRESH_MS = 15 * 60 * 1000

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

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  retryPolicy: RetryPolicySchema,
})

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
  let current: () => Config = () => config
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

  const resolveApiKey = async (): Promise<string> => {
    const ref = currentRef()
    const credentials = ctx.get('credentials')
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

  /** 回调成功后的持久化：API Key 写入凭据存储，立即生效。 */
  async function persistKey(info: LoginSuccessInfo): Promise<void> {
    const ref = currentRef()
    const credentials = ctx.get('credentials')
    if (credentials === undefined) {
      ctx.logger.warn('[cmdgo] credentials 服务不可用，API key 无法落盘；请手动写入 ~/.dsh/.credentials.yaml')
      return
    }
    try {
      await credentials.set(ref, info.apiKey)
      ctx.logger.info(`[cmdgo] API key 已写入凭据 ${ref}${info.userName === undefined ? '' : `（user=${info.userName}）`}`)
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
  async function statusSnapshot(): Promise<{
    provider: string
    credentialRef: string
    credentialConfigured: boolean
    credentialSource?: string
    modelCount: number
    login: LoginStatus
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
    return {
      provider: PROVIDER,
      credentialRef: ref,
      credentialConfigured: configured,
      ...(source === undefined ? {} : { credentialSource: source }),
      modelCount: scanned.length,
      login: login.status,
    }
  }

  // --- /api/cmdgo HTTP 路由（供客户端设置页调用） ---
  const webServer = ctx.get('webServer') as {
    register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }) => () => void
  } | undefined

  if (webServer !== undefined) {
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
        const req = rawReq as { method?: string; url?: string; on: (event: string, cb: (chunk?: Buffer) => void) => void }
        const pathname = (req.url ?? '/').split('?')[0].replace(/\/+$/, '')
        const action = pathname.slice('/api/cmdgo'.length) || '/'
        try {
          if (req.method === 'GET' && (action === '/status' || action === '/')) {
            sendJson(rawRes, 200, { ok: true, ...(await statusSnapshot()) })
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
          if (req.method === 'POST' && action === '/logout') {
            await readJson(req)
            const credentials = ctx.get('credentials')
            if (credentials !== undefined) await credentials.unset(currentRef())
            sendJson(rawRes, 200, { ok: true })
            return
          }
          sendJson(rawRes, 404, { ok: false, error: `unknown action: ${action}` })
        } catch (error) {
          sendJson(rawRes, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    }
    ctx.effect(() => webServer.register(route))
  } else {
    ctx.logger.warn('[cmdgo] webServer 服务不存在，CommandCode Go 登录页面不可用（供应商本身不受影响）')
  }

  // --- 供应商注册 ---
  const adapter = new CommandCodeGoAdapter({ options, resolveApiKey })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Command Code Go', settingsNs: NS, settingsPath: [] },
  ])
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = options().retryPolicy
  const ensureRegistrationFacts = (): void => {
    const policy = options().retryPolicy
    if (deepEqualJson(policy, registeredPolicy)) return
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
    onChange: ensureRegistrationFacts,
  })

  // --- 模型目录实时同步 ---
  let refreshTimer: ReturnType<typeof setInterval> | undefined

  ctx.effect(() => () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    refreshTimer = undefined
  })

  /** 扫描 Go 目录并换入 adapter 视图。 */
  async function sync(): Promise<void> {
    const entries = await fetchGoModels()
    if (entries.length === 0) {
      throw new Error('no Go models found; keeping the previous catalog')
    }
    // effort 元数据尽力而为：目录抖动不能拖垮模型列表。
    let efforts = new Map<string, string[]>()
    try {
      efforts = await fetchCatalogEfforts()
    } catch (error) {
      ctx.logger.warn('[cmdgo] effort catalog scan failed: %s', error instanceof Error ? error.message : String(error))
    }
    const next = entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      ...(efforts.get(entry.id) === undefined ? {} : { efforts: efforts.get(entry.id)! }),
    }))
    if (deepEqualJson(next, scanned)) return
    scanned = next
    ctx.logger.info('[cmdgo] synced %d Go model(s): %s', next.length, next.map(m => m.id).join(', '))
  }

  void sync().catch((error: unknown) => {
    ctx.logger.warn('[cmdgo] 初始模型目录扫描失败: %s', error instanceof Error ? error.message : String(error))
  })
  refreshTimer = setInterval(() => {
    void sync().catch((error: unknown) => {
      ctx.logger.warn('[cmdgo] 模型目录刷新失败: %s', error instanceof Error ? error.message : String(error))
    })
  }, REFRESH_MS)
  refreshTimer.unref?.()
}
