# AGENTS.md — dsh-cmdgo-provider 开发须知

CommandCode **Go 套餐**的 DSH 供应商插件：Go 订阅没有 Provider API（OpenAI 兼容端点
回 403 `upgrade_required`），所有请求必须走 CLI 私有网关 `POST /alpha/generate`。本
文档是给在这个仓库里干活的 agent 的——下面每一条几乎都对应一个真实 issue 或一次
真机翻车，改代码前先读完。

## 命令

```bash
bun run build        # bash scripts/build.sh：tsc → lib/（lib/client.js 是手写 bundle，不经 tsc）
bun run typecheck    # tsc -p tsconfig.json --noEmit —— 门禁，改动后必须 exit 0
bun run smoke        # 9 个 scripts/smoke-*.mjs 串行，全部 exit 0 才算过
```
没有测试框架：回归全靠 `scripts/smoke-*.mjs`（Node 直跑、自写断言）。**改行为必须
同步补断言**，`smoke` 绿了才算完；`smoke` 跑的是 `lib/` 产物，所以**先 build 再
smoke**，只跑 smoke 会测到旧代码。

### 构建环境（本机没有全局 node_modules 时）

`scripts/build.sh` 需要 `DSH_CHECKOUT` 指向一棵含 `@deepseek-ai/*` peer 的宿主树
（它会把 peer junction 进包内 `node_modules/`，typescript 也从那里找）。本机开发
可用任意一棵装了 dsh 的树，例如：

```bash
DSH_CHECKOUT=/path/to/host/node_modules/.. bun run build
```

注意 `node_modules/@deepseek-ai/` 下的链接**不要提交**，也**不要为了跑测试把
`cordis`/`dsh-settings` 链到另一棵版本不同的树**——tsc 会看到两份 cordis 类型直接
报错，运行时也会 realm 错乱。settings 投影测试用 `DSH_HOST_MODULES` 环境变量指向
宿主树，它会自己临时建链、跑完自己拆。

## 目录速览

| 文件 | 职责 |
| --- | --- |
| `src/protocol.ts` | 网关请求信封与 NDJSON 事件流解析（**最大也最容易出事的一块**） |
| `src/adapter.ts` | `LlmAdapter`：流式传输、账号故障转移、历史自愈、空回合守卫 |
| `src/index.ts` | 插件装配：settings 两代契约、供应商注册、HTTP 路由、额度 HUD 数据 |
| `src/models.ts` | 公开目录扫描 + Go 档位两层判定 |
| `src/pool.ts` | 多账号池（round-robin / 冷却 / 收编） |
| `src/usage.ts` / `meter.ts` / `request-stats.ts` | 额度、调用计量、缓存台账（纯只读聚合） |
| `src/oauth.ts` | `cmd login` 的 OAuth 提取（本机回调服务器） |
| `lib/client.js` | 手写 `__ModuleLoader__` bundle（浏览器端 HUD），**不经 tsc**，改它要同步 `scripts/smoke-client.mjs` |

## 硬性约束（违反 = 出过真 issue）

1. **工具调用/结果必须严格双射**（#5）：assistant 里每个 `tool-call` 恰好一条同 id
   结果，反之亦然。历史压缩/工具中断会制造孤儿，序列化前必须丢（`ToolPairing`）。
   网关对坏形状是硬错误，且坏形状会**每轮重发**，会话永久卡死。
2. **DSH 0.2.x 的历史带独立 `role: 'tool'` 消息**（#10）：配对前先归一化成内部
   user + tool-result 表示，否则结果被降级成 user 文本、有效调用被当孤儿删掉，
   模型看到坏历史就提前收尾。旧版嵌套 `tool-result` 块也要继续兼容。
3. **半截回答绝不重放**：流一旦产出 chunk，错误只能如实上抛，不能换账号重试
   （`stream()` 里 `yielded` 守卫）。自愈重试用**同一个账号**（不烧别的号），
   真正的账号故障转移才换号。
4. **只修「这一轮真的发出去的调用」**（#5）：网关点名的 id 不在请求里时不要自愈
   重发，纯烧额度。
5. **reasoning 不算「可见输出」**（#9）：只有 reasoning、没有正文也没有工具调用的
   回合要抛 `EMPTY_RESPONSE`（宿主默认可重试码里有它）。但**已经流出的 reasoning
   保留**（真实内容不回收），**用量照常上报**（那一轮网关确实计费了）。
6. **错误分类决定是否烧额度**（#5/#6）：`INVALID_REQUEST` / `PERMISSION` /
   `CONTEXT_WINDOW_EXCEEDED` 绝不能进 `FAILOVER_CODES`——必然失败的请求换号重试
   只会白烧别的账号。网关的 error 事件是流的真实终止原因，别把它盖成
   "stream ended without finish-step"。
