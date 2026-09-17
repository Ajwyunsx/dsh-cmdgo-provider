/**
 * Command Code Go adapter: a harness `LlmAdapter` whose stream transport is
 * Command Code's private `/alpha/generate` gateway, which is the only
 * endpoint a Go-plan subscription can call (the OpenAI-compatible Provider
 * API answers 403 for Go).
 *
 * The adapter is transport-only: connection facts (base URL, catalog,
 * reasoning defaults) arrive through a thunk resolved once per operation and
 * the bearer key through a per-request resolver, so the registering plugin
 * owns validation, layering, and credential policy. Model metadata — the
 * scanned Go catalog — flows through `listModels()` / `resolveModel()`.
 *
 * @module commandcode-go/adapter
 */
var __addDisposableResource = (this && this.__addDisposableResource) || function (env, value, async) {
    if (value !== null && value !== void 0) {
        if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
        var dispose, inner;
        if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
        }
        if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
        }
        if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
        if (inner) dispose = function() { try { inner.call(this); } catch (e) { return Promise.reject(e); } };
        env.stack.push({ value: value, dispose: dispose, async: async });
    }
    else if (async) {
        env.stack.push({ async: true });
    }
    return value;
};
var __disposeResources = (this && this.__disposeResources) || (function (SuppressedError) {
    return function (env) {
        function fail(e) {
            env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
            env.hasError = true;
        }
        var r, s = 0;
        function next() {
            while (r = env.stack.pop()) {
                try {
                    if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
                    if (r.dispose) {
                        var result = r.dispose.call(r.value);
                        if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) { fail(e); return next(); });
                    }
                    else s |= 1;
                }
                catch (e) {
                    fail(e);
                }
            }
            if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
            if (env.hasError) throw env.error;
        }
        return next();
    };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
    var e = new Error(message);
    return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
import { attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError, LlmAdapter, LlmError, ReasoningEffortId, } from '@deepseek-ai/dsh-llm';
import { createHash, randomUUID } from 'node:crypto';
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { buildRequest, CC_VERSION, DEFAULT_MAX_TOKENS, eventToChunks, gatewayErrorMessage, parseEventStream, streamErrorCode, streamErrorText, usageSummary } from './protocol.js';
/** Hard cap on same-request key failovers, even for very large pools. */
const MAX_FAILOVER_ATTEMPTS = 4;
/** Hard cap on history self-heals (drop a gateway-named tool call and retry). */
const MAX_REPAIR_ATTEMPTS = 4;
/**
 * Official CLI session-id shape: `sess_<16 lowercase hex>`, minted once per CLI
 * process by `generateSessionId()` (`sess_${randomUUID().replace(/-/g,'').substring(0,16)}`).
 *
 * 早先这里发的是 `cli-<ISO 时间戳>`：既没有 `sess_` 字头、形状也和 CLI 不同，
 * 而上游网关对 `x-session-id` 是做格式识别/会话级缓存亲和的（同类适配器的社区
 * 先例里，缺会话头会直接 400 MissingSessionID）。issue #6 报告了这一点。
 *
 * 额外的语义修正：CLI 是**一会话一 id**（同一次进程里所有请求复用），所以本
 * 适配器按 harness 的会话身份派生成稳定 id —— 同一个对话的续写/重试复用同一个
 * id（保住缓存亲和），不同对话互不串味（旧实现整进程共用一个 id）。harness 没
 * 盖会话身份时（一次性调用）退回进程级常量，保持 CLI 的行为。
 */
const PROCESS_SESSION_ID = `sess_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
/** 会话身份 → 官方形状的稳定 session id（16 位小写十六进制）。 */
export function cliSessionIdFor(sessionId) {
    if (sessionId === undefined || sessionId.length === 0)
        return PROCESS_SESSION_ID;
    return `sess_${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
}
/**
 * CLI-shaped project slug: the official CLI derives `x-project-slug` from the
 * current working directory name (CommandCode CLI convention, e.g. `cc-proxy`).
 * Ours is a stable per-install slug so the gateway sees one consistent client.
 */
