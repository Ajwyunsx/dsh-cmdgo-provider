/**
 * Command Code Go wire protocol: translate between the harness LLM vocabulary
 * and Command Code's private `/alpha/generate` gateway.
 *
 * The Go plan is the only Command Code plan without Provider-API access, so
 * the standard OpenAI-compatible endpoints answer 403 `upgrade_required` for
 * a Go subscription. The CLI gateway at `POST /alpha/generate` is the
 * transport every Go-plan request must use. This module serializes the
 * gateway request body and parses its line-delimited JSON stream back into
 * harness `StreamChunk`s.
 *
 * The request envelope shape mirrors the `cmd` CLI (`command-code` npm
 * package) and the opencode commandcode-go provider plugin:
 * - `config.environment` is a plain string (`<os>-<arch>`), not an object.
 * - Gateway compatibility rides on the `x-command-code-version` header.
 *
 * @module commandcode-go/protocol
 */

import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  StreamChunk,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { platform, arch } from 'node:os'

/**
 * Brand carried by `StreamChunk`'s `tool-call-delta.id`. dsh-llm renamed the
 * constructor from `CallId` (<= 0.1.1) to `ToolCallId` (>= 0.1.2); importing
 * either statically makes the ESM link fail on the other host line. The brand
 * is compile-time only (the constructor is the identity function), so we derive
 * the type without naming the export and cast the raw string instead.
 */
type ToolCallChunkId = Extract<StreamChunk, { type: 'tool-call-delta' }>['id']

/**
 * Gateway version pinned to a known-good Command Code CLI release. The gateway
 * checks the `x-command-code-version` header against the `User-Agent` version,
 * so both must track the same CLI release (here: the CLI installed in this
 * environment, v1.31.0 — request/response envelope verified unchanged).
 */
export const CC_VERSION = '1.31.0'

/** Last-resort output cap when a request carries no maxTokens (matches the adapter default). */
export const DEFAULT_MAX_TOKENS = 64_000

/** Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing). */
export interface CcStreamEvent {
  type: string
  [key: string]: unknown
}

export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
}

/** Tool call inside an assistant message, as the gateway wants it. */
interface CcToolCallContent {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

/** Tool result inside a tool-role message. */
interface CcToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text' | 'error-text'; value: string }
}

/**
 * Image part as the gateway wants it. The CLI's Anthropic-shaped internal
 * blocks are converted to exactly this before dispatch (`convertUserMessage`):
 * a bare `image` data URL, with no `source` wrapper. The gateway normalizes it
 * into a `{type:'file', mediaType, data}` prompt part.
 */
interface CcImageContent {
  type: 'image'
  image: string
}

type CcUserPart = { type: 'text'; text: string } | CcImageContent

type CcMessage =
  | { role: 'user'; content: string | CcUserPart[] }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string } | CcToolCallContent> }
  | { role: 'tool'; content: CcToolResultContent[] }

/** Harness image block, derived so no attachment type needs to be imported. */
type ImageBlock = Extract<ContentBlock, { type: 'image' }>

/**
 * Resolve one harness image attachment into the gateway's data URL
 * (`data:<mediaType>;base64,<bytes>`). Returns undefined when the attachment
 * cannot be read; the serializer then substitutes an explicit placeholder
 * rather than dropping the image silently.
 */
export type ImageResolver = (block: ImageBlock) => Promise<string | undefined>

interface CcTool {
  type: 'function'
  name: string
  description?: string
  input_schema: unknown
}

interface CcRequestEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CcMessage[]
    tools: CcTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    reasoning_effort?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The flattened text of a message's content blocks. */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultOutput(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
): CcToolResultContent['output'] {
  const value = flattenText(result.content)
  return result.isError
    ? { type: 'error-text', value: value || 'Execution denied' }
    : { type: 'text', value: value || '(no output)' }
}

/**
 * 序列化一条 assistant 消息。
 *
 * `resultIds` 是本轮所有工具结果的 id 集合：**没有对应结果的工具调用必须丢掉**。
 * 网关对「有 tool-call 却没有对应 tool 结果」是硬错误——实测返回
 * `{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call …"}}`
 * 且不带 finish-step。长时间会话被压缩、或工具执行被中断时，历史里很容易出现这种
 * 孤儿调用；丢掉它比让整轮失败好。
 */
function serializeAssistant(message: Message, resultIds?: ReadonlySet<string>): Extract<CcMessage, { role: 'assistant' }> | undefined {
  const parts: Extract<CcMessage, { role: 'assistant' }>['content'] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: block.text })
    } else if (block.type === 'tool-call') {
      if (resultIds !== undefined && !resultIds.has(block.id)) continue
      parts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: safeParseJson(block.arguments),
      })
    }
  }
  // 整条消息只剩被丢掉的孤儿工具调用时，空 assistant 消息同样会被网关拒绝。
  if (parts.length === 0) return undefined
  return { role: 'assistant', content: parts }
}

