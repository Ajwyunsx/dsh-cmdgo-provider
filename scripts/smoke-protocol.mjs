/**
 * 协议层的本地单元测试（直接跑编译产物 lib/protocol.js + lib/adapter.js，无宿主依赖）。
 *
 * 这里钉的是 issue #5 / #6 的两条不变量：
 *
 * [A] 工具调用双射（issue #5 —— 网关判「Tool result is missing」把会话卡死）：
 *     1. 孤儿调用（有 tool-call 没结果）→ 丢掉；
 *     2. 孤儿结果（有结果没调用）→ 也丢掉（反向孤儿同样破坏形状）；
 *     3. 同 id 重复 → 两侧各只发一次；
 *     4. 自愈点名（repair.dropToolCallIds）→ 两侧一起丢；
 *     5. 被丢掉的结果里嵌的图片不许单独发出去。
 *
 * [B] 流事件 → chunk：
 *     6. 缺 id 的 tool-call 按块下标合成唯一 id；
 *     7. 同一个调用的重复投递（id + 载荷相同）→ 丢掉，不让工具被执行两次；
 *     8. 同 id 但载荷不同 → 加后缀区分，保住这次真实调用；
 *     9. usage 的缓存读 / 写如实透传（缺失时省略，不编 0）。
 *
 * [C] x-session-id（issue #6）：
 *    10. 官方形状 `sess_<16 位小写十六进制>`；
 *    11. 同一会话稳定（续写 / 重试复用同一个 id），不同会话不同；
 *    12. 没有会话身份时退回进程级常量（CLI 语义），且同样是官方形状。
 *
 * 用法：node scripts/smoke-protocol.mjs
 */

import { buildRequest, eventToChunks, usageSummary } from '../lib/protocol.js'
import { cliSessionIdFor } from '../lib/adapter.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

const call = (id) => ({ type: 'tool-call', id, name: 'read_image', arguments: '{"path":"a.png"}' })
const result = (id, text = 'ok') => ({ type: 'tool-result', toolCallId: id, toolName: 'unknown', isError: false, content: [{ type: 'text', text }] })
const image = (attachmentId) => ({ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 10, width: 2, height: 2 } })

const request = (messages, resolveImage, repair) => buildRequest(
  { provider: 'commandcode', model: 'deepseek-v4.1-flash', messages },
  resolveImage,
  repair,
)