const PROJECT_SLUG = 'dsh-cmdgo';
function buildCliSessionId(sessionId) {
    return cliSessionIdFor(sessionId);
}
function buildProjectSlug() {
    return PROJECT_SLUG;
}
/** Error codes that justify switching to another account within one request. */
const FAILOVER_CODES = new Set(['AUTH', 'RATE_LIMIT', 'SERVER', 'TRANSPORT']);
function isFailoverError(error) {
    return error instanceof LlmError && FAILOVER_CODES.has(error.failure.code);
}
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export { DEFAULT_MAX_TOKENS };
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_REASONING_EFFORT = ReasoningEffortId('off');
/**
 * Effort labels in the gateway's own vocabulary, for selector display.
 *
 * `off` is NOT a level the gateway accepts — it is the CLI's own sentinel for
 * "name no effort and let the provider decide" (the bundled CLI does
 * `if (!n || "off" === n) return;` before building the request). It is labelled
 * `Auto` rather than `Off` on purpose: omitting the field does not disable
 * reasoning on this gateway, it selects the provider default, which measured
 * *heavier* than `max` on one model (121 vs 47 reasoning tokens).
 */
const EFFORT_LABELS = {
    off: 'Auto',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
};
/**
 * The ladder used when a model's own effort list is unknown.
 *
 * Exactly the vocabulary the bundled CLI accepts (`Cw = ["low","medium",
 * "high","xhigh","max"]`). `minimal` is deliberately absent: it is NOT in that
 * set, and the gateway answers HTTP 400 `invalid_reasoning_effort` for it
 * (verified on two models) — offering it would only produce guaranteed
 * failures.
 */
const FULL_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
/** Values the gateway accepts; anything else is filtered out of the selector. */
const GATEWAY_EFFORTS = new Set(FULL_EFFORT_LADDER);
function effortInfo(effort) {
    return { id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort };
}
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        // 声明该模型真实接受的模态：漏报会让 harness 把图片换成占位文字
        // （`projectImagesForTextModel`），误报则会让适配器收到它无法发送的图片。
        inputModalities: [...(model.inputModalities ?? ['text'])],
    };
}
/**
 * Build the reasoning-effort selector for one model.
 *
 * Models with a known effort list expose exactly those levels; models whose
 * catalog entry is `—` expose the gateway's accepted ladder. In both cases
 * `Auto` is offered first, meaning "send no effort and let the provider
 * decide" — the same sentinel the bundled CLI uses. No default effort is
 * pinned, so a request that names none stays exactly that.
 *
 * Only values the gateway accepts may appear here: the harness rejects a
 * selection outside this list with `UNSUPPORTED_REASONING_EFFORT`, and the
 * gateway answers HTTP 400 for anything outside its own set.
 */