/** 收集全部工具结果的 toolCallId（含嵌在 tool-result 内容里的）。 */
function collectToolResultIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>()
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'tool-result') {
        ids.add(block.toolCallId)
        walk(block.content)
      }
    }
  }
  for (const message of messages) walk(message.content)
  return ids
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Collect every image block in a message, descending into tool-result content
 * exactly like the harness's own `contentHasImage` does.
 */
function collectImages(blocks: ContentBlock[]): ImageBlock[] {
  const found: ImageBlock[] = []
  for (const block of blocks) {
    if (block.type === 'image') found.push(block)
    else if (block.type === 'tool-result') found.push(...collectImages(block.content))
  }
  return found
}

/** Placeholder used when an image is present but cannot be read. */
function omittedImageText(block: ImageBlock): string {
  return `[image omitted: attachment ${String(block.attachment.attachmentId).slice(0, 23)} could not be read]`
}

/** Turn harness image blocks into gateway parts (or explicit placeholders). */
async function imageParts(blocks: ImageBlock[], resolveImage?: ImageResolver): Promise<CcUserPart[]> {
  const parts: CcUserPart[] = []
  for (const block of blocks) {
    let dataUrl: string | undefined
    if (resolveImage !== undefined) {
      try {
        dataUrl = await resolveImage(block)
      } catch (_imageResolutionFailure) {
        dataUrl = undefined
      }
    }
    parts.push(dataUrl === undefined
      ? { type: 'text', text: omittedImageText(block) }
      : { type: 'image', image: dataUrl })
  }
  return parts
}

/**
 * Serialize one harness message into the gateway's message list.
 *
 * Mirrors the CLI's `convertUserMessage`: tool results become their own
 * `tool` message and text/images become a following `user` message, so a turn
 * carrying both keeps both. A lone text part stays a plain string, which is
 * what the gateway expects for ordinary chat turns. Images nested in
 * tool-result content ride in that follow-up user message — the tool message
 * itself is text-only.
 */
async function serializeUser(message: Message, resolveImage?: ImageResolver): Promise<CcMessage[]> {
  const out: CcMessage[] = []
  const toolResults = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  )
  if (toolResults.length > 0) {
    out.push({
      role: 'tool',
      content: toolResults.map(result => ({
        type: 'tool-result' as const,
        toolCallId: result.toolCallId,
        toolName: 'unknown',
        output: toolResultOutput(result),
      })),
    })
  }
  const text = flattenText(message.content)
  const images = await imageParts(collectImages(message.content), resolveImage)
  if (text.length > 0 || images.length > 0) {
    const parts: CcUserPart[] = [
      ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ...images,
    ]
    const single = parts.length === 1 ? parts[0] : undefined
    out.push({
      role: 'user',
      content: single !== undefined && single.type === 'text' ? single.text : parts,
    })
  }
  // 空消息也要占位，否则整轮会塌陷。
  if (out.length === 0) out.push({ role: 'user', content: '' })
  return out
}

/**
 * Build the gateway request envelope for one harness call.
 *
 * @param options - harness call options.
 * @param resolveImage - optional resolver turning harness image attachments
 * into gateway data URLs. Without it images degrade to an explicit placeholder
 * instead of being dropped.
 */