/** 请求里的 assistant / tool 两侧 id。 */
function pairingOf(body) {
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

const rounds = (list) => list.join(',')

/* Current DSH uses standalone tool messages rather than nested result blocks. */
console.log('[A0] 独立工具消息兼容')
const standalone = (id, text = 'ok', isError = false) => ({
  role: 'tool', toolCallId: id, isError, content: [{ type: 'text', text }],
})
const nativeHistory = [
  { role: 'assistant', content: [{ type: 'text', text: '读取下一行。' }, call('native')] },
  standalone('native', 'line 19'),
]
const snapshot = JSON.stringify(nativeHistory)
const native = await request(nativeHistory)
const legacy = await request([nativeHistory[0], { role: 'user', content: [result('native', 'line 19')] }])
check('独立结果和旧嵌套结果序列化一致', JSON.stringify(native.params) === JSON.stringify(legacy.params))
check('说明之后的历史调用保留', native.params.messages[0].content.some(part => part.type === 'tool-call'))
check('结果保持 tool 身份而非普通 user 文本', native.params.messages[1].role === 'tool' && native.params.messages[1].content[0].output.value === 'line 19')
check('不修改调用方历史', JSON.stringify(nativeHistory) === snapshot)
const failedNative = await request([nativeHistory[0], standalone('native', 'denied', true)])
check('独立工具错误保留 error-text', failedNative.params.messages[1].content[0].output.type === 'error-text')
const duplicatesNative = await request([...nativeHistory, { role: 'user', content: [result('native')] }])
check('两种格式混合时结果只发一次', pairingOf(duplicatesNative).results.length === 1)
const removedNative = await request(nativeHistory, undefined, { dropToolCallIds: new Set(['native']) })
check('修复过滤仍删除独立消息两侧', pairingOf(removedNative).calls.length === 0 && pairingOf(removedNative).results.length === 0)
let imageResolutions = 0
const nativeImage = { role: 'tool', toolCallId: 'native', content: [image('native-image')] }
const resolveNativeImage = async () => { imageResolutions++; return 'data:image/png;base64,AAAA' }
const imageBody = await request([nativeHistory[0], nativeImage], resolveNativeImage)
check('独立结果里的图片仍发送', imageResolutions === 1 && JSON.stringify(imageBody.params.messages).includes('data:image/png;base64,AAAA'))
imageResolutions = 0
const orphanNative = await request([nativeImage], resolveNativeImage)
check('孤儿独立结果及其图片不泄漏', pairingOf(orphanNative).results.length === 0 && imageResolutions === 0)

const multiNative = await request([
  { role: 'assistant', content: [call('first')] }, standalone('first', 'first result'),
  { role: 'assistant', content: [{ type: 'text', text: '继续读取。' }, call('second')] }, standalone('second', 'second result'),
])
check('连续步骤的历史调用和结果完整配对', rounds(pairingOf(multiNative).calls) === 'first,second' && rounds(pairingOf(multiNative).results) === 'first,second')

/* ---------- [A1] 工具结果与图片的排序（网关的配对是「紧邻」判定） ---------- */
console.log('[A1] 并行调用 + 结果内嵌图片时，user 消息不许插进 tool 结果中间')

/**
 * 工具结果里嵌的图片会额外产生一条 `user` 消息。若它紧跟在对应 `tool` 之后，
 * 后面那些调用的结果就被一条 user 隔开，网关判「Tool result is missing」，
 * 适配器只好把那个调用连结果一起丢掉重发 —— 模型看到的历史是坏的，于是不再
 * 调工具、只吐一段推理就收尾（turn 被记成 completed）。
 *
 * 断言的是**网关实际收到的 body**，不是我们刚写的代码：assistant 之后必须先把
 * 连续的 `tool` 消息全部走完，才允许出现 `user`。
 */
const interleaved = await request([
  { role: 'assistant', content: [call('p1'), call('p2')] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'p1', toolName: 'screenshot', isError: false, content: [image('img-p1'), { type: 'text', text: 'shot 1' }] }] },
  { role: 'user', content: [{ type: 'tool-result', toolCallId: 'p2', toolName: 'screenshot', isError: false, content: [image('img-p2'), { type: 'text', text: 'shot 2' }] }] },
], async () => 'data:image/png;base64,AAAA')
const roles = interleaved.params.messages.map(message => message.role)
const callIdx = roles.indexOf('assistant')
let toolRun = 0
for (let i = callIdx + 1; i < roles.length && roles[i] === 'tool'; i++) toolRun += 1
check('两条结果在 assistant 之后紧邻、不夹 user', toolRun === 2, 'roles=' + JSON.stringify(roles))
check('结果里的图片仍然发出（排序修正没有吞图）',
  (JSON.stringify(interleaved.params.messages).match(/data:image\/png;base64,AAAA/g) ?? []).length === 2)
check('配对仍是 p1,p2', rounds(pairingOf(interleaved).results) === 'p1,p2')
check('图片消息排在整段 tool 结果之后',
  roles.indexOf('user', callIdx) > callIdx + 2, 'roles=' + JSON.stringify(roles))

/* ---------- [A] 工具调用双射 ---------- */
console.log('[A] 工具调用双射（issue #5）')

const both = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01'), result('call_02')] },
])
let p = pairingOf(both)
check('两个调用 + 两个结果都在', rounds(p.calls) === 'call_01,call_02' && rounds(p.results) === 'call_01,call_02', rounds(p.calls) + ' / ' + rounds(p.results))

const orphanCall = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01')] },
])
p = pairingOf(orphanCall)
check('孤儿调用（call_02 无结果）被丢掉', rounds(p.calls) === 'call_01', rounds(p.calls))

const orphanResult = await request([
  { role: 'assistant', content: [call('call_01')] },
  { role: 'user', content: [result('call_01'), result('call_09')] },
])
p = pairingOf(orphanResult)
check('孤儿结果（call_09 无调用）被丢掉', rounds(p.results) === 'call_01', rounds(p.results))

