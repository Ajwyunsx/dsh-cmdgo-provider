/**
 * 适配器自愈路径的本地测试（issue #5）：用一个假 fetch 复刻网关的坏形状报错，
 * 验证「会话不该被永久卡死」这件事在运行时真的成立。
 *
 * 场景：历史里带着一个网关认为「缺结果」的工具调用（call_02），
 *   1. 第一次请求：网关回 error 事件 → 适配器应当
 *      - 把该 id 从重试请求里两侧一起丢掉，
 *      - 用**同一个账号**重发一次（不切账号 → 不烧别的账号额度），
 *      - 通过 onRepair 报告这件事；
 *   2. 第二次请求：正常流式返回 → 整轮成功；
 *   3. 网关点名的 id 我们根本没有（无法自愈）→ **不重试**，错误如实抛出；
 *   4. 已经流出内容后再出错 → 不重放（半截回答不能被静默重来）；
 *   5. 每次请求的 x-session-id 都是官方 `sess_<16 hex>` 形状、且按会话稳定。
 *
 * 用法：node scripts/smoke-repair.mjs
 */

import { CommandCodeGoAdapter, cliSessionIdFor } from '../lib/adapter.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

const encoder = new TextEncoder()
const ndjson = (lines) => {
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    },
  })
  return { ok: true, status: 200, body, text: async () => '' }
}

const call = (id) => ({ type: 'tool-call', id, name: 'read_image', arguments: '{"path":"a.png"}' })
const result = (id) => ({ type: 'tool-result', toolCallId: id, toolName: 'unknown', isError: false, content: [{ type: 'text', text: 'ok' }] })

/** 历史里 call_02 的结果缺失 —— 网关会为此判请求形状非法。 */
const messages = [
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01')] },
]

const connection = {
  apiKeyEnv: 'COMMANDCODE_API_KEY',
  baseURL: 'https://api.commandcode.ai',
  maxTokens: 64000,
  defaultContextWindow: 1000000,
  models: [],
  retryPolicy: {},
}

function makeAdapter(repairs, keys) {
  let index = 0
  return new CommandCodeGoAdapter({
    options: () => connection,
    // 池化时每次调用都会轮询到下一个账号：自愈必须复用同一个 key，故障转移才换号。
    resolveApiKey: async () => {
      const pool = keys || ['sk-test']
      const key = pool[index % pool.length]
      index += 1
      return key
    },
    poolSize: () => (keys === undefined ? 1 : keys.length),
    onRepair: (info) => repairs.push(info),
    onRequestUsage: () => {},
  })
}

const realFetch = globalThis.fetch
let bodies = []
let headers = []
let queue = []
globalThis.fetch = async (_url, init) => {
  bodies.push(JSON.parse(String(init.body)))
  headers.push(init.headers)
  const next = queue.shift()
  if (next === undefined) throw new Error('unexpected extra request')
  return next
}

const collect = async (adapter, options) => {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const options = {
  provider: 'commandcode',
  model: 'deepseek-v4.1-flash',
  messages,
  tools: [],
  sessionId: 'sess_local_test',
}

const pairingOf = (body) => {
  const calls = []
  const results = []
  for (const message of body.params.messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'tool-call') calls.push(part.toolCallId)
    } else if (message.role === 'tool') {
      for (const part of message.content) results.push(part.toolCallId)
    }
  }
  return { calls, results }
}

/* ---------- [1] 网关点名缺结果 → 丢掉后同账号重发 ---------- */
console.log('[1] 自愈：丢掉网关点名的调用后重发一次')

bodies = []
headers = []
queue = [
  ndjson(['{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call call_02"}}']),
  ndjson([
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"ok"}',
    '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2,"inputTokenDetails":{"noCacheTokens":4,"cacheReadTokens":6}}}',
  ]),
]
const repairs = []
const first = await collect(makeAdapter(repairs), options)
const retried = bodies.length === 2
check('自愈后确实只发了两次请求', retried, 'requests=' + bodies.length)
check('重试请求丢掉了被点名的 call_02（调用侧）', retried && !pairingOf(bodies[1]).calls.includes('call_02'), JSON.stringify(pairingOf(bodies[1])))
check('重试请求里 call_01 仍在', retried && pairingOf(bodies[1]).calls.join(',') === 'call_01', JSON.stringify(pairingOf(bodies[1])))
check('第一次请求本来就只带了一个结果（现场复刻）', pairingOf(bodies[0]).results.join(',') === 'call_01', JSON.stringify(pairingOf(bodies[0])))
check('重试后整轮成功（拿到文本）', first.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'ok'), JSON.stringify(first))
check('onRepair 报告了点名的 id', repairs.length === 1 && repairs[0].toolCallIds.join(',') === 'call_02', JSON.stringify(repairs))
check('onRepair 带上了网关原文', repairs.length === 1 && /Tool result is missing/.test(repairs[0].message), JSON.stringify(repairs[0] && repairs[0].message))

