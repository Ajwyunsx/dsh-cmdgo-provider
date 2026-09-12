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

import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { buildRequest, CC_VERSION, DEFAULT_MAX_TOKENS, eventToChunks, gatewayErrorMessage, parseEventStream, streamErrorCode, streamErrorText } from './protocol.js'
import type { CcStreamState, ImageResolver } from './protocol.js'
import type { ModelInputModality } from './models.js'

/** One catalog model advertised by the adapter. */
export interface CommandCodeGoModel {
  /** Wire model id accepted by the gateway. */
  id: string
  /** Selector label; defaults to {@link id}. */
  name?: string
  /** Known combined request/response context capacity, when disclosed. */
  contextWindow?: number
  /** Per-request output cap. */
  maxTokens?: number
  /** Reasoning-effort ids the gateway accepts for this model, in display order. */
  efforts?: string[]
  /** Input modalities the model accepts; defaults to text-only. */
  inputModalities?: readonly ModelInputModality[]
}

/** Validated connection facts for one operation. */
export interface CommandCodeGoConnectionOptions {
  /** Credential reference resolved per request. */
  apiKeyEnv: CredentialRef
  /** Gateway base URL; `/alpha/generate` is appended. */
  baseURL: string
  /** Default per-request output cap. */
  maxTokens: number
  /** Positive context capacity used when the selected model has no exact value. */
  defaultContextWindow: number
  /** Scanned Go catalog; requests remain unrestricted. */
  models: readonly CommandCodeGoModel[]
  /** Provider-owned model-request retry policy, already resolved. */
  retryPolicy: ResolvedRetryPolicy
}

/** Constructor options for {@link CommandCodeGoAdapter}. */
export interface CommandCodeGoAdapterOptions {
  /** Current validated connection facts; called once per operation. */
  options: () => CommandCodeGoConnectionOptions
  /** Resolve the bearer token for one request; throws `MISSING_CREDENTIAL` when unavailable. */
  resolveApiKey: () => Promise<string>
  /** Account-pool size; bounds per-request failover attempts (default 1). */
  poolSize?: () => number
  /** The gateway accepted a request under this key — clear its failure bookkeeping. */
  onKeySuccess?: (apiKey: string) => void | Promise<void>
  /** A request failed on this key before the first byte — cool the account down. */
  onKeyFailure?: (apiKey: string, message: string) => void | Promise<void>
  /**
   * Resolve harness image attachments into gateway data URLs. Absent when the
   * host has no attachment service: images then degrade to a placeholder
   * instead of vanishing.
   */
  resolveImage?: ImageResolver
}

/** Hard cap on same-request key failovers, even for very large pools. */
const MAX_FAILOVER_ATTEMPTS = 4

/**
 * CLI-shaped session id: `cli-<YYYY-MM-DDTHH-mm-ss>`, mirroring the id the
 * official `cmd` CLI mints per session (used in `x-session-id`). Process
 * scoped: all pooled accounts share one id per harness process, exactly like
 * one CLI process would.
 */
const SESSION_ID = `cli-${new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')}`

/**
 * CLI-shaped project slug: the official CLI derives `x-project-slug` from the
 * current working directory name (CommandCode CLI convention, e.g. `cc-proxy`).
 * Ours is a stable per-install slug so the gateway sees one consistent client.
 */
const PROJECT_SLUG = 'dsh-cmdgo'

function buildCliSessionId(): string {
  return SESSION_ID
}

function buildProjectSlug(): string {
  return PROJECT_SLUG
}

