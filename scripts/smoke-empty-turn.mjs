/**
 * 空回合守卫的本地测试（issue #9）：网关 HTTP 200、NDJSON 流正常以
 * `finish-step` / `finish` 结束，但整轮里没有任何 `text-delta`、也没有
 * `tool-call` 时，适配器必须**报错**而不是静默返回一个空回合。
 *
 * 场景：
 *   1. 只有 reasoning-delta + finish-step → 抛 EMPTY_RESPONSE（宿主会重试）；
 *   2. 只有终态事件（连 reasoning 都没有）→ 同样抛 EMPTY_RESPONSE；
 *   3. 正常有 text-delta → 不抛，照常返回；
 *   4. 只有 tool-call（无正文）→ 不抛：工具调用是可用内容；
 *   5. 只有空白 text-delta → 抛（空白不算内容）；
 *   6. 已经流出正文后遇到同样结束 → 不抛（不能把半截成功翻成失败）；
 *   7. 空的判定必须发生在 usage/finish chunk 之前：失败时一个 chunk 都不产出。
 *
 * 用法：node scripts/smoke-empty-turn.mjs
 */

import { CommandCodeGoAdapter } from '../lib/adapter.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

const encoder = new TextEncoder()
const ndjson = (lines) => ({
  ok: true,
  status: 200,
  body: new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
      controller.close()
    },
  }),
  text: async () => '',
})

const connection = {
  apiKeyEnv: 'COMMANDCODE_API_KEY',
  baseURL: 'https://api.commandcode.ai',
  maxTokens: 64000,
  defaultContextWindow: 1000000,
  models: [],
  retryPolicy: {},
}

const makeAdapter = () => new CommandCodeGoAdapter({
  options: () => connection,
  resolveApiKey: async () => 'sk-test',
  poolSize: () => 1,
  onRepair: () => {},
  onRequestUsage: () => {},
})

const realFetch = globalThis.fetch
let queue = []
globalThis.fetch = async () => {
  const next = queue.shift()
  if (next === undefined) throw new Error('unexpected extra request')
  return next
}

const options = {
  provider: 'commandcode',
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
}

/** 走一遍适配器，返回 { chunks, error }。 */
async function run(lines) {
  queue = [ndjson(lines)]
  const chunks = []
  try {
    for await (const chunk of makeAdapter().stream(options)) chunks.push(chunk)
    return { chunks, error: undefined }
  } catch (error) {
    return { chunks, error }
  }
}

const finishStep = '{"type":"finish-step","finishReason":"stop","usage":{"inputTokens":10,"outputTokens":2}}'

/* ---------- [1] 只有 reasoning-delta + finish-step → 空回合 ---------- */
console.log('[1] 只有 reasoning 的回合：报 EMPTY_RESPONSE，不静默成功')
const onlyReasoning = await run([
  '{"type":"reasoning-start"}',
  '{"type":"reasoning-delta","text":"让我想想…"}',
  finishStep,
])
check('抛错而不是返回空回合', onlyReasoning.error !== undefined, 'chunks=' + JSON.stringify(onlyReasoning.chunks))
check('错误码是 EMPTY_RESPONSE', onlyReasoning.error?.failure?.code === 'EMPTY_RESPONSE',
  JSON.stringify(onlyReasoning.error?.failure))
check('错误文本点明模型（便于定位）', /deepseek-v4\.1-flash/.test(String(onlyReasoning.error?.message)),
  onlyReasoning.error?.message)
// 已经流出的 reasoning 是真实发生过的内容，不能（也无法）收回；要挡住的是
// **终态**：宿主不能看到一个 finish，否则它会把这一轮当成成功收下。
check('终态 finish chunk 不产出（宿主不会当成功收下）',
  !onlyReasoning.chunks.some((c) => c.type === 'finish'), JSON.stringify(onlyReasoning.chunks))
