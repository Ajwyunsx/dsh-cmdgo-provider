/**
 * 用**真实的** `@deepseek-ai/dsh-settings` 跑通 dsh 0.1.7+ 的设置投影
 * （issue #8 问题一的端到端验证）。
 *
 * `smoke-settings.mjs` 用桩证明了「新宿主不会静默消失」；这里更进一步：把本插件
 * 的 Config 挂到一个真的 SettingsForms 服务上，调它自己的 `describe()`，断言
 *   1. 本插件出现在表单目录里，命名空间是 **entry id**（`cmdgo-provider`）
 *      ——0.1.7 起 `ns: entry.options.id`，这正是「按自报 NS 去找会找不到」的坑；
 *   2. 五个字段都被投影成**可编辑**（`volatileForm()` 只收 volatile 字段）；
 *   3. `update()` 不会因为「字段不是 volatile」被拒。
 *
 * 解析不到 dsh-settings 时**跳过**（exit 0），因为它不是本插件的运行依赖；
 * 装了但投影为空则必须失败——那正是 issue #8 的故障形态。
 *
 * 用法：
 *   node scripts/smoke-settings-projection.mjs
 *   # 本仓库开发（宿主是另一棵树）：
 *   DSH_HOST_MODULES=/path/to/host/node_modules node scripts/smoke-settings-projection.mjs
 */

