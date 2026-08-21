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
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { buildRequest, CC_VERSION, DEFAULT_MAX_TOKENS, eventToChunks, gatewayErrorMessage, parseEventStream } from './protocol.js';
/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;
export { DEFAULT_MAX_TOKENS };
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const OFF_REASONING_EFFORT = ReasoningEffortId('off');
/** Effort labels in the gateway's own vocabulary, for selector display. */
const EFFORT_LABELS = {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'X-High',
    max: 'Max',
};
/** The full reasoning-effort ladder the gateway accepts, low to high. */
const FULL_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
function effortInfo(effort) {
    return { id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort };
}
function modelInfo(provider, model) {
    return {
        provider,
        id: model.id,
        name: model.name ?? model.id,
        inputModalities: ['text'],
    };
}
/**
 * Build the reasoning-effort selector for one model. Models whose effort
 * support is known expose exactly their supported levels (plus `off`);
 * models without metadata expose the full ladder (`off` plus minimal to
 * max) so every gateway level stays reachable. No default effort is pinned:
 * the gateway decides when a request names none.
 */
function reasoningFor(model) {
    const efforts = model?.efforts;
    const levels = efforts !== undefined && efforts.length > 0
        ? efforts
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
    async *stream(options) {
        const env_1 = { stack: [], error: void 0, hasError: false };
        try {
            const connection = this.config.options();
            const apiKey = await this.config.resolveApiKey();
            const consumer = new AbortController();
            const upstream = options.signal === undefined
                ? consumer.signal
                : AbortSignal.any([options.signal, consumer.signal]);
            const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE), false);
            const iterator = this.request(options, watchdog.signal, connection, apiKey)[Symbol.asyncIterator]();
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
    async *request(options, signal, connection, apiKey) {
        const body = buildRequest(options);
        const payload = JSON.stringify(body);
        const headers = {
            'authorization': `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'x-command-code-version': CC_VERSION,
            'x-cli-environment': 'production',
            'x-co-flag': 'false',
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
        if (!response.body) {
            throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE');
        }
        const state = { blockIndex: 0 };
        for await (const event of parseEventStream(response.body)) {
            // Each distinct content stream (text / reasoning / tool-call) opens its
            // own block index in arrival order.
            if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
                state.blockIndex += 1;
            }
            yield* eventToChunks(event, state);
            if (event.type === 'finish-step')
                return;
        }
        // Gateway closed without a finish-step: treat as truncated.
        throw new LlmError('Command Code stream ended without finish-step', 'STREAM_CLOSED');
    }
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
