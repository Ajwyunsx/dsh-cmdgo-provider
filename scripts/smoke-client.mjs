/**
 * lib/client.js 的本地冒烟测试（无浏览器）。
 *
 * client.js 是手写的 __ModuleLoader__ bundle，不参与 tsc，因此用一个最小
 * 的 React/DOM/fetch 桩把 factory 跑起来，验证：
 *   1. 三个槽都注册了（设置页 / 会话头部胶囊 / 帧级浮层面板）；
 *   2. 胶囊在有账号快照时按「最紧的那条额度」渲染；
 *   3. 面板渲染出每个账号的名字与额度行。
 *
 * 用法：node scripts/smoke-client.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------------- 桩：React ---------------- */

const cleanups = []
let renders = 0

function render(type, props, ...children) {
  renders += 1
  const next = { ...(props || {}) }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  if (typeof type === 'function') return type(next)
  return { type, props: next }
}

const React = {
  createElement: render,
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}

/* ---------------- 桩：宿主 /status 快照 ---------------- */

const status = {
  ok: true,
  credentialRef: 'COMMANDCODE_API_KEY',
  credentialConfigured: true,
  modelCount: 12,
  activeAccounts: 2,
  login: { status: 'idle' },
  accounts: [
    {
      id: 'acct-a', ref: 'COMMANDCODE_API_KEY_ACCT-A', userName: 'alice', keyName: 'cli-a',
      addedAt: 1, enabled: true, failCount: 0, cooling: false, configured: true,
      usage: {
        ok: true, fetchedAt: Date.now() - 5000, stale: false,
        plan: { name: 'Go' }, limited: true,
        monthly: { remaining: 4, total: 10, used: 6, percent: 0.6, purchased: 0, free: 0, extra: 0 },
        fiveHour: { used: 2.4, cap: 3, remaining: 0.6, percent: 0.8, exceeded: false },
        weekly: { used: 3, cap: 6, remaining: 3, percent: 0.5, exceeded: false },
      },
    },
    {
      id: 'acct-b', ref: 'COMMANDCODE_API_KEY_ACCT-B', userName: 'bob', keyName: 'cli-b',
      addedAt: 2, enabled: true, failCount: 0, cooling: false, configured: true,
      usage: {
        ok: true, fetchedAt: Date.now() - 1000, stale: false,
        plan: { name: 'Go' }, limited: true,
        monthly: { remaining: 9, total: 10, used: 1, percent: 0.1, purchased: 0, free: 0, extra: 0 },
        fiveHour: { used: 0.3, cap: 3, remaining: 2.7, percent: 0.1, exceeded: false },
      },
    },
  ],
}

const fakeFetch = async (url) => {
  if (!String(url).startsWith('/api/cmdgo/')) throw new Error('unexpected url ' + url)
  return { ok: true, status: 200, text: async () => JSON.stringify(status) }
}

/* ---------------- 桩：window / document ---------------- */

let loaded = null
const styleNodes = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  open: () => {},
}
globalThis.document = {
  getElementById: (id) => styleNodes.get(id) || null,
  // <style> 是先在元素上赋 id、再 appendChild，所以 id 赋值时就登记，
  // 这样第二次 ensureStyle() 能命中已有节点（与浏览器行为一致）。
  createElement: () => {
    const el = { textContent: '' }
    let id = ''
    Object.defineProperty(el, 'id', { get: () => id, set: (value) => { id = value; styleNodes.set(value, el) } })
    return el
  },
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.fetch = fakeFetch
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
// Node 24 的 globalThis.navigator 只有 getter，不能赋值；源码只用它读剪贴板，
// 这里作为参数注入即可（对应浏览器里的 navigator）。
const navigatorStub = { clipboard: { writeText: async () => {} } }

/* ---------------- 执行 factory ---------------- */

const require_ = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'navigator', source)(
  globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, navigatorStub,
)
if (loaded === null) throw new Error('__ModuleLoader__.load 未被调用')
const mod = loaded.factory(require_)

/* ---------------- 断言 ---------------- */