check('已经流出的 reasoning 保留（真实内容，不回收）',
  onlyReasoning.chunks.some((c) => c.type === 'reasoning-delta'), JSON.stringify(onlyReasoning.chunks))

/* ---------- [2] 连 reasoning 都没有：只有 finish ---------- */
console.log('[2] 只有终态事件的回合')
const bare = await run([finishStep])
check('抛 EMPTY_RESPONSE', bare.error?.failure?.code === 'EMPTY_RESPONSE', JSON.stringify(bare.error?.failure))
const bareFinish = await run(['{"type":"finish","finishReason":"stop"}'])
check('只发 finish（无 finish-step）同样抛 EMPTY_RESPONSE',
  bareFinish.error?.failure?.code === 'EMPTY_RESPONSE', JSON.stringify(bareFinish.error?.failure))

/* ---------- [3] 正常有正文 → 不抛 ---------- */
console.log('[3] 有正文的回合：正常返回')
const normal = await run([
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"你好"}',
  finishStep,
])
check('不抛错', normal.error === undefined, String(normal.error?.message))
check('正文 chunk 照常产出',
  normal.chunks.some((c) => c.type === 'text-delta' && c.text === '你好'), JSON.stringify(normal.chunks))
check('finish chunk 照常产出', normal.chunks.some((c) => c.type === 'finish'), JSON.stringify(normal.chunks))

/* ---------- [4] 只有工具调用 → 可用内容，不抛 ---------- */
console.log('[4] 只有工具调用的回合：算可用内容')
const toolOnly = await run([
  '{"type":"tool-call","toolCallId":"call_01","toolName":"read_file","input":{"path":"a"}}',
  finishStep,
])
check('不抛错', toolOnly.error === undefined, String(toolOnly.error?.message))
check('工具调用 chunk 照常产出',
  toolOnly.chunks.some((c) => c.type === 'tool-call-delta'), JSON.stringify(toolOnly.chunks))

/* ---------- [5] 只有空白正文 → 按空回合处理 ---------- */
console.log('[5] 只有空白文本：不算内容')
const blank = await run([
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"   \\n  "}',
  finishStep,
])
check('抛 EMPTY_RESPONSE', blank.error?.failure?.code === 'EMPTY_RESPONSE', JSON.stringify(blank.error?.failure))

/* ---------- [6] 已流出正文后再空终态：不受影响 ---------- */
console.log('[6] 正文 + 空终态的组合不误判')
const withReasoningAndText = await run([
  '{"type":"reasoning-start"}',
  '{"type":"reasoning-delta","text":"想"}',
  '{"type":"text-start"}',
  '{"type":"text-delta","text":"答"}',
  finishStep,
])
check('reasoning + 正文的回合正常返回', withReasoningAndText.error === undefined,
  String(withReasoningAndText.error?.message))

/* ---------- [7] 用量照常上报（那一轮网关确实计费） ---------- */
console.log('[7] 失败回合仍上报用量（网关确实消耗了额度）')
queue = [ndjson(['{"type":"reasoning-delta","text":"嗯"}', finishStep])]
const usages = []
const adapter = new CommandCodeGoAdapter({
  options: () => connection,
  resolveApiKey: async () => 'sk-test',
  poolSize: () => 1,
  onRequestUsage: (usage) => usages.push(usage),
})
let sawError
try {
  for await (const _chunk of adapter.stream(options)) { /* 丢掉 */ }
} catch (error) {
  sawError = error
}
check('抛 EMPTY_RESPONSE', sawError?.failure?.code === 'EMPTY_RESPONSE', JSON.stringify(sawError?.failure))
check('用量仍计入台账（否则额度账目会漏记这一轮的消耗）', usages.length === 1, JSON.stringify(usages))
check('上报的用量是终态事件里的那一份', usages[0]?.inputTokens === 10 && usages[0]?.outputTokens === 2,
  JSON.stringify(usages))

globalThis.fetch = realFetch

if (failures.length > 0) {
  console.error('\n空回合守卫测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n空回合守卫测试全部通过。')
