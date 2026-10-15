/**
 * 附件请求形状兼容的本地测试（issue #12）。
 *
 * dsh 0.2.x 的 `attachments.readImageRequest(ref, target, signal)` 第二参数是
 * `ImageRequestTarget`（`{ width, height, maxBytes }`），实现第一行就是
 * `validateTarget()`：三个字段都必须是正整数，缺 `width`/`height` 直接抛
 * `AttachmentError`。而插件此前传的是 0.1.x 的 policy 形状
 * `{ maxPixels, maxBytes }`——于是 0.2.x 上**100% 图片、所有模型、无日志**地
 * 降级成 `[image omitted: … could not be read]`，视觉全灭。
 *
 * 场景：
 *   1. 0.2.x 宿主：传给 `readImageRequest` 的必须是含正整数 width/height/maxBytes
 *      的 target，几何与宿主 `requestImageDimensions()` 逐位一致，且真拿到图片；
 *   2. 0.1.x 宿主：新形状被拒后回退旧 policy 形状，图片同样送达；
   3. 形状按 attachmentId 记忆，不每次试错；
   4. 非形状错误（附件真坏了）不回退、只读一次；
   5. 失败时 resolver 侧留下 warn 日志（每个 attachmentId 一次），不再静默；
   6. 附件服务缺席时仍返回 undefined（协议层给占位文字）。
 *
 * 用法：node scripts/smoke-image-target.mjs
 */

import { apply } from '../lib/index.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

/** 宿主 request-projection 的参照实现（0.1.x / 0.2.x 逐位一致）。 */
function hostDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let w = Math.max(1, Math.floor(width * scale))
    let h = Math.max(1, Math.round((w * height) / width))
    while (w * h > maxPixels && w > 1) { w -= 1; h = Math.max(1, Math.round((w * height) / width)) }
    return { width: w, height: h }
  }
  let h = Math.max(1, Math.floor(height * scale))
  let w = Math.max(1, Math.round((h * width) / height))
  while (w * h > maxPixels && h > 1) { h -= 1; w = Math.max(1, Math.round((h * width) / height)) }
  return { width: w, height: h }
}

const POLICY = { maxPixels: 640_000, maxBytes: 1024 * 1024 }

/** 构造一个插件实例：桩掉 attachments 之外的宿主服务。 */
async function makePlugin(attachmentService) {
  const logs = []
  const services = new Map()
  if (attachmentService !== undefined) services.set('attachments', attachmentService)
  const ctx = {
    logger: {
      info: (...a) => logs.push(['info', a]),
      warn: (...a) => logs.push(['warn', a]),
      error: (...a) => logs.push(['error', a]),
      debug: () => {},
    },
    fiber: undefined,
    effect() {},
    get(name) { return services.get(name) },
    inject() {},
    on() {},
    llm: {
      registerConfigurableProviders() { return () => {} },
      registerAdapter(_providers, adapter) {
        ctx.__adapter = adapter
        return { replace() {} }
      },
    },
  }
  const errors = []
  try {
    await apply(ctx, {
      apiKeyEnv: 'COMMANDCODE_API_KEY',
      baseURL: 'https://api.commandcode.ai',
      maxTokens: 64000,
      defaultContextWindow: 1000000,
      retryPolicy: { mode: 'normal', maxRetries: 1, retryableCodes: ['EMPTY_RESPONSE'], backoff: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 } },
    })
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) throw new Error('apply failed: ' + errors.map((e) => e.message).join(' | '))
  // resolveImage 是 adapter 的闭包；通过 llm.registerAdapter 拿到 adapter 再取。
  const adapter = ctx.__adapter
  return { logs, adapter }
}

/** 从 adapter 里挖出 resolveImage（构造参数对象上；`config` 是 private，运行时可读）。 */
const resolverOf = (adapter) => adapter?.config?.resolveImage

/** 一张 harness 图片块。 */
const imageBlock = (id, width, height) => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 12345, width, height },
})