const duplicated = await request([
  { role: 'assistant', content: [call('call_01'), call('call_01')] },
  { role: 'user', content: [result('call_01'), result('call_01')] },
])
p = pairingOf(duplicated)
check('同 id 重复调用只发一次', rounds(p.calls) === 'call_01', rounds(p.calls))
check('同 id 重复结果只发一次', rounds(p.results) === 'call_01', rounds(p.results))

const repaired = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01'), result('call_02')] },
], undefined, { dropToolCallIds: new Set(['call_01']) })
p = pairingOf(repaired)
check('自愈点名 call_01：调用侧丢掉', rounds(p.calls) === 'call_02', rounds(p.calls))
check('自愈点名 call_01：结果侧同步丢掉', rounds(p.results) === 'call_02', rounds(p.results))

let resolvedImages = 0
const droppedImages = await request([
  { role: 'assistant', content: [call('call_01')] },
  { role: 'user', content: [{ ...result('call_09', ''), content: [image('att-dropped')] }] },
], async () => { resolvedImages += 1; return 'data:image/png;base64,AA==' })
const imageParts = droppedImages.params.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((part) => part.type === 'image')
check('被丢掉的结果里的图片不单独发出', imageParts.length === 0 && resolvedImages === 0, 'images=' + imageParts.length + ' resolved=' + resolvedImages)

/* ---------- [B] 流事件 → chunk ---------- */
console.log('[B] 流事件 → chunk')

const state = () => ({ blockIndex: 0 })
const push = (st, event) => {
  if (event.type === 'tool-call') st.blockIndex += 1
  return eventToChunks(event, st)
}

let st = state()
const first = push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } })
const repeat = push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } })
check('首个调用发出', first.length === 1 && first[0].id === 'call_01')
check('完全相同的重复投递被丢掉（不执行两次工具）', repeat.length === 0)

st = state()
const differing = push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } })
const second = push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'b.png' } })
check('同 id 不同载荷 → 加后缀区分', differing[0].id === 'call_01' && second[0].id === 'call_01-2', differing[0].id + ' / ' + second[0].id)

st = state()
const anonymous = push(st, { type: 'tool-call', toolName: 'read_image', input: {} })
check('缺 id → 按块下标合成唯一 id', anonymous[0].id === 'call-1', String(anonymous[0].id))

const withCache = usageSummary({ type: 'finish-step', usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 5 }, outputTokenDetails: { textTokens: 18, reasoningTokens: 2 } } })
check('usage 缓存读透传', withCache.cacheReadTokens === 60, String(withCache.cacheReadTokens))
check('usage 缓存写透传', withCache.cacheWriteTokens === 5, String(withCache.cacheWriteTokens))
check('usage 输入只算未命中部分', withCache.inputTokens === 40, String(withCache.inputTokens))
check('usage 推理 token 透传', withCache.reasoningTokens === 2, String(withCache.reasoningTokens))

const withoutCache = usageSummary({ type: 'finish', usage: { inputTokens: 7, outputTokens: 3 } })
check('网关没报缓存字段时不编 0', withoutCache.cacheReadTokens === undefined && withoutCache.cacheWriteTokens === undefined)

const usageChunks = eventToChunks({ type: 'finish', usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60 } } }, state())
const usageChunk = usageChunks.find((chunk) => chunk.type === 'usage')
check('finish 事件仍产出 usage chunk', usageChunk !== undefined && usageChunk.usage.cacheReadTokens === 60)

/* ---------- [C] x-session-id ---------- */
console.log('[C] x-session-id（issue #6）')

const shape = /^sess_[0-9a-f]{16}$/
const cliShape = /^sess_[0-9a-f]{16}$/
const a = cliSessionIdFor('sess_abc123')
const b = cliSessionIdFor('sess_abc123')
const c = cliSessionIdFor('sess_other')
check('官方形状 sess_<16 hex>', shape.test(a), a)
check('同一会话稳定（续写/重试复用）', a === b)
check('不同会话不同 id', a !== c)
const fallback = cliSessionIdFor(undefined)
check('没有会话身份时退回进程级常量', cliShape.test(fallback) && fallback === cliSessionIdFor(''), fallback)
check('不再出现旧的 cli-<时间戳> 形状', !a.startsWith('cli-') && !fallback.startsWith('cli-'))

if (failures.length > 0) {
  console.error('\n协议测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n协议测试全部通过。')