const failures = []
const check = (label, ok, extra) => {
  if (ok) { console.log('  ok  ' + label) } else { failures.push(label); console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')) }
}

const regs = []
const fakeSlots = {
  inject: (name, cb) => { cb() },
  register: (def, component) => { regs.push({ def, component }); return () => {} },
}
mod.apply({ get: (name) => (name === 'slots' ? fakeSlots : undefined) })

console.log('[1] 槽注册')
check('注册了 3 个条目', regs.length === 3, 'got ' + regs.length)
const bySlot = Object.fromEntries(regs.map((r) => [r.def.name, r]))
check('settings.section 存在', bySlot['settings.section'] !== undefined)
check('会话头部工具区胶囊已注册',
  bySlot['conversation.session.header.utilities'] !== undefined
  && bySlot['conversation.session.header.utilities'].def.id === 'commandcode-go-quota')
check('shell.overlay 面板已注册',
  bySlot['shell.overlay'] !== undefined
  && bySlot['shell.overlay'].def.id === 'commandcode-go-quota-panel')
check('头部胶囊 order 最大（最靠右）',
  bySlot['conversation.session.header.utilities'].def.order > 0)

/* 面板挂载时经 useEffect → refresh() 写入共享快照；等 microtask 落地。 */
console.log('[2] 面板首帧与轮询')
const panelEl = bySlot['shell.overlay'].component({})
check('面板关闭时不渲染（只做轮询）', panelEl === null)
for (let i = 0; i < 12; i += 1) await Promise.resolve()

console.log('[3] 胶囊渲染（取最紧的一条额度）')
const pill = bySlot['conversation.session.header.utilities'].component({})
check('胶囊渲染出按钮', pill !== null && pill.type === 'button')
const pillText = JSON.stringify(pill)
check('胶囊含账号数 ×2', pillText.includes('\u00d72'))
check('胶囊标的是最紧的 5H 80%（alice，不是 bob 的 10%）', pillText.includes('5H 80.0%'))

console.log('[4] 面板渲染（多账号逐条额度）')
const open = bySlot['shell.overlay'].component({})
// 面板用共享 store 的 open 开关；直接改不到，改用组件内部 effect 打开：
// 通过胶囊点击把 open 置位（onClick 是纯函数，可直接调用）。
pill.props.onClick({ stopPropagation: () => {} })
const panelOpen = bySlot['shell.overlay'].component({})
check('打开后面板渲染出浮层', panelOpen !== null && panelOpen.props.className === 'cmdgo-hud')
const openText = JSON.stringify(panelOpen)
check('面板列出 alice 与 bob', openText.includes('alice') && openText.includes('bob'))
check('面板含 5H / 周 / 月 三行额度', openText.includes('5H') && openText.includes('周') && openText.includes('月'))
check('面板含「添加账号」入口', openText.includes('添加账号'))
check('面板含刷新全部', openText.includes('刷新全部'))

/* 合计与理论调用次数：宿主 meter 的三种状态都要如实渲染。 */
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const renderPanel = () => bySlot['shell.overlay'].component({})

console.log('[4b] 合计剩余（全部账号额度相加）')
// 注意：open 是「打开前」那一帧（此时面板返回 null），要用打开后的 panelOpen。
const sumText = openText
check('面板含「合计剩余」', sumText.includes('合计剩余'))
// alice 月剩 4 + bob 月剩 9 = 13；5H 0.6+2.7=3.3；周 3+未上报=3
check('月合计 $13.00（4+9）', sumText.includes('$13.00（月）'), sumText.slice(sumText.indexOf('合计剩余'), sumText.indexOf('合计剩余') + 120))
check('5H 合计 $3.30', sumText.includes('5H $3.30'))
check('周合计 $3.00', sumText.includes('周 $3.00'))
check('标出有数据的账号数 2/2', sumText.includes('2/2 个账号有数据'))

console.log('[4c] 理论调用次数：无 meter（旧宿主）不编数字')
check('面板含「理论次数」', sumText.includes('理论次数'))
check('旧宿主提示需要 0.8.0', sumText.includes('需要宿主 0.8.0'))
check('旧宿主不显示次数', !sumText.includes('≈ '))

console.log('[4d] 理论调用次数：样本不足')
status.meter = { totalCalls: 2, attributedCalls: 0, consumed: 0, samples: 0, ready: false, updatedAt: 0 }
renderPanel()
await settle()
let t4d = JSON.stringify(renderPanel())
check('样本不足时如实说明', t4d.includes('样本不足'), 'no 样本不足')
check('样本不足时给出已计数', t4d.includes('已计 2 次调用'))
check('样本不足时不给次数', !t4d.includes('≈ '))

console.log('[4e] 理论调用次数：样本足够（实测 $0.05/次）')
status.meter = { totalCalls: 41, attributedCalls: 39, consumed: 1.95, perCall: 0.05, samples: 5, ready: true, updatedAt: Date.now() }
renderPanel()
await settle()
const panelReady = renderPanel()
const t4e = JSON.stringify(panelReady)
check('给出月合计理论次数 13/0.05 = 260', t4e.includes('≈ 260 次'), t4e.slice(t4e.indexOf('理论次数'), t4e.indexOf('理论次数') + 220))
check('给出 5H 窗口内次数 3.3/0.05 = 66', t4e.includes('5H 窗口内 ≈ 66 次'))
check('标注实测单价与样本数', t4e.includes('$0.05/次') && t4e.includes('样本 39 次调用'))

console.log('[4f] 胶囊同步显示合计与次数')
const pillReady = bySlot['conversation.session.header.utilities'].component({})
const t4f = JSON.stringify(pillReady)
check('胶囊含合计 Σ$13.0', t4f.includes('Σ$13.0'), t4f)
check('胶囊含 ≈260次', t4f.includes('≈260次'))
check('胶囊保留最紧百分比', t4f.includes('5H 80.0%'))

console.log('[4g] 剩余额度（美元）显示在百分比左侧')
// 文案区分：行内是「剩$0.60」（无空格），tooltip 里是「剩余 $0.60」（有空格）。
// 用无空格形式命中，才能确保断言的是左侧那一列而不是 title 属性。
const iRem = t4e.indexOf('剩$0.60')
const iPct = t4e.indexOf('80.0%')
check('alice 5H 显示 剩$0.60', iRem >= 0)
check('剩余额度排在百分比之前（即左侧）', iRem >= 0 && iPct >= 0 && iRem < iPct, 'iRem=' + iRem + ' iPct=' + iPct)
check('月度行也显示剩余 剩$4.00', t4e.includes('剩$4.00'))
check('第二个账号的 5H 剩余 剩$2.70', t4e.includes('剩$2.70'))
check('周行显示剩余 剩$3.00', t4e.includes('剩$3.00'))
// 真正验证「缺字段就不渲染」：把某窗口的 remaining 抹掉再看。
const savedWeekly = status.accounts[0].usage.weekly
status.accounts[0].usage.weekly = { used: 3, cap: 6, percent: 0.5 }
renderPanel()
await settle()
check('remaining 缺失时该列整体不渲染（不出现 剩$—）', !/剩\$—/.test(JSON.stringify(renderPanel())))
status.accounts[0].usage.weekly = savedWeekly

console.log('[5] 样式注入')
check('HUD 样式独立注入且含主题变量',
  (styleNodes.get('cmdgo-hud-style') || {}).textContent?.includes('--dsw-alias-label-primary') === true,
  'style id missing')
check('设置页 .cmdgo-* 基础样式一并注入（面板复用 QuotaBlock）',
  (styleNodes.get('cmdgo-console-style') || {}).textContent?.includes('.cmdgo-qrow') === true)
check('渲染次数 > 0', renders > 0)

/* 清掉注册的 effect 清理函数，避免桩里的订阅残留。 */
cleanups.forEach((fn) => { try { fn() } catch (e) { /* 忽略 */ } })

if (failures.length > 0) {
  console.error('\n冒烟失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n冒烟全部通过。')
