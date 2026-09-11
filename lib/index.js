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
import z from '@deepseek-ai/schemastery';
import { assertUsableApiKey, LlmError, resolveRetryPolicy, RetryPolicySchema } from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson } from '@deepseek-ai/dsh-util-values';
import { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from './adapter.js';
import { fetchCatalogEfforts, fetchGoModels } from './models.js';
import { DEFAULT_STUDIO_BASE, CommandCodeLoginManager } from './oauth.js';
import { AccountPool } from './pool.js';
import { UsageReader } from './usage.js';
export { CommandCodeGoAdapter, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, } from './adapter.js';
export { fetchCatalogEfforts, fetchGoModels, isGoModel, parseCatalogEfforts } from './models.js';
export { CommandCodeLoginManager, DEFAULT_STUDIO_BASE } from './oauth.js';
export { UsageReader, normalizeUsage, resolvePlan } from './usage.js';
export const name = 'dsh-cmdgo-provider';
/** llm 是硬依赖（供应商路由）；webServer / credentials 可选，按需 ctx.get。 */
export const inject = ['llm'];
const NS = 'cmdgo';
const PROVIDER = 'commandcode';
const DEFAULT_API_KEY_ENV = 'COMMANDCODE_API_KEY';
/** 网关 base；`/alpha/generate` 自动追加。 */
const DEFAULT_BASE_URL = 'https://api.commandcode.ai';
/** 目录扫描周期；模型列表稳定，慢轮询足够。 */
const REFRESH_MS = 15 * 60 * 1000;
export const Config = z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
    baseURL: z.string().default(DEFAULT_BASE_URL),
    maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
    defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
    retryPolicy: RetryPolicySchema,
});
/** 从原始配置到已校验连接事实的唯一归一化步骤。 */
export function resolveAdapterOptions(config, scanned) {
    if (config.defaultContextWindow !== undefined
        && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
        throw new Error('cmdgo: defaultContextWindow must be a positive integer');
    }
    if (config.maxTokens !== undefined && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
        throw new Error('cmdgo: maxTokens must be a positive safe integer');
    }
    return {
        apiKeyEnv: credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV),
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        defaultContextWindow: config.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        models: scanned,
        retryPolicy: resolveRetryPolicy(config.retryPolicy, 'cmdgo: retryPolicy'),
    };
}
export function apply(ctx, config) {
    // 实时扫描的目录放在 settings 快照之外：扫描结果不能被设置写入覆盖；
    // adapter 通过 thunk 读合并视图。
    let scanned = [];
    let current = () => config;
    let cache;
    const options = () => {
        const raw = current();
        if (cache !== undefined && cache.raw === raw && cache.scanned === scanned) {
            return cache.options;
        }
        try {
            const next = resolveAdapterOptions(raw, scanned);
            cache = { raw, scanned, options: next };
            return next;
        }
        catch (error) {
            if (cache === undefined)
                throw error;
            ctx.logger.error('cmdgo: 设置区块非法，沿用上一次有效配置');
            ctx.logger.error(error);
            cache = { raw, scanned: cache.scanned, options: cache.options };
            return cache.options;
        }
    };
    options();
    const currentRef = () => options().apiKeyEnv;
    // --- 多账号池：每个 OAuth 登录的 key 独立成账号，轮询调度摊薄额度 ---
    const pool = new AccountPool(currentRef(), (message) => { ctx.logger.info(message); });
    ctx.inject(['credentials'], (cctx) => { void pool.adoptLegacy(cctx.get('credentials')); });
    // 收编兜底：冷启动竞态下首试可能扑空，慢轮询重试直到池非空（此后为无害空转）。
    const adoptTimer = setInterval(() => {
        void pool.adoptLegacy(ctx.get('credentials'));
    }, 30_000);
    adoptTimer.unref?.();
    ctx.effect(() => () => { clearInterval(adoptTimer); });
    // --- 账号额度：5 小时 / 周滚动窗口 + 月度额度（官方 CLI `/usage` 同源接口）---
    // 状态接口每 2.5s 被前端轮询一次，所以这里只读缓存、按 TTL 在后台补刷新，
    // 保证 /status 永远不会被上游额度请求拖慢。
    const usageReader = new UsageReader({
        baseURL: () => options().baseURL,
        log: (message) => { ctx.logger.info(message); },
    });
    /** 取账号的 API key；池账号与主 ref 通用（只用 account.ref）。 */
    const accountKey = async (account) => {
        const credentials = ctx.get('credentials');
        if (credentials === undefined)
            return undefined;
        return pool.keyOf(credentials, account);
    };
    /** 即发即忘地补一次额度快照；TTL 内或已有请求在飞时直接跳过。 */
    const refreshUsage = (account) => {
        if (!usageReader.stale(account.ref))
            return;
        void accountKey(account).then((key) => {
            if (key === undefined) {
                usageReader.markMissing(account.ref);
                return undefined;
            }
            return usageReader.refresh(account.ref, key);
        }).catch(() => { });
    };
    /** 强制刷新（设置页「刷新额度」），等待完成后返回。 */
    const forceRefreshUsage = async (account) => {
        const key = await accountKey(account);
        if (key === undefined) {
            usageReader.markMissing(account.ref);
            return;
        }
        await usageReader.refresh(account.ref, key, { force: true }).catch(() => { });
    };
    const resolveApiKey = async () => {
        const ref = currentRef();
        const credentials = ctx.get('credentials');
        // 账号池就绪时走轮询调度；冷却中的账号由 pool.pick() 自动跳过。
        if (pool.size > 0 && credentials !== undefined) {
            const account = pool.pick();
            if (account !== undefined) {
                const key = await pool.keyOf(credentials, account);
                if (key !== undefined)
                    return assertUsableApiKey(key, 'cmdgo', account.ref);
            }
            throw new LlmError(`cmdgo: 账号池 ${pool.size} 个账号当前均不可用（全部冷却或凭据缺失）；请到 设置 → CommandCode Go 查看账号状态`, 'MISSING_CREDENTIAL');
        }
        if (credentials !== undefined) {
            const hit = await credentials.resolve(ref);
            if (hit !== undefined)
                return assertUsableApiKey(hit.value, 'cmdgo', ref);
        }
        else {
            const ambient = launchEnvironmentOf(ctx).get(ref);
            if (ambient !== undefined && ambient.value.length > 0) {
                return assertUsableApiKey(ambient.value, 'cmdgo', ref);
            }
        }
        throw new LlmError(`cmdgo: 供应商路由 "${PROVIDER}" 没有 API key；请到 设置 → CommandCode Go 完成登录，`
            + `或在凭据中配置 ${ref}`, 'MISSING_CREDENTIAL');
    };
    // --- OAuth 登录管理器 ---
    const login = new CommandCodeLoginManager((message) => { ctx.logger.info(message); });
    let loginPromise;
    ctx.effect(() => () => { void login.stop('plugin disposed'); });
    /** 回调成功后的持久化：key 入池（重复登录只刷新标签），立即生效。 */
    async function persistKey(info) {
        const credentials = ctx.get('credentials');
        if (credentials === undefined) {
            ctx.logger.warn('[cmdgo] credentials 服务不可用，API key 无法落盘；请手动写入 ~/.dsh/.credentials.yaml');
            return;
        }
        try {
            const known = await pool.findByKey(credentials, info.apiKey);
            if (known !== undefined) {
                pool.touchMeta(known, { userName: info.userName, keyName: info.keyName });
                ctx.logger.info(`[cmdgo] 该 key 已在账号池（${known.id}），仅刷新标签`);
                return;
            }
            const account = await pool.add(credentials, info);
            ctx.logger.info(`[cmdgo] API key 已入池 ${account.ref}${info.userName === undefined ? '' : `（user=${info.userName}）`}`);
            // 新账号立即拉一次额度，设置页无需等待 TTL。
            void forceRefreshUsage(account);
        }
        catch (error) {
            ctx.logger.error('[cmdgo] 凭据写入失败');
            ctx.logger.error(error);
        }
    }
    /** 开始一次登录：幂等——等待中重复调用返回同一个登录地址。 */
    async function beginLogin() {
        const started = await login.start({ studioBase: DEFAULT_STUDIO_BASE });
        if (loginPromise === undefined || !login.isWaiting()) {
            loginPromise = login.waitForCallback().then((info) => { void persistKey(info); return info; }, (error) => {
                ctx.logger.warn('[cmdgo] 登录结束：%s', error instanceof Error ? error.message : String(error));
                throw error;
            });
            // 后台等待；拒绝由上面分支记录，避免 unhandled rejection。
            loginPromise.catch(() => { });
        }
        return started;
    }
    /** 客户端可见的状态快照（绝不携带 API key 明文）。 */
    async function statusSnapshot() {
        const ref = currentRef();
        const credentials = ctx.get('credentials');
        let configured = false;
        let source;
        if (credentials !== undefined) {
            const info = await credentials.describe(ref);
            if (info !== undefined) {
                configured = info.configured;
                source = info.source;
            }
        }
        const now = Date.now();
        const pooled = await pool.list();
        // 池为空但主 ref 有 key 时也展示一行：升级用户在被收编前同样能看到额度。
        const listed = pooled.length > 0
            ? pooled
            : (configured ? [{ id: 'default', ref, addedAt: 0, enabled: true, failCount: 0, synthetic: true }] : []);
        const rows = await Promise.all(listed.map(async (account) => {
            let accountConfigured = false;
            if (credentials !== undefined) {
                try {
                    accountConfigured = (await credentials.describe(account.ref)).configured;
                }
                catch (_describeFailure) { /* 视为缺失 */ }
            }
            refreshUsage(account);
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
            };
        }));
        return {
            provider: PROVIDER,
            credentialRef: ref,
            credentialConfigured: configured,
            ...(source === undefined ? {} : { credentialSource: source }),
            modelCount: scanned.length,
            login: login.status,
            activeAccounts: pool.activeCount(now),
            accounts: rows,
        };
    }
    // --- /api/cmdgo HTTP 路由（供客户端设置页调用） ---
    // webServer 是可选服务且挂载顺序不受本插件控制：一次性 ctx.get 在冷启动时
    // 可能拿到 undefined 导致路由永远缺失（前端面板在、点登录却 404）。
    // 用 inject 回调：服务何时就绪何时注册，随 fiber 卸载自动撤销。
    const installRoutes = (sctx) => {
        const webServer = sctx.get('webServer');
        if (webServer === undefined)
            return;
        const readJson = async (req) => {
            const chunks = [];
            let size = 0;
            await new Promise((resolve) => {
                req.on('data', (chunk) => {
                    size += chunk?.length ?? 0;
                    if (size <= 64 * 1024 && chunk !== undefined)
                        chunks.push(chunk);
                });
                req.on('end', () => resolve());
                req.on('error', () => resolve());
            });
            if (chunks.length === 0)
                return {};
            try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
                    ? parsed
                    : {};
            }
            catch {
                return {};
            }
        };
        const sendJson = (rawRes, statusCode, body) => {
            const res = rawRes;
            res.statusCode = statusCode;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(body));
        };
        const route = {
            kind: 'prefix',
            path: '/api/cmdgo',
            handler: async (rawReq, rawRes) => {
                const req = rawReq;
                const pathname = (req.url ?? '/').split('?')[0].replace(/\/+$/, '');
                const action = pathname.slice('/api/cmdgo'.length) || '/';
                try {
                    if (req.method === 'GET' && (action === '/status' || action === '/')) {
                        sendJson(rawRes, 200, { ok: true, ...(await statusSnapshot()) });
                        return;
                    }
                    if (req.method === 'POST' && action === '/login') {
                        await readJson(req);
                        const started = await beginLogin();
                        sendJson(rawRes, 200, { ok: true, ...started });
                        return;
                    }
                    if (req.method === 'POST' && action === '/cancel') {
                        await readJson(req);
                        await login.stop('用户取消');
                        sendJson(rawRes, 200, { ok: true });
                        return;
                    }
                    if (req.method === 'POST' && action === '/account/toggle') {
                        const body = await readJson(req);
                        const id = typeof body.id === 'string' ? body.id : '';
                        const enabled = body.enabled === true;
                        const changed = id.length > 0 && pool.toggle(id, enabled);
                        sendJson(rawRes, changed ? 200 : 404, changed
                            ? { ok: true }
                            : { ok: false, error: '账号不存在或状态未变化' });
                        return;
                    }
                    if (req.method === 'POST' && action === '/account/remove') {
                        const body = await readJson(req);
                        const id = typeof body.id === 'string' ? body.id : '';
                        if (id.length === 0) {
                            sendJson(rawRes, 400, { ok: false, error: 'missing id' });
                            return;
                        }
                        const removed = await pool.remove(ctx.get('credentials'), id);
                        sendJson(rawRes, removed ? 200 : 404, removed
                            ? { ok: true }
                            : { ok: false, error: '账号不存在' });
                        return;
                    }
                    if (req.method === 'POST' && action === '/usage/refresh') {
                        const body = await readJson(req);
                        const id = typeof body.id === 'string' ? body.id : '';
                        const pooled = await pool.list();
                        const targets = id.length > 0 ? pooled.filter((a) => a.id === id) : pooled;
                        // 池为空时刷新主 ref（与 /status 的合成行对应）。
                        const accounts = targets.length > 0 ? targets : [{ ref: currentRef() }];
                        await Promise.all(accounts.map((account) => forceRefreshUsage(account)));
                        sendJson(rawRes, 200, { ok: true, refreshed: accounts.length });
                        return;
                    }
                    if (req.method === 'POST' && action === '/logout') {
                        await readJson(req);
                        const credentials = ctx.get('credentials');
                        const removed = await pool.clear(credentials);
                        // 兼容旧语义：池为空时仍清掉主 ref（未入池的手动 key）。
                        if (removed === 0 && credentials !== undefined)
                            await credentials.unset(currentRef());
                        sendJson(rawRes, 200, { ok: true, removed });
                        return;
                    }
                    sendJson(rawRes, 404, { ok: false, error: `unknown action: ${action}` });
                }
                catch (error) {
                    sendJson(rawRes, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
                }
            },
        };
        // effect 必须挂在 inject 回调的作用域 ctx 上：挂外层 ctx 时 entry 移除
        // 可能不触发本作用域的 disposer，路由就成了清不掉的孤儿（0.1.2 教训）。
        sctx.effect(() => webServer.register(route));
    };
    ctx.inject(['webServer'], (sctx) => { installRoutes(sctx); });
    // --- 供应商注册 ---
    /** 找到 key 所属账号（池记账用）；找不到返回 undefined。 */
    const accountForKey = async (apiKey) => {
        const credentials = ctx.get('credentials');
        if (credentials === undefined)
            return undefined;
        return pool.findByKey(credentials, apiKey);
    };
    const adapter = new CommandCodeGoAdapter({
        options,
        resolveApiKey,
        poolSize: () => Math.max(1, pool.size),
        onKeySuccess: async (apiKey) => {
            const account = await accountForKey(apiKey);
            if (account !== undefined)
                pool.reportSuccess(account);
        },
        onKeyFailure: async (apiKey, message) => {
            const account = await accountForKey(apiKey);
            if (account !== undefined)
                pool.reportFailure(account, message);
        },
    });
    ctx.llm.registerConfigurableProviders([
        { provider: PROVIDER, displayName: 'Command Code Go', settingsNs: NS, settingsPath: [] },
    ]);
    const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
    let registeredPolicy = options().retryPolicy;
    const ensureRegistrationFacts = () => {
        const policy = options().retryPolicy;
        if (deepEqualJson(policy, registeredPolicy))
            return;
        registration.replace([PROVIDER]);
        registeredPolicy = policy;
    };
    // dsh 0.1.5 起 settings 区块改为服务方法 `ctx.settings.installSection`，
    // 必须在注入 settings 服务的回调里注册（旧版是顶层函数 installSettingsSection）。
    ctx.inject(['settings'], (settingsCtx) => {
        settingsCtx.settings.installSection(ctx, NS, Config, config, {
            setSource: (source) => {
                current = source;
            },
            onChange: ensureRegistrationFacts,
        });
    });
    // --- 模型目录实时同步 ---
    let refreshTimer;
    ctx.effect(() => () => {
        if (refreshTimer !== undefined)
            clearInterval(refreshTimer);
        refreshTimer = undefined;
    });
    /** 扫描 Go 目录并换入 adapter 视图。 */
    async function sync() {
        const entries = await fetchGoModels();
        if (entries.length === 0) {
            throw new Error('no Go models found; keeping the previous catalog');
        }
        // effort 元数据尽力而为：目录抖动不能拖垮模型列表。
        let efforts = new Map();
        try {
            efforts = await fetchCatalogEfforts();
        }
        catch (error) {
            ctx.logger.warn('[cmdgo] effort catalog scan failed: %s', error instanceof Error ? error.message : String(error));
        }
        const next = entries.map(entry => ({
            id: entry.id,
            name: entry.name,
            contextWindow: entry.contextWindow,
            ...(efforts.get(entry.id) === undefined ? {} : { efforts: efforts.get(entry.id) }),
        }));
        if (deepEqualJson(next, scanned))
            return;
        scanned = next;
        ctx.logger.info('[cmdgo] synced %d Go model(s): %s', next.length, next.map(m => m.id).join(', '));
    }
    void sync().catch((error) => {
        ctx.logger.warn('[cmdgo] 初始模型目录扫描失败: %s', error instanceof Error ? error.message : String(error));
    });
    refreshTimer = setInterval(() => {
        void sync().catch((error) => {
            ctx.logger.warn('[cmdgo] 模型目录刷新失败: %s', error instanceof Error ? error.message : String(error));
        });
    }, REFRESH_MS);
    refreshTimer.unref?.();
}
