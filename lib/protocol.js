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
import { CallId } from '@deepseek-ai/dsh-llm';
import { platform, arch } from 'node:os';
/** Gateway version pinned to a known-good Command Code CLI release. */
export const CC_VERSION = '0.26.20';
/** Last-resort output cap when a request carries no maxTokens (matches the adapter default). */
export const DEFAULT_MAX_TOKENS = 64_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The flattened text of a message's content blocks. */
function flattenText(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
function toolResultOutput(result) {
    const value = flattenText(result.content);
    return result.isError
        ? { type: 'error-text', value: value || 'Execution denied' }
        : { type: 'text', value: value || '(no output)' };
}
function serializeAssistant(message) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'reasoning') {
            parts.push({ type: 'reasoning', text: block.text });
        }
        else if (block.type === 'tool-call') {
            parts.push({
                type: 'tool-call',
                toolCallId: block.id,
                toolName: block.name,
                input: safeParseJson(block.arguments),
            });
        }
    }
    return { role: 'assistant', content: parts };
}
function safeParseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
function serializeUser(message) {
    const toolResults = message.content.filter((block) => block.type === 'tool-result');
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
        return { role: 'user', content: text };
    }
    return {
        role: 'tool',
        content: toolResults.map(result => ({
            type: 'tool-result',
            toolCallId: result.toolCallId,
            toolName: 'unknown',
            output: toolResultOutput(result),
        })),
    };
}
/** Build the gateway request envelope for one harness call. */
export function buildRequest(options) {
    let system = options.system ?? '';
    const messages = [];
    for (const message of options.messages) {
        if (message.role === 'system') {
            system += (system ? '\n\n' : '') + flattenText(message.content);
            continue;
        }
        messages.push(message.role === 'assistant' ? serializeAssistant(message) : serializeUser(message));
    }
    const tools = (options.tools ?? [])
        .map((tool) => ({
        type: 'function',
        name: tool.name,
        ...tool.description === undefined ? {} : { description: tool.description },
        input_schema: tool.parameters,
    }));
    const params = {
        model: options.model,
        messages,
        tools,
        system,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
    };
    if (options.temperature !== undefined)
        params.temperature = options.temperature;
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
        params.reasoning_effort = options.reasoningEffort;
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
    };
}
/**
 * Translate one gateway stream event into one or more harness StreamChunks.
 * @returns an empty array when the event has no harness representation.
 */
export function eventToChunks(event, state) {
    const chunks = [];
    switch (event.type) {
        case 'text-start': {
            chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'text' });
            break;
        }
        case 'text-delta': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length > 0) {
                chunks.push({ type: 'text-delta', index: state.blockIndex, text });
            }
            break;
        }
        case 'reasoning-start': {
            chunks.push({ type: 'block-start', index: state.blockIndex, blockType: 'reasoning' });
            break;
        }
        case 'reasoning-delta': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length > 0) {
                chunks.push({ type: 'reasoning-delta', index: state.blockIndex, text });
            }
            break;
        }
        case 'tool-call': {
            const input = event.input ?? event.args ?? event.arguments;
            const callId = typeof event.toolCallId === 'string' ? event.toolCallId
                : typeof event.id === 'string' ? event.id
                    : '';
            chunks.push({
                type: 'tool-call-delta',
                index: state.blockIndex,
                id: CallId(callId),
                ...typeof event.toolName === 'string' ? { name: event.toolName } : {},
                argumentsDelta: JSON.stringify(input ?? {}),
            });
            break;
        }
        case 'finish-step': {
            const usage = isRecord(event.usage) ? event.usage : undefined;
            if (usage) {
                const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
                const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined;
                const cacheRead = inputDetails?.cacheReadTokens;
                const totalInput = usage.inputTokens;
                const noCache = inputDetails?.noCacheTokens;
                const inputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
                    ? Math.max(0, totalInput - cacheRead)
                    : totalInput) ?? 0;
                const outputTokens = usage.outputTokens ?? outputDetails?.textTokens ?? 0;
                chunks.push({
                    type: 'usage',
                    usage: {
                        inputTokens,
                        outputTokens,
                        ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
                        ...outputDetails?.reasoningTokens !== undefined ? { reasoningTokens: outputDetails.reasoningTokens } : {},
                    },
                });
            }
            const reason = event.finishReason ?? event.rawFinishReason ?? 'stop';
            chunks.push({ type: 'finish', reason: mapFinishReason(reason) });
            break;
        }
    }
    return chunks;
}
/** Map the gateway finish-reason vocabulary to the harness FinishReason. */
function mapFinishReason(raw) {
    const reason = typeof raw === 'string' ? raw : 'stop';
    switch (reason) {
        case 'stop':
        case 'end_turn':
            return { kind: 'stop' };
        case 'tool_calls':
        case 'tool-calls':
            return { kind: 'tool-calls' };
        case 'length':
        case 'max_tokens':
        case 'max-output-tokens':
            return { kind: 'max-tokens' };
        default:
            return {
                kind: 'error',
                failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
            };
    }
}
function parseEventLine(line) {
    if (line.length === 0 || line.startsWith(':'))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : undefined;
}
/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += done ? '' : decoder.decode(value, { stream: !done });
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                const event = parseEventLine(line);
                if (event !== undefined)
                    yield event;
            }
            if (done) {
                const tail = buffer.trim();
                const event = parseEventLine(tail);
                if (event !== undefined)
                    yield event;
                return;
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
/** Extract the human message from a gateway error body, when present. */
export function gatewayErrorMessage(body) {
    try {
        const parsed = JSON.parse(body);
        if (isRecord(parsed) && isRecord(parsed.error)) {
            const message = parsed.error.message;
            if (typeof message === 'string' && message.length > 0)
                return message;
        }
    }
    catch {
        // Not JSON; caller falls back to the HTTP status.
    }
    return undefined;
}