7. **`x-session-id` 必须是官方 `sess_<16 hex>` 形状且按会话稳定**（#6）：同一对话
   复用同一 id（缓存亲和），不同对话互不串味。请求指纹（UA / x-command-code-version
   / x-cli-environment / x-taste-learning / x-project-slug）对齐官方 CLI v1.31.0，
   改任何一个都可能被网关识别。
8. **HTTP 路由必须带浏览器信任闸门**：`/api/cmdgo/*` 优先复用 `connection` 服务的
   `requestRejection`，缺席时用 `browserTrustRejection()` 兜底；POST 只收 JSON
   Content-Type。这套路由此前无鉴权，恶意页面能跨站触发扣额度的操作。
9. **effect 挂在注入回调的作用域 ctx 上**（0.1.2 教训）：挂外层 ctx 时 entry 移除
   不触发 disposer，路由会变成清不掉的孤儿。

## 版本兼容（最容易踩的坑）

本插件的 dev type-peer 是**旧版** `dsh-llm`（见 `node_modules/` 链接），而线上宿主
可能是 0.1.5 ~ 0.2.x 任何一代。**类型按旧 peer 解析 ≠ 运行时只跑旧宿主**：

- **settings 两代契约**（#8）：0.1.5/0.1.6 有 `settings.installSection`，
  0.1.7+ 删掉了它、改成 `configure({ auto: false })` + schema 上的 volatile 投影，
  命名空间键从插件自报的 `NS` 变成 **loader entry id**（`ctx.fiber.entry?.options.id`）。
  运行时按方法存在性分派，两个方法都写成可选。**installSection 的 throw 会被
  cordis 的 inject 回调静默吞掉**——设置页整块消失、stderr 无输出，用户不可能自己
  定位，所以任何「拿不到就跳过」的分支都要留下 error/warn 日志。
- **volatile 需要 `@deepseek-ai/schemastery` 3.18.3+**：3.18.2 及更早没有运行时。
  按能力探测（`typeof schema.volatile === 'function'`），别按 peer 最低版假设。
  volatile 字段解析出来是 `{ get() }` 持有器，用
  `Symbol.for('cosmokit.volatile.write')` 判定（跨 realm/ESM-CJS 共享），**不要
  静态 import cosmokit**（可选 peer 缺席时不该让插件链接失败）。
- **`loader/volatile-update` 事件**：0.1.7 的 volatile 快照是原地更新的稳定引用，
  按 config 对象身份做键的缓存永远不会自己失效。监听这个事件才能让「设置页改了
  值要生效」成立。事件名按字符串写（旧宿主的类型表里没有它）。
- **peer 范围**：`>=0.1.0-rc.6 <0.2.0 || ^0.2.0-rc.1`。两个 semver 坑记牢：
  预发布版本**小于**同号稳定版（`>=0.1.7` 会拒掉 `0.1.7-rc.2`，下限要写
  `>=0.1.7-rc.1`）；上限 `<0.2.0` 会在 0.2.0 稳定版发布时**拒装**（rc 时代反而能装，
  定时炸弹）。`dsh-app-boot` 只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  两类 peer，判定带 `includePrerelease: true`。
- **类型收窄时的版本边界**：`options.messages` 在旧 peer 下没有 `role: 'tool'`，
  直接 `message.role === 'tool'` 会被 tsc 判成不可达（TS2367）。在跨版本的那一处
  显式 cast（叠加可选字段），并让归一化的输入输出都用放宽的本地视图。

## 门禁与验证习惯

- 改 `src/protocol.ts` / `src/adapter.ts`：必跑 `smoke-protocol`、`smoke-repair`、
  `smoke-empty-turn`；动到请求形状时用**假的 fetch**（参照 `smoke-repair.mjs` 的
  `ndjson()` + `queue` 模式）断言网关实际收到的 body，而不是断言自己刚写的代码。
- 改 settings / 装配：`smoke-settings`（六种宿主装配的桩）+
  `smoke-settings-projection`（真实 `dsh-settings.describe()`，需
  `DSH_HOST_MODULES`，缺席自动跳过）。
- 改 `lib/client.js`（HUD）：`smoke-client`（React/DOM 桩）。它是手写 bundle，
  tsc 管不到，别指望编译器帮你。
- **发布前**：`bun run build && bun run typecheck && bun run smoke` 三条全绿再动
  版本号。版本号只改 `package.json`（发版由维护者 pack/publish）。
- 修 issue 时在 commit message 里带上 issue 号与机制（现有 git log 是范例风格），
  README 的「排错」节同步补条目——用户是照那个清单自救的。

## 已知环境噪音（不是你的 bug）

- `tsconfig.json` 的 `paths` 指向 `node_modules/@deepseek-ai/*`，链接缺失时
  `bun run` 会报 `Cannot find module`——先修 `DSH_CHECKOUT` 再跑。
- `smoke-settings-projection.mjs` 没给 `DSH_HOST_MODULES` 时打印「跳过」并 exit 0，
  这是设计行为（可选依赖），不是测试挂了。
