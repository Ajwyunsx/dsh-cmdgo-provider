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
import { buildRequest, CC_VERSION, DEFAULT_MAX_TOKENS, eventToChunks, gatewayErrorMessage, parseEventStream } from './protocol.js'

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
}

/** Default maximum idle interval while an adapter stream read is outstanding. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
/** Default combined request/response context capacity. */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export { DEFAULT_MAX_TOKENS }

const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'
const OFF_REASONING_EFFORT = ReasoningEffortId('off')

/** Effort labels in the gateway's own vocabulary, for selector display. */
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
}

/** The full reasoning-effort ladder the gateway accepts, low to high. */
const FULL_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function effortInfo(effort: string): { id: ReturnType<typeof ReasoningEffortId>, name: string } {
  return { id: ReasoningEffortId(effort), name: EFFORT_LABELS[effort] ?? effort }
}

function modelInfo(provider: string, model: CommandCodeGoModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    inputModalities: ['text'],
  }
}

/**
 * Build the reasoning-effort selector for one model. Models whose effort
 * support is known expose exactly their supported levels (plus `off`);
 * models without metadata expose the full ladder (`off` plus minimal to
 * max) so every gateway level stays reachable. No default effort is pinned:
 * the gateway decides when a request names none.
 */
function reasoningFor(model: CommandCodeGoModel | undefined): LlmModelReasoningInfo {
  const efforts = model?.efforts
  const levels = efforts !== undefined && efforts.length > 0
    ? efforts
    : FULL_EFFORT_LADDER
  return {
    efforts: [
      { id: OFF_REASONING_EFFORT, name: EFFORT_LABELS.off },
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

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const connection = this.config.options()
    const apiKey = await this.config.resolveApiKey()
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

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: CommandCodeGoConnectionOptions,
    apiKey: string,
  ): AsyncIterable<StreamChunk> {
    const body = buildRequest(options)
    const payload = JSON.stringify(body)
    const headers: Record<string, string> = {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'x-command-code-version': CC_VERSION,
      'x-cli-environment': 'production',
      'x-co-flag': 'false',
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
    if (!response.body) {
      throw new LlmError('Command Code returned no response body', 'EMPTY_RESPONSE')
    }

    const state = { blockIndex: 0 }
    for await (const event of parseEventStream(response.body)) {
      // Each distinct content stream (text / reasoning / tool-call) opens its
      // own block index in arrival order.
      if (event.type === 'text-start' || event.type === 'reasoning-start' || event.type === 'tool-call') {
        state.blockIndex += 1
      }
      yield* eventToChunks(event, state)
      if (event.type === 'finish-step') return
    }
    // Gateway closed without a finish-step: treat as truncated.
    throw new LlmError('Command Code stream ended without finish-step', 'STREAM_CLOSED')
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