import { lstat, mkdtemp, rm, symlink, unlink as unlinkFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

/**
 * 临时把宿主的 `dsh-settings` / `cordis` 链进包内 node_modules。
 *
 * `lib/index.js` 对 peer 是**按包目录**解析的（`import '@deepseek-ai/dsh-llm'`），
 * 所以宿主装在同一棵树里时天然可用；开发机上宿主是另一棵树，这里才需要补链。
 * 返回清理函数（已存在的真实安装不动它）。
 */
async function linkHostModules() {
  const host = process.env.DSH_HOST_MODULES
  if (host === undefined || host.length === 0) return async () => {}
  const dir = new URL('../node_modules/@deepseek-ai/', import.meta.url)
  const created = []
  for (const name of ['dsh-settings', 'cordis']) {
    const dest = new URL(name, dir)
    // 已存在的**符号链接**是我们自己上一次留下的，必须改指到本次宿主树；真实目录
    // 是真正的安装（自洽的一份），留着它不动。混用两棵树的关键包会让 SettingsForms
    // 与 cordis 分属不同 realm，describe() 结果不可信。
    let existing
    try {
      existing = await lstat(dest)
    } catch { /* 不存在 */ }
    if (existing !== undefined && !existing.isSymbolicLink()) continue
    if (existing !== undefined) await unlinkFile(dest).catch(() => {})
    try {
      await symlink(`${host.replace(/\/?$/, '/')}@deepseek-ai/${name}`, dest, 'dir')
      created.push(dest)
    } catch { /* 竞争失败就当没链上，后面的解析会给出真实结论 */ }
  }
  return async () => {
    for (const dest of created) await unlinkFile(dest).catch(() => {})
  }
}

const unlink = await linkHostModules()

/** 按名解析；缺席返回 undefined（可选依赖）。 */
async function optional(specifier) {
  try {
    return await import(specifier)
  } catch {
    return undefined
  }
}

const settingsMod = await optional('@deepseek-ai/dsh-settings')
const cordisMod = await optional('@deepseek-ai/cordis')

/**
 * 只有**显式指定了宿主树**时才算「真实投影」场景。
 *
 * 不指定时裸解析可能命中的是任意一棵不完整的树（本机恰好存在的副本、包管理器的
 * 全局缓存……），拿它跑 describe() 得到的空结果说明不了本插件有问题——那是环境
 * 而不是缺陷。所以不指定就跳过，指定了就必须过（那才是真的在验插件）。
 */
if ((process.env.DSH_HOST_MODULES ?? '').length === 0) {
  await unlink()
  console.log('跳过：未指定 DSH_HOST_MODULES（没有可用的宿主树）')
  console.log('要跑真实投影：DSH_HOST_MODULES=<宿主>/node_modules node scripts/smoke-settings-projection.mjs')
  process.exit(0)
}

if (settingsMod === undefined || cordisMod === undefined) {
  await unlink()
  console.log('跳过：指定了 DSH_HOST_MODULES，但那里的 @deepseek-ai/dsh-settings / cordis 解析不到')
  process.exit(0)
}

const SettingsForms = settingsMod.SettingsForms ?? settingsMod.default
if (typeof SettingsForms !== 'function') {
  await unlink()
  console.log('跳过：该版本未导出 SettingsForms')
  process.exit(0)
}

const { Context, Service } = cordisMod

/* ---------- 宿主侧的最小 composition ---------- */
const workDir = await mkdtemp(join(tmpdir(), 'cmdgo-proj-'))
const patchPath = join(workDir, 'cordis.patch.yml')

const root = new Context()

class TestConfigEditor extends Service {
  configuration() {
    return [{ entry: publishedEntry, inherited: {}, override: {} }]
  }
  get documentPath() { return patchPath }
}

/** profile 里的 loader entry：0.1.7 的 describe() 就是按它取 id 与 schema。 */
const publishedEntry = {
  id: 'cmdgo-provider',
  options: { id: 'cmdgo-provider', config: {} },
}

try {
  const { Config } = await import('../lib/index.js')

  // 挂到一个真实 fiber 上：SettingsForms.schema() 读 `entry.fiber.runtime.Config`，
  // 只有真跑一次 ctx.plugin() 才有 runtime。
  let fiber
  root.plugin({
    name: 'cmdgo-provider',
    Config,
    apply(ctx) { fiber = ctx.fiber },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  publishedEntry.fiber = fiber

  // 构造函数会读 `ctx.root.loader.await()`（0.1.7 用它迁移旧 settings.yaml）；
  // 测试里没有真 loader，给一个立刻 settle 的桩。
  root.root.loader = { await: () => Promise.resolve() }
  root.provide('configEditor')
  root.set('configEditor', new TestConfigEditor(root))
  // SettingsForms 的构造函数自己注册成 "settings"（`super(ctx, "settings")`）。
  const forms = new SettingsForms(root)

  // 插件在真实场景里会调的正是这一个方法（见 src/index.ts 的 settings 注入块）。
  if (typeof forms.configure === 'function') forms.configure({ auto: false }, fiber)

  /* ---------- [1] describe() 能找到本插件的表单 ---------- */
  console.log('[1] describe()：按 entry id 找到本插件')
  const described = forms.describe()
  const rows = Array.isArray(described) ? described : Object.values(described ?? {})
  const mine = rows.find((row) => row?.ns === 'cmdgo-provider')
  check('表单目录里有 cmdgo-provider（entry id，不是自报的 NS）', mine !== undefined,
    JSON.stringify(rows.map((r) => r?.ns)))
  if (mine === undefined) {
    // 投影不出来 = 设置页整块消失，正是 issue #8 的故障形态。
    check('设置页会显示该区块（否则就是 issue #8 复现）', false, 'ns 未出现')
  } else {
    check('autoGenerate 为 false（插件声明的页面策略）', mine.autoGenerate === false, String(mine.autoGenerate))

    /* ---------- [2] 五个字段都可编辑 ---------- */
    console.log('[2] 字段投影：五个 volatile 字段都可编辑')
    // describe() 给的是表单 schema 的 `toJSON()` 引用池：根节点自己也在 refs 里，
    // 字段表挂在它的 `dict` 上（直接读 schema.dict 永远是空的）。
    const pool = mine.schema ?? {}
    const rootNode = pool.refs?.[pool.uid] ?? {}
    const formDict = rootNode.dict ?? {}
    const metaOf = (key) => {
      const ref = formDict[key]
      return ref === undefined ? undefined : pool.refs?.[ref]?.meta
    }
    for (const key of ['apiKeyEnv', 'baseURL', 'maxTokens', 'defaultContextWindow', 'retryPolicy']) {
      check(`  ${key} 出现在表单里（可编辑）`, Object.hasOwn(formDict, key), JSON.stringify(Object.keys(formDict)))
    }
    check('apiKeyEnv 保留 credential-ref 角色',
      metaOf('apiKeyEnv')?.role === 'credential-ref', JSON.stringify(metaOf('apiKeyEnv')))
    check('maxTokens 带着默认值 64000',
      metaOf('maxTokens')?.default === 64000 || mine.value?.maxTokens === 64000,
      JSON.stringify({ meta: metaOf('maxTokens')?.default, value: mine.value?.maxTokens }))
    check('表单 schema 已剥掉 volatile 标记（plainSchema 的行为）',
      !JSON.stringify(pool).includes('"volatile":true'), 'volatile 未剥离')

    /* ---------- [3] update() 不被「非 volatile」拒 ---------- */
    if (typeof forms.update === 'function') {
      console.log('[3] update()：写入校验接受这些字段')
      let updateError
      try {
        await forms.update('cmdgo-provider', { maxTokens: 4321 }, mine.revision)
      } catch (error) {
        updateError = error
      }
      // 桩不落盘，但 0.1.7 会先校验「字段位于 volatile 之下」再写：非 volatile
      // 会抛 "is not volatile"。
      check('update() 不因「字段不可 volatile」被拒',
        updateError === undefined || !/not volatile/.test(String(updateError?.message)),
        String(updateError?.message))
    }
  }
} finally {
  await unlink()
  await rm(workDir, { recursive: true, force: true }).catch(() => {})
}

if (failures.length > 0) {
  console.error('\n设置投影测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n设置投影测试全部通过（真实 dsh-settings）。')