function reasoningFor(model) {
    const declared = model?.efforts;
    // 声明了档位就只给网关接受的子集；声明了却全是非法值时只留 Auto。
    // 未声明（`—`）时给网关的通用梯子。
    const levels = declared !== undefined && declared.length > 0
        ? declared.filter(effort => GATEWAY_EFFORTS.has(effort))
        : FULL_EFFORT_LADDER;
    return {
        efforts: [
            { id: OFF_REASONING_EFFORT, name: EFFORT_LABELS.off },
            ...levels.map(effortInfo),
        ],
    };
}
/**
 * Command Code Go adapter. One instance serves every model in the scanned Go
 * catalog; the harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    providerInfo(provider) {
        return { id: provider, name: 'Command Code Go' };
    }
    providerRetryPolicy(_provider) {
        return this.config.options().retryPolicy;
    }
    listModels(provider) {
        return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)));
    }
    resolveModel(provider, model, _signal) {
        const connection = this.config.options();
        const configured = connection.models.find(entry => entry.id === model);
        const info = configured === undefined
            ? modelInfo(provider, { id: model, name: model })
            : modelInfo(provider, configured);
        return Promise.resolve({
            ...info,
            context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
            defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
            reasoning: reasoningFor(configured),
        });
    }
    /**
     * Stream one completion. With a pooled key resolver each attempt takes the
     * next account; failures that occur before the first emitted chunk (auth,
     * rate limit, server, transport) fail over to another account inside the
     * same request. Once streaming has started, errors propagate unchanged —
     * a half-delivered answer must never be silently replayed.
     *
     * 另一条独立的容错路径是**历史自愈**：网关判请求形状不合法（点名某个
     * tool-call 缺结果）时，历史里的坏形状会被每一轮重发，会话永久卡死
     * （issue #5）。这里把网关点名的调用丢掉后用**同一个账号**重发一次——
     * 不切账号，所以不会烧别的账号额度，只是让这个会话能继续。
     */
    async *stream(options) {
        const connection = this.config.options();
        const attempts = Math.max(1, Math.min(this.config.poolSize?.() ?? 1, MAX_FAILOVER_ATTEMPTS));
        const dropped = new Set();
        // 只修「这一轮真的发出去的调用」：网关点名的 id 不在请求里时，删掉它什么也
        // 改变不了，重发纯属浪费额度（现场见 issue #5 的 id 就是我们发出去的那个）。
        const declared = declaredToolCallIds(options.messages);
        let repairs = 0;
        // key 在循环外解析，**自愈重试因此复用同一个账号**（池化时 resolveApiKey 每次
        // 调用都会轮询到下一个账号，不能靠"再解析一次"来保持同号）。
        let apiKey = await this.config.resolveApiKey();
        for (let attempt = 0; attempt < attempts; attempt++) {
            const mayFailover = attempt < attempts - 1;
            let yielded = false;
            try {
                for await (const chunk of this.open(options, connection, apiKey, dropped)) {
                    yielded = true;
                    yield chunk;
                }
                return;
            }
            catch (error) {
                // 只修「一个字都没发出去」的请求：已经流出的内容不能悄悄重放。
                const named = yielded ? [] : missingToolCallIds(error);
                const fresh = named.filter(id => declared.has(id) && !dropped.has(id));
                if (fresh.length > 0 && repairs < MAX_REPAIR_ATTEMPTS) {
                    for (const id of fresh)
                        dropped.add(id);
                    repairs += 1;
                    this.fireRepair({ toolCallIds: fresh, message: messageOf(error), model: options.model });
                    // 自愈重试不消耗故障转移预算：attempt-- 与循环自增相抵，apiKey 不变。
                    attempt -= 1;
                    continue;
                }
                if (yielded || !mayFailover || !isFailoverError(error))
                    throw error;
                this.fireKeyFailure(apiKey, messageOf(error));
                // 真正的故障转移：换到下一个账号再试。
                apiKey = await this.config.resolveApiKey();
            }
        }
    }
    /** One guarded upstream exchange: idle watchdog + request + event parse. */
    async *open(options, connection, apiKey, dropToolCallIds) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE), false);
            const repair = dropToolCallIds === undefined || dropToolCallIds.size === 0
                ? undefined
                : { dropToolCallIds };
            const iterator = this.request(options, watchdog.signal, connection, apiKey, repair)[Symbol.asyncIterator]();
            let exhausted = false;
            try {
                while (true) {
                    const result = await watchdog.next(iterator);
                    if (result.done) {
                        exhausted = true;
                        return;
                    }
                    yield result.value;
                }
            }
            catch (error) {
                if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
                    throw new LlmError(`Command Code stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`, 'TIMEOUT', { cause: error });
                }
                if (options.signal?.aborted) {
                    throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error });
                }
                if (error instanceof LlmError)
                    throw error;
                throw new LlmError('Command Code /alpha/generate stream failed', 'TRANSPORT', { cause: error });
            }
            finally {
                consumer.abort('Command Code stream consumer stopped');
                if (!exhausted && iterator.return !== undefined) {
                    try {
                        await iterator.return();
                    }
                    catch (_abortedTransportTeardown) {
                        // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
                    }
                }
            }
        }
        catch (e_1) {
            env_1.error = e_1;
            env_1.hasError = true;
        }
        finally {
            __disposeResources(env_1);
        }
    }
    fireKeyFailure(apiKey, message) {
        void Promise.resolve(this.config.onKeyFailure?.(apiKey, message)).catch(() => { });
    }
    fireRepair(info) {
        try {
            this.config.onRepair?.(info);
        }
        catch (_repairObserverFailure) {
            // 观测回调不影响重试本身。
        }
    }
    /** 上报一次请求的用量（缓存读写一并带上），供宿主做缓存展示。 */
    fireUsage(usage, options) {
        const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId);
        try {
            this.config.onRequestUsage?.({
                ...usage,
                model: options.model,
                ...sessionId === undefined || sessionId.length === 0 ? {} : { sessionId },
                at: Date.now(),
            });
        }
        catch (_usageObserverFailure) {
            // 观测回调不影响流本身。
        }
    }
    async *request(options, signal, connection, apiKey, repair) {
        const body = await buildRequest(options, this.config.resolveImage, repair);
        const payload = JSON.stringify(body);
        const headers = {
            'content-type': 'application/json',
            // 请求指纹对齐官方 cmd CLI（v1.31.0 实测还原）：
            // UA 是 commandcode/<版本>，配合 x-command-code-version / x-cli-environment /
            // x-taste-learning / x-session-id / x-project-slug，反代流量与 CLI 本体不可区分。
            // x-session-id 用官方的 `sess_<16 hex>` 形状，并按 harness 会话身份派生（见 cliSessionIdFor）。
            'user-agent': `commandcode/${CC_VERSION}`,
            'x-command-code-version': CC_VERSION,
            'x-cli-environment': 'production',
            'x-taste-learning': 'false',
            'x-session-id': buildCliSessionId(options.sessionId === undefined ? undefined : String(options.sessionId)),
            'x-project-slug': buildProjectSlug(),
            'authorization': `Bearer ${apiKey}`,
            ...attributionHeaders(),
        };
        let response;
        try {
            response = await fetch(`${connection.baseURL}/alpha/generate`, {
                method: 'POST',
                headers,
                body: payload,
                signal,
            });
        }
        catch (error) {
            if (signal.aborted)
                throw error;
            throw new LlmError(`Command Code request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            const raw = await response.text().catch(() => '');
            const message = gatewayErrorMessage(raw) ?? `Command Code API error (HTTP ${response.status})`;
            throw new LlmError(`${message} [model=${options.model}]`, httpErrorCode(response.status, raw), { status: response.status });
        }
        // 网关已接受该 key：清掉账号上的失败记账。
        void Promise.resolve(this.config.onKeySuccess?.(apiKey)).catch(() => { });
        if (!response.body) {
            throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE');
        }
        const state = { blockIndex: 0 };
        let eventCount = 0;
        let sawError = false;
        for await (const event of parseEventStream(response.body)) {
            eventCount += 1;
            // 网关的 error / abort 是流的真实终止原因。此前它们被忽略，于是流一结束就
            // 报「stream ended without finish-step」，把真正的错误（例如
            // "Tool result is missing for tool call …"）盖掉了。
            if (event.type === 'error') {
                sawError = true;
                const message = streamErrorText(event) ?? 'unknown gateway error';
                throw new LlmError(`Command Code gateway error: ${message} [model=${options.model}]`, streamErrorCode(event, message));
            }
            if (event.type === 'abort') {
                sawError = true;
                throw new LlmError('Command Code gateway aborted the stream', 'ABORTED');
            }
            // Each distinct content stream (text / reasoning / tool-call) opens its
            // own block index in arrival order.
            if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
                state.blockIndex += 1;
            }
            // 用量在事件转 chunk 之前先取一份给宿主（缓存读写要能显示出来，issue #6）。
            if (event.type === 'finish-step' || event.type === 'finish') {
                const usage = usageSummary(event);
                if (usage !== undefined)
                    this.fireUsage(usage, options);
            }
            yield* eventToChunks(event, state);
            // finish-step 或 finish 任一到达都表示本轮已正常结束。
            if (state.finished === true)
                return;
        }
        // Stream ended with no terminal marker at all: genuinely truncated. Report
        // enough context to tell a silent close from a mis-parsed body.
        throw new LlmError(sawError
            ? 'Command Code stream ended right after an error event'
            : `Command Code stream ended without finish-step or finish (${eventCount} event(s) received)`, 'STREAM_CLOSED');
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** 本轮请求里 assistant 声明过的工具调用 id（自愈只针对这些 id）。 */
function declaredToolCallIds(messages) {
    const ids = new Set();
    const walk = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'tool-call')
                ids.add(block.id);
            else if (block.type === 'tool-result')
                walk(block.content);
        }
    };
    for (const message of messages)
        walk(message.content);
    return ids;
}
/**
 * 网关在请求形状校验失败时会点名「哪个 tool-call 缺结果」，例如
 * `Tool result is missing for tool call call_01`。这里把点名的 id 抠出来，
 * 供自愈重试把它们两侧一起丢掉（见 `stream()`）。
 */
const MISSING_TOOL_RESULT_PATTERN = /tool result is missing for tool call[:\s]+["'`]?([A-Za-z0-9_.:@-]+)/gi;
function missingToolCallIds(error) {
    const message = messageOf(error);
    if (!/tool result is missing/i.test(message))
        return [];
    const ids = [];
    for (const match of message.matchAll(MISSING_TOOL_RESULT_PATTERN)) {
        const id = match[1];
        if (id !== undefined && id.length > 0 && !ids.includes(id))
            ids.push(id);
    }
    return ids;
}
/** Map a gateway HTTP status / error body to a stable harness LlmError code. */
function httpErrorCode(status, body) {
    if (status === 401 || status === 403) {
        // MODEL_NOT_IN_PLAN is a plan/permission failure, not a credential one:
        // the key is fine, the selected model is above the Go tier.
        if (body.includes('MODEL_NOT_IN_PLAN'))
            return 'PERMISSION';
        return 'AUTH';
    }
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400) {
        if (isContextWindowExceededError(body))
            return CONTEXT_WINDOW_EXCEEDED_CODE;
        return 'INVALID_REQUEST';
    }
    if (status >= 500)
        return 'SERVER';
    return `HTTP_${status}`;
}