/* ---------- [1] 0.2.x 宿主：target 形状 + 宿主同一套几何 ---------- */
console.log('[1] dsh 0.2.x 宿主：target { width, height, maxBytes }')
const seen = []
const attachments020 = {
  async readImageRequest(ref, shape) {
    seen.push({ ref, shape })
    // 0.2.x 的 validateTarget：三个字段都必须是正整数。
    for (const key of ['width', 'height', 'maxBytes']) {
      const value = shape[key]
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Image request ${key} must be a positive integer. (INVALID_ATTACHMENT_REF)`)
      }
    }
    return { data: new Uint8Array([1, 2, 3]), mediaType: 'image/webp', width: shape.width, height: shape.height }
  },
}
const p1 = await makePlugin(attachments020)
const resolve1 = resolverOf(p1.adapter)
check('插件装配不抛错（attachments 缺席也不抛）', typeof resolve1 === 'function')

seen.length = 0
const dataUrl1 = await resolve1(imageBlock('sha256:aaaaaaaaaaaaaaaa', 4000, 3000))
check('0.2.x 宿主上图片真的读到（不是占位）',
  typeof dataUrl1 === 'string' && dataUrl1.startsWith('data:image/webp;base64,'), String(dataUrl1).slice(0, 40))
check('readImageRequest 只被调了一次', seen.length === 1, 'calls=' + seen.length)
const target = seen[0]?.shape
check('第二参数是 target 形状（含 width/height/maxBytes）',
  target !== undefined && target.width !== undefined && target.height !== undefined && target.maxBytes !== undefined,
  JSON.stringify(target))
check('三个字段都是正整数',
  ['width', 'height', 'maxBytes'].every((k) => Number.isSafeInteger(target?.[k]) && target[k] > 0),
  JSON.stringify(target))
const want = hostDimensions(4000, 3000, POLICY.maxPixels)
check('几何与宿主 requestImageDimensions 逐位一致',
  target.width === want.width && target.height === want.height,
  `got ${target.width}x${target.height}, want ${want.width}x${want.height}`)
check('maxBytes 直通 policy 的字节预算', target.maxBytes === POLICY.maxBytes, String(target.maxBytes))
seen.length = 0
await resolve1(imageBlock('sha256:bbbbbbbbbbbbbbbb', 100, 80))
check('target 不放大（小于预算时保持原尺寸）',
  seen[0].shape.width === 100 && seen[0].shape.height === 80, JSON.stringify(seen[0].shape))
seen.length = 0
await resolve1(imageBlock('sha256:cccccccccccccccc', 500, 4000))
// 500x4000 走宿主算法的高度分支；同一预算下与参照实现逐位一致。
const wantVertical = hostDimensions(500, 4000, POLICY.maxPixels)
check('竖图走高度分支且与宿主几何一致',
  seen[0].shape.width === wantVertical.width && seen[0].shape.height === wantVertical.height,
  JSON.stringify(seen[0].shape) + ' vs ' + JSON.stringify(wantVertical))

/* ---------- [2] 0.1.x 宿主：新形状被拒 → 回退 policy ---------- */
console.log('[2] dsh 0.1.x 宿主：validateTarget 拒新形状 → 回退 { maxPixels, maxBytes }')
const seenLegacy = []
const attachments010 = {
  async readImageRequest(ref, shape) {
    seenLegacy.push(shape)
    // 0.1.x 的 validatePolicy：认 maxPixels/maxBytes，不认 width/height。
    if (!Number.isSafeInteger(shape.maxPixels) || shape.maxPixels <= 0) {
      throw new Error(`Image request width must be a positive integer. (INVALID_ATTACHMENT_REF)`)
    }
    return { data: new Uint8Array([4, 5]), mediaType: 'image/jpeg' }
  },
}
const p2 = await makePlugin(attachments010)
const resolve2 = resolverOf(p2.adapter)
const dataUrl2 = await resolve2(imageBlock('sha256:dddddddddddddddd', 4000, 3000))
check('0.1.x 宿主上图片同样读到', typeof dataUrl2 === 'string' && dataUrl2.startsWith('data:image/jpeg;base64,'),
  String(dataUrl2).slice(0, 40))
const last = seenLegacy.at(-1)
check('回退后的形状是旧 policy（maxPixels/maxBytes）',
  last !== undefined && last.maxPixels === POLICY.maxPixels && last.maxBytes === POLICY.maxBytes,
  JSON.stringify(last))
seenLegacy.length = 0
await resolve2(imageBlock('sha256:dddddddddddddddd', 4000, 3000))
check('回退只发生一次（第二次调用直接走缓存的旧形状）',
  seenLegacy.length === 1 && seenLegacy[0].maxPixels === POLICY.maxPixels,
  'calls=' + seenLegacy.length + ' last=' + JSON.stringify(seenLegacy.at(-1)))

/* ---------- [3] 非形状错误：不回退，只读一次 ---------- */
console.log('[3] 非形状错误（附件真坏了）：不回退')
let brokenCalls = 0
let thrown3
const attachmentsBroken = {
  async readImageRequest(_ref, shape) {
    brokenCalls += 1
    if (shape.width !== undefined) throw new Error('attachment file is missing from the store')
    return { data: new Uint8Array([9]), mediaType: 'image/png' }
  },
}
const p3 = await makePlugin(attachmentsBroken)
const resolve3 = resolverOf(p3.adapter)
const url3 = await resolve3(imageBlock('sha256:eeeeeeeeeeeeeeee', 1000, 800)).then(
  (value) => value,
  (error) => {
    thrown3 = error
    return undefined
  },
)
check('存储层真错误在 0.2.x 形状上直接抛（不假装是形状问题）', brokenCalls === 1 && thrown3 !== undefined,
  'calls=' + brokenCalls + ' thrown=' + String(thrown3?.message))
check('失败时 resolver 不给 dataUrl（协议层将给占位文字）', url3 === undefined)

/* ---------- [4] 失败要留痕：warn 日志，每个 attachmentId 一次 ---------- */
console.log('[4] 失败不再静默：warn 日志（每个 attachmentId 一次）')
const logs4 = p3.logs.filter(([level]) => level === 'warn')
check('失败留下 warn 日志且带原始 message', logs4.length === 1 && /attachment file is missing/.test(String(logs4[0][1].join(' '))),
  JSON.stringify(logs4))
await resolve3(imageBlock('sha256:eeeeeeeeeeeeeeee', 1000, 800)).catch(() => {})
const logs4b = p3.logs.filter(([level]) => level === 'warn')
check('同一 attachmentId 只告警一次（重试不刷屏）', logs4b.length === 1, 'warns=' + logs4b.length)

/* ---------- [5] 附件服务缺席：undefined（协议层占位） ---------- */
console.log('[5] attachments 服务缺席')
const p5 = await makePlugin(undefined)
const url5 = await resolverOf(p5.adapter)(imageBlock('sha256:ffffffffffffffff', 1000, 800))
check('缺席时返回 undefined（不是占位文字，占位由协议层给）', url5 === undefined)

/* ---------- [6] 端到端：坏附件在请求里变成占位文字（带警告） ---------- */
console.log('[6] 端到端：协议层占位文字仍在，日志有原因')
const { buildRequest } = await import('../lib/protocol.js')
const body = await buildRequest(
  {
    provider: 'commandcode',
    model: 'deepseek-v4.1-flash',
    messages: [{ role: 'user', content: [imageBlock('sha256:eeeeeeeeeeeeeeee', 1000, 800)] }],
  },
  resolverOf(p3.adapter),
)
const userParts = body.params.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [m.content]))
check('请求里没有裸 image part（坏图不进请求）', !userParts.some((part) => part?.type === 'image'),
  JSON.stringify(userParts).slice(0, 120))
check('请求里有占位文字（与 #12 现象一致，但现在日志能定位）',
  userParts.some((part) => typeof part === 'string' && part.includes('[image omitted: attachment sha256:eeeeeeeeeeeeeeee')),
  JSON.stringify(userParts).slice(0, 160))

if (failures.length > 0) {
  console.error('\n附件形状测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n附件形状测试全部通过。')