export async function buildRequest(
  options: GenerateOptions,
  resolveImage?: ImageResolver,
): Promise<CcRequestEnvelope> {
  let system = options.system ?? ''
  const messages: CcMessage[] = []
  // 先扫一遍工具结果：孤儿工具调用会被 drop（见 serializeAssistant）。
  const resultIds = collectToolResultIds(options.messages)
  for (const message of options.messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + flattenText(message.content)
      continue
    }
    if (message.role === 'assistant') {
      const serialized = serializeAssistant(message, resultIds)
      if (serialized !== undefined) messages.push(serialized)
      continue
    }
    messages.push(...await serializeUser(message, resolveImage))
  }

  const tools: CcTool[] = (options.tools ?? [])
    .map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      input_schema: tool.parameters,
    }))

  const params: CcRequestEnvelope['params'] = {
    model: options.model,
    messages,
    tools,
    system,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
    params.reasoning_effort = options.reasoningEffort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0],
      environment: `${platform()}-${arch()}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params,
  }
}

/** 事件流状态：块下标 + 是否已产出终态 finish。 */
export interface CcStreamState {
  blockIndex: number
  /** 已产出 finish 块（finish-step 或 finish 都可能先到，只认第一个）。 */
  finished?: boolean
}

/**
 * Extract the human message from a gateway stream error part.
 *
 * The gateway does NOT use the AI SDK's plain `errorText` shape here — the
 * observed form is `{"type":"error","error":{"type":"server_error","message":"…"}}`.
 * Both, plus a bare `message`, are handled so the real cause is never lost.
 *
 * @returns the message, or undefined when the part carries none.
 */
export function streamErrorText(event: CcStreamEvent): string | undefined {
  const direct = event.errorText ?? event.message
  if (typeof direct === 'string' && direct.length > 0) return direct
  const nested = event.error
  if (typeof nested === 'string' && nested.length > 0) return nested
  if (isRecord(nested)) {
    for (const key of ['message', 'errorText', 'detail'] as const) {
      const value = nested[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    // 再嵌一层（如 {error:{error:{message}}}）。
    const deeper = nested.error
    if (isRecord(deeper) && typeof deeper.message === 'string' && deeper.message.length > 0) {
      return deeper.message
    }
  }
  return undefined
}

/**
 * Map a gateway stream error part to a stable harness failure code.
 *
 * Request-shape faults ("Tool result is missing", invalid parameters) must NOT
 * be classified as failover-worthy: retrying them on another account only
 * burns quota on a request that can never succeed.
 */
export function streamErrorCode(event: CcStreamEvent, message: string): string {
  const text = message.toLowerCase()
  if (/tool result is missing|invalid|malformed|unsupported|required|must be|too (long|large)/.test(text)) {
    return 'INVALID_REQUEST'
  }
  if (/rate ?limit|quota|too many requests|usage limit|exceeded/.test(text)) return 'RATE_LIMIT'
  if (/unauthor|forbidden|invalid api key|expired/.test(text)) return 'AUTH'
  if (/context|token limit|too many tokens/.test(text)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (/overload|unavailable|internal|server error|timeout|upstream/.test(text)) return 'SERVER'
  const kind = isRecord(event.error) && typeof event.error.type === 'string' ? event.error.type.toLowerCase() : ''
  if (kind.includes('server')) return 'SERVER'
  if (kind.includes('auth')) return 'AUTH'
  return 'SERVER'
}

/**
 * Translate one gateway stream event into one or more harness StreamChunks.
 * @returns an empty array when the event has no harness representation.
 */
export function eventToChunks(
  event: CcStreamEvent,
  state: CcStreamState,
): StreamChunk[] {
  const chunks: StreamChunk[] = []
  switch (event.type) {
    case 'text-start': {
      chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'text' })
      break
    }
    case 'text-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        chunks.push({ type: 'text-delta', index: state.blockIndex, text })
      }
      break
    }
    case 'reasoning-start': {
      chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'reasoning' })
      break
    }
    case 'reasoning-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      if (text.length > 0) {
        chunks.push({ type: 'reasoning-delta', index: state.blockIndex, text })
      }
      break
    }
    case 'tool-call': {
      const input = event.input ?? event.args ?? event.arguments
      const callId = typeof event.toolCallId === 'string' ? event.toolCallId
        : typeof event.id === 'string' ? event.id
          : ''
      chunks.push({
        type: 'tool-call-delta',
        index: state.blockIndex,
        id: callId as ToolCallChunkId,
        ...typeof event.toolName === 'string' ? { name: event.toolName } : {},
        argumentsDelta: JSON.stringify(input ?? {}),
      })
      break
    }
    // finish-step 是每个 step 的终态；finish 是整条流的终态。正常情况两者都到，
    // 但网关在某些路由/错误路径下只发 finish，因此两者都当终态处理，且只认第一个
    // ——否则一条完整的回答会因为缺 finish-step 被判成截断而整轮失败。
    case 'finish-step':
    case 'finish': {
      if (state.finished === true) break
      state.finished = true
      const usage = isRecord(event.usage)
        ? event.usage as unknown as CcUsage
        : isRecord(event.totalUsage) ? event.totalUsage as unknown as CcUsage : undefined
      if (usage) {
        const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const cacheRead = inputDetails?.cacheReadTokens
        const totalInput = usage.inputTokens
        const noCache = inputDetails?.noCacheTokens
        const inputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
          ? Math.max(0, totalInput - cacheRead)
          : totalInput) ?? 0
        const outputTokens = usage.outputTokens ?? outputDetails?.textTokens ?? 0
        chunks.push({
          type: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
            ...outputDetails?.reasoningTokens !== undefined ? { reasoningTokens: outputDetails.reasoningTokens } : {},
          },
        })
      }
      const reason = event.finishReason ?? event.rawFinishReason ?? 'stop'
      chunks.push({ type: 'finish', reason: mapFinishReason(reason) })
      break
    }
    // error / abort 由适配器转成 LlmError（要带上真实原因），这里不产出 chunk。
    case 'error':
    case 'abort': {
      break
    }
  }
  return chunks
}

/** Map the gateway finish-reason vocabulary to the harness FinishReason. */
function mapFinishReason(raw: unknown): FinishReason {
  const reason = typeof raw === 'string' ? raw : 'stop'
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return { kind: 'stop' }
    case 'tool_calls':
    case 'tool-calls':
      return { kind: 'tool-calls' }
    case 'length':
    case 'max_tokens':
    case 'max-output-tokens':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

function parseEventLine(line: string): CcStreamEvent | undefined {
  if (line.length === 0 || line.startsWith(':')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isRecord(parsed) && typeof parsed.type === 'string' ? parsed as unknown as CcStreamEvent : undefined
}

/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CcStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? '' : decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
      if (done) {
        const tail = buffer.trim()
        const event = parseEventLine(tail)
        if (event !== undefined) yield event
        return
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Extract the human message from a gateway error body, when present. */
export function gatewayErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message
      if (typeof message === 'string' && message.length > 0) return message
    }
  } catch {
    // Not JSON; caller falls back to the HTTP status.
  }
  return undefined
}
