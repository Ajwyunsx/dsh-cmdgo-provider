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