/* ---------- [2] x-session-id：官方形状 + 按会话稳定 ---------- */
console.log('[2] x-session-id')
const sid = headers[0]['x-session-id']
check('形状为 sess_<16 hex>', /^sess_[0-9a-f]{16}$/.test(sid), sid)
check('与 cliSessionIdFor(sessionId) 一致', sid === cliSessionIdFor('sess_local_test'), sid + ' vs ' + cliSessionIdFor('sess_local_test'))
check('两次请求（同会话）复用同一个 id', headers[1]['x-session-id'] === sid)

/* ---------- [2b] 自愈复用同一个账号；故障转移才换号 ---------- */
console.log('[2b] 自愈不换账号')
bodies = []
headers = []
queue = [
  ndjson(['{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call call_02"}}']),
  ndjson(['{"type":"text-start"}', '{"type":"text-delta","text":"ok"}', '{"type":"finish-step","finishReason":"stop"}']),
]
await collect(makeAdapter([], ['sk-account-A', 'sk-account-B']), options)
check('自愈重试用的是同一个账号的 key', headers.length === 2 && headers[0].authorization === headers[1].authorization,
  headers.map((h) => h.authorization).join(' | '))
check('自愈没有换到第二个账号', headers.length === 2 && headers[0].authorization === 'Bearer sk-account-A',
  headers.map((h) => h.authorization).join(' | '))

bodies = []
headers = []
queue = [
  ndjson(['{"type":"error","error":{"type":"server_error","message":"upstream overloaded"}}']),
  ndjson(['{"type":"text-start"}', '{"type":"text-delta","text":"ok"}', '{"type":"finish-step","finishReason":"stop"}']),
]
await collect(makeAdapter([], ['sk-account-A', 'sk-account-B']), options)
check('真实故障转移确实换到下一个账号', headers.length === 2 && headers[0].authorization !== headers[1].authorization,
  headers.map((h) => h.authorization).join(' | '))

/* ---------- [3] 点名的 id 不存在 → 不自愈，错误如实抛出 ---------- */
console.log('[3] 无法自愈的坏形状：不重试、原样报错')
bodies = []
queue = [
  ndjson(['{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call call_99"}}']),
]
let thrown
try {
  await collect(makeAdapter([]), options)
} catch (error) {
  thrown = error
}
check('只发了一次请求（没有无效重试）', bodies.length === 1, 'requests=' + bodies.length)
check('错误如实抛出且保留网关原文', thrown !== undefined && /Tool result is missing for tool call call_99/.test(thrown.message), thrown && thrown.message)
check('归类为 INVALID_REQUEST（不触发账号故障转移）', thrown !== undefined && thrown.failure && thrown.failure.code === 'INVALID_REQUEST', thrown && JSON.stringify(thrown.failure))

/* ---------- [4] 已经流出内容后出错 → 不重放 ---------- */
console.log('[4] 半截回答：不重放')
bodies = []
queue = [
  ndjson([
    '{"type":"text-start"}',
    '{"type":"text-delta","text":"半截"}',
    '{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call call_01"}}',
  ]),
]
let partial
const seen = []
try {
  for await (const chunk of makeAdapter([]).stream(options)) seen.push(chunk)
} catch (error) {
  partial = error
}
check('只发了一次请求', bodies.length === 1, 'requests=' + bodies.length)
check('已流出的内容没有被重放', seen.length > 0 && partial !== undefined, 'seen=' + seen.length)
check('错误仍然抛出', partial !== undefined && /Tool result is missing/.test(partial.message), partial && partial.message)

globalThis.fetch = realFetch

if (failures.length > 0) {
  console.error('\n自愈测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n自愈测试全部通过。')