/** Error codes that justify switching to another account within one request. */
const FAILOVER_CODES = new Set(['AUTH', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'])

function isFailoverError(error: unknown): boolean {
  return error instanceof LlmError && FAILOVER_CODES.has(error.failure.code)
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export { DEFAULT_MAX_TOKENS }

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')

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
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: 'Auto',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/**
 * The ladder used when a model's own effort list is unknown.
 *
 * Exactly the vocabulary the bundled CLI accepts (`Cw = ["low","medium",
 * "high","xhigh","max"]`). `minimal` is deliberately absent: it is NOT in that
 * set, and the gateway answers HTTP 400 `invalid_reasoning_effort` for it
 * (verified on two models) — offering it would only produce guaranteed
 * failures.
 */
const FULL_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max']

/** Values the gateway accepts; anything else is filtered out of the selector. */
const GATEWAY_EFFORTS: ReadonlySet<string> = new Set(FULL_EFFORT_LADDER)

function effortInfo(effort: string): { id: ReturnType<typeof ReasoningEffortId>, name: string } {
  return { id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort }
}

function modelInfo(provider: string, model: CommandCodeGoModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    // 声明该模型真实接受的模态：漏报会让 harness 把图片换成占位文字
    // （`projectImagesForTextModel`），误报则会让适配器收到它无法发送的图片。
    inputModalities: [...(model.inputModalities ?? ['text'])],
  }
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
function reasoningFor(model: CommandCodeGoModel | undefined): LlmModelReasoningInfo {
  const declared = model?.efforts
  // 声明了档位就只给网关接受的子集；声明了却全是非法值时只留 Auto。
  // 未声明（`—`）时给网关的通用梯子。
  const levels = declared !== undefined && declared.length > 0
    ? declared.filter(effort => GATEWAY_EFFORTS.has(effort))
    : FULL_EFFORT_LADDER
  return {
    efforts: [
      { id: OFF_REASONING_EFFORT, name: EFFORT_LABELS.off! },
      ...levels.map(effortInfo),
    ],
  }
}

/**
 * Command Code Go adapter. One instance serves every model in the scanned Go
 * catalog; the harness model id IS the gateway wire model id.
 */
export class CommandCodeGoAdapter extends LlmAdapter {
  private readonly config: CommandCodeGoAdapterOptions

  constructor(config: CommandCodeGoAdapterOptions) {
    super()
    this.config = config
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Command Code Go' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const connection = this.config.options()
    const configured = connection.models.find(entry => entry.id === model)
    const info = configured === undefined
      ? modelInfo(provider, { id: model, name: model })
      : modelInfo(provider, configured)
    return Promise.resolve({
      ...info,
      context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: reasoningFor(configured),
    })
  }

  /**
   * Stream one completion. With a pooled key resolver each attempt takes the
   * next account; failures that occur before the first emitted chunk (auth,
   * rate limit, server, transport) fail over to another account inside the
   * same request. Once streaming has started, errors propagate unchanged —
   * a half-delivered answer must never be silently replayed.
   */
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const attempts = Math.max(1, Math.min(this.config.poolSize?.() ?? 1, MAX_FAILOVER_ATTEMPTS))
    for (let attempt = 0; attempt < attempts; attempt++) {
      const apiKey = await this.config.resolveApiKey()
      const mayFailover = attempt < attempts - 1
      let yielded = false
      try {
        for await (const chunk of this.open(options, connection, apiKey)) {
          yielded = true
          yield chunk
        }
        return
      } catch (error: unknown) {
        if (yielded || !mayFailover || !isFailoverError(error)) throw error
        this.fireKeyFailure(apiKey, error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** One guarded upstream exchange: idle watchdog + request + event parse. */
  private async * open(
    options: GenerateOptions,
    connection: CommandCodeGoConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, DEFAULT_STREAM_IDLE_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(
      options,
      watchdog.signal,
      connection,
      apiKey,
    )[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(
          `Command Code stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`,
          'TIMEOUT',
          { cause: error },
        )
      }
      if (options.signal?.aborted) {
        throw new LlmError('Command Code request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('Command Code /alpha/generate stream failed', 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Command Code stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch (_abortedTransportTeardown) {
          // The consumer controller already owns termination; a return-time abort cannot add a second outcome.
        }
      }
    }
  }

  private fireKeyFailure(apiKey: string, message: string): void {
    void Promise.resolve(this.config.onKeyFailure?.(apiKey, message)).catch(() => {})
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CommandCodeGoConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const body = await buildRequest(options, this.config.resolveImage)
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // 请求指纹完全对齐官方 cmd CLI（v1.31.0 实测还原）：
      // UA 是 commandcode/<版本>，配合 x-command-code-version / x-cli-environment /
      // x-taste-learning / x-session-id / x-project-slug，反代流量与 CLI 本体不可区分。
      'user-agent': `commandcode/${CC_VERSION}`,
      'x-command-code-version': CC_VERSION,
      'x-cli-environment': 'production',
      'x-taste-learning': 'false',
      'x-session-id': buildCliSessionId(),
      'x-project-slug': buildProjectSlug(),
      'authorization': `Bearer ${apiKey}`,
      ...attributionHeaders(),
    }

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/alpha/generate`, {
        method: 'POST',
        headers,
        body: payload,
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(
        `Command Code request to ${connection.baseURL} failed`,
        'TRANSPORT',
        { cause: error },
      )
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      const message = gatewayErrorMessage(raw) ?? `Command Code API error (HTTP ${response.status})`
      throw new LlmError(
        `${message} [model=${options.model}]`,
        httpErrorCode(response.status, raw),
        { status: response.status },
      )
    }
    // 网关已接受该 key：清掉账号上的失败记账。
    void Promise.resolve(this.config.onKeySuccess?.(apiKey)).catch(() => {})
    if (!response.body) {
      throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE')
    }

    const state: CcStreamState = { blockIndex: 0 }
    let eventCount = 0
    let sawError = false
    for await (const event of parseEventStream(response.body)) {
      eventCount += 1
      // 网关的 error / abort 是流的真实终止原因。此前它们被忽略，于是流一结束就
      // 报「stream ended without finish-step」，把真正的错误（例如
      // "Tool result is missing for tool call …"）盖掉了。
      if (event.type === 'error') {
        sawError = true
        const message = streamErrorText(event) ?? 'unknown gateway error'
        throw new LlmError(
          `Command Code gateway error: ${message} [model=${options.model}]`,
          streamErrorCode(event, message),
        )
      }
      if (event.type === 'abort') {
        sawError = true
        throw new LlmError('Command Code gateway aborted the stream', 'ABORTED')
      }
      // Each distinct content stream (text / reasoning / tool-call) opens its
      // own block index in arrival order.
      if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
        state.blockIndex += 1
      }
      yield* eventToChunks(event, state)
      // finish-step 或 finish 任一到达都表示本轮已正常结束。
      if (state.finished === true) return
    }
    // Stream ended with no terminal marker at all: genuinely truncated. Report
    // enough context to tell a silent close from a mis-parsed body.
    throw new LlmError(
      sawError
        ? 'Command Code stream ended right after an error event'
        : `Command Code stream ended without finish-step or finish (${eventCount} event(s) received)`,
      'STREAM_CLOSED',
    )
  }
}

/** Map a gateway HTTP status / error body to a stable harness LlmError code. */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) {
    // MODEL_NOT_IN_PLAN is a plan/permission failure, not a credential one:
    // the key is fine, the selected model is above the Go tier.
    if (body.includes('MODEL_NOT_IN_PLAN')) return 'PERMISSION'
    return 'AUTH'
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(body)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}
