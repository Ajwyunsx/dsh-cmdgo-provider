# dsh-cmdgo-provider

CommandCode **Go 套餐**（$1/mo）供应商插件：把只能用 `cmd` CLI 的 Go 订阅接入 DSH 模型列表，并把 `cmd login` 的 OAuth 登录提取成设置页里的专用登录选项。

## 背景

Command Code 的订阅分两种：

1. **Provider API**：标准 OpenAI Chat 兼容端点，任何 harness 可直连。
2. **Go 套餐**：调 Provider API 返回 `403 upgrade_required`，只能走 CLI 私有网关 `POST /alpha/generate`（自定义信封）。

本插件针对第二种情况。

## 安装

```sh
# npm（推荐）
dsh plugin add dsh-cmdgo-provider

# 或从 GitHub 安装
dsh plugin add github:Ajwyunsx/dsh-cmdgo-provider
```

安装写入 profile 的依赖与 bundles 列表，**重启 harness 后由 bundles 正常装配**。装完：

1. 「Models」页选择 **Command Code Go** 供应商及模型；
2. 「设置 → CommandCode Go」生成登录地址，浏览器授权后回调自动写入凭据。

## 功能

- **供应商注册**：启动后自动从 `/provider/v1/models` 拉取模型目录并按 Go 套餐规则筛选（开源模型 + 少量 premium 例外），定时刷新；reasoning effort 从官方 CLI catalog 合并。装完即可在 Web「Models」页选择 **Command Code Go** 供应商。
- **OAuth 登录**：设置页新增「CommandCode Go」分区：
  1. 第一个选项是**登录地址**——点击「生成登录地址」，host 在 `127.0.0.1:5959..5968` 起本机回调服务器，拼出 `https://commandcode.ai/studio/auth/cli?callback=…&state=…`；
  2. 「打开登录页」→ 浏览器完成授权；
  3. Studio 页面 POST `{apiKey, state, userId, userName, keyName}` 回本机 `/callback`，state 校验通过后 API Key 自动写入凭据存储（默认 `COMMANDCODE_API_KEY`），面板显示等待回调 → 已登录。
- **HTTP API**：`GET /api/cmdgo/status`、`POST /api/cmdgo/login|cancel|logout`、`POST /api/cmdgo/account/toggle|remove`、`POST /api/cmdgo/usage/refresh`。

## 多账号池（0.2.0+）

反代支持池化多个 Command Code 账号，摊薄单账号额度：

- **入池**：设置页每完成一次 OAuth 登录，新 key 自动成为池中一个独立账号（凭据存储按账号分 ref，清单在 `~/.dsh/cmdgo-accounts.json`）；重复登录同一 key 只刷新标签。升级无缝：既有单 key 自动收编为 `default` 账号。
- **调度**：请求级 round-robin；某账号失败（401/403/429/5xx/传输错误）按指数冷却（30s 起，封顶 15min）并当次请求内自动切换下一账号（首字节前才允许换号，绝不重放半截回答）。网关接受即清除该账号失败计数。
- **管理**：状态接口新增 `accounts` / `activeAccounts`；`POST /api/cmdgo/account/toggle|remove` 启停与移除单个账号，`/logout` 改为清空整个账号池。

## 账号额度显示（0.5.0+）

设置页每个账号下方展示该账号的实时额度，数据与官方 CLI 的 `/usage` 同源：

| 行 | 含义 | 展示 |
| --- | --- | --- |
| `5H` | 5 小时滚动窗口 | 已用 / 上限、占用百分比、重置倒计时 |
| `周` | 每周滚动窗口 | 同上 |
| `月` | 月度额度 | 已用 / 套餐总额、账单日重置时间 |

- 接口：`GET /alpha/billing/credits`（月度池 + 两个窗口 `{used, cap, exceeded, resetAt}`）、
  `GET /alpha/billing/subscriptions`（套餐 id / 状态 / 账单周期）、`GET /alpha/whoami`（展示名）。
- 套餐额度（月度总额）接口不返回，由 `planId` 或「5 小时 / 周上限」组合反查官方套餐表
  （Go $10、GOAT $70、Pro $80、Max 10× $150、Max 20× $300、Team Pro $40）。
- 顶部为套餐徽标与快照时间；占用 ≥70% 变黄、≥90% 变红；有按量购买的额外额度时单列一行
  （额外额度不受滚动窗口限制）。读取失败时保留上一次数据并标注「上次刷新失败」。
- **缓存**：按账号缓存 60s，`/status` 只读缓存并在后台补刷新，2.5s 的前端轮询不会打到网关；
  「刷新额度」/「刷新全部额度」按钮走 `POST /api/cmdgo/usage/refresh` 立即拉取。
- 池为空但主 ref 有 key 时，也展示一行只读的额度（无启停/移除按钮）。

## 多模态 / 图像输入（0.6.0+）

支持视觉的模型现在会被正确标记，图片可以真正送达模型。

**为什么之前不行**：适配器把每个模型的 `inputModalities` 硬编码成 `['text']`。
harness 见到「声明了模态且不含 image」就会把图片换成占位文字
（`projectImagesForTextModel`），所以图片根本没到网关。

**模态从哪来**：`/provider/v1/models` 不返回模态，而 models.md 的 “Best for” 文案
**不能**当判据——交叉核对 70 行里有 39 行不一致（Claude / GPT / Qwen 明明支持图像却只字未提）。
唯一权威来源是官方 CLI 自带模型注册表的 `inputModalities` 字段（CLI 自己就是靠它决定要不要剥图）：

- **离线快照**：`KNOWN_MODALITIES`（74 条，生成自 `command-code@1.53.0`），零网络开销即可覆盖当前目录。
- **实时补齐**：只有当目录里出现快照没见过的模型时才去拉 CLI bundle（约 2.5 MB）解析，
  且最多 6 小时一次、失败同样退避；目录命中快照时完全不发请求。
- 都查不到时按纯文本处理——宁可让 harness 换成占位文字，也不误报能力。

**传输**：图片按官方 CLI 的网关形态发送——`{type:'image', image:'data:<mime>;base64,…'}`
（不是 Anthropic 的 `source` 包装；网关会把它归一化成 `{type:'file', mediaType, data}`）。
harness 的图像块是附件引用，因此经 `attachments.readImageRequest(ref, {maxPixels: 640000, maxBytes: 1 MiB})`
取请求版本再编码；附件服务缺席或读取失败时降级为显式占位文字，**绝不静默丢图**。
工具结果里内嵌的图片按 harness 自己的递归口径取出，跟在 tool 消息后以单独一条 user 消息发送。

**实测**：`moonshotai/Kimi-K2.5`、`Qwen/Qwen3.8-Flash` 对 6 种纯色图 6/6 正确识别。
当前 43 个 Go 模型里 23 个支持图像。

> 注意：`deepseek/deepseek-v4.1-flash` 在注册表里标记为支持图像，但实测对纯色图识别错误
> （5/5 失败），疑似网关侧路由到了纯文本部署。插件按注册表声明能力，不单独改写。

## 接口访问控制（0.6.2+）

`/api/cmdgo/*` 此前**既无鉴权、也不校验 Origin/Content-Type**，而 harness 自身的
`/api/*` 两者都有（无凭据 401、跨站 403）。差集就是一个可利用的 CSRF 面。

**攻击路径**：`text/plain` 属 CORS 安全列表类型，跨站 POST **不触发预检**，所以你在
DSH 运行期间打开一个恶意页面，它就能静默调用：

- `POST /api/cmdgo/usage/refresh` —— 消耗你的额度与 API key
- `POST /api/cmdgo/account/remove` —— 删掉账号池里的账号及其密钥

**修复**：路由入口先过闸门，再谈业务。

1. **复用 harness 自己的判据**：`ctx.get('connection')?.requestRejection(req)`。
   这正是 harness 保护 `/api/*` 的那套（Host/Origin 围墙 + 浏览器会话鉴权），
   因此 `0.0.0.0` 部署与 LAN 访问（`trustedHosts`）下的行为与原生 API 完全一致，
   也不会随 harness 升级而漂移。
2. **`connection` 缺席时**（无浏览器的 composition）退化为本机最小围墙：Host 必须是
   回环地址、`sec-fetch-site: cross-site` 一律拒绝、带 Origin 时必须与 Host 同源。
3. **`Content-Type` 兜底**：POST 只接受 `application/json`，把"简单请求"这条绕过
   预检的路径也堵上。
4. 被拒的请求会记一条 `[cmdgo] 已拒绝 …` 日志，便于排查。

对正常使用无影响：设置页由 `dsh web` 打开的页面发出，携带会话 cookie 且为同源
`application/json`，因此照常通过。

## 协议实现

请求信封与流式解析对齐官方 CLI（`x-command-code-version`、NDJSON 事件流 text-delta / reasoning-delta / tool-call / finish-step）。请求指纹完整复刻官方 `cmd` CLI（v1.31.0 实测还原）：`User-Agent: commandcode/<version>` + `x-command-code-version` / `x-cli-environment: production` / `x-taste-learning` / `x-session-id` / `x-project-slug`，反代流量与 CLI 本体在网关上不可区分，参考了 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)、[synthetic-coworkers/cmdcode2api](https://github.com/synthetic-coworkers/cmdcode2api) 与 [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider)。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | 凭据引用（登录成功后自动写入） |
| `baseURL` | `https://api.commandcode.ai` | 网关 base URL |
| `maxTokens` | `64000` | 单次输出上限 |
| `defaultContextWindow` | `1000000` | 模型无精确上下文时的兜底 |

## 排错

- **重启后模型选择器里没有 Command Code Go，刷新页面就恢复**（#4）：注册竞态。
  `apply()` 注册 adapter 时目录还是空的（首扫是异步的），而客户端的
  `ModelCatalogDirectory` 只在 `llm/adapters-updated` / `settings/document-updated` /
  `credentials/reference-updated` 上失效重载。若页面在首扫完成前加载，它会缓存
  「commandcode 有 0 个模型」的快照，而 host 侧 `buildModelCatalog` 又会把 0 模型的
  供应商分组整个过滤掉——于是该供应商一直不可见，直到手动刷新。

  0.6.4 起 `publish()` 在**客户端可见投影**（id / name / efforts）变化时调用
  `registration.replace([PROVIDER])` 宣告一次（它会发出 `llm/adapters-updated`）。
  目录到货、effort 元数据到货、后续新增模型都会宣告；纯 `inputModalities` 变化
  不在客户端投影里，因此不会造成无谓重载。

  登录后之所以正常，是因为写凭据会触发 `credentials/reference-updated`，把这个
  竞态掩盖掉了。

- **报 `Command Code stream ended without finish-step`**：0.6.3 前这个报错几乎总是
  **掩盖了真正的原因**。网关的终止事件不止 `finish-step`：

  | 事件 | 含义 | 0.6.3 前的行为 |
  | --- | --- | --- |
  | `finish-step` | 正常结束 | 正常返回 |
  | `finish` | 整条流正常结束 | **被忽略 → 误报截断** |
  | `error` | 网关报错（如 `Tool result is missing for tool call …`） | **被忽略 → 误报截断** |
  | `abort` | 网关中止 | **被忽略 → 误报截断** |

  实测复现：assistant 消息带 `tool-call` 却没有对应工具结果时，网关返回
  `{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call call_x."}}`
  且不带 `finish-step` —— 用户看到的却是 "without finish-step"。

  0.6.3 起：`error`/`abort` 会带出**真实原因**，`finish` 也当正常终态；
  另外序列化时会**丢弃没有对应结果的孤儿工具调用**（长会话被压缩、工具执行被
  中断时常见），从源头避免这类请求。真截断仍报 `STREAM_CLOSED`，但会带上收到的
  事件数便于诊断。错误分类为 `INVALID_REQUEST` 的请求**不会**触发账号故障转移，
  避免拿一个必然失败的请求去烧其它账号的额度。

- **装完不显示**：`dsh plugin add` 只写 profile 清单，运行中的 loader 需要重启（或热装配工具）才会加载；另外检查 `~/.dsh/profiles/web/cordis.patch.yml` 是否残留同 id 的 `disabled: true` 条目——卸载器会写它阻断自装配，重装前应删除。
- **模型列表为空（显示 0）**：目录来自 `https://api.commandcode.ai/provider/v1/models`（免鉴权）。
  冷启动时网络可能尚未就绪，因此首扫失败会按 **3s → 10s → 30s → 60s** 快速退避重试，
  不再干等 15 分钟；设置页会同时给出失败原因。注意 dsh 会**过滤掉 0 个模型的供应商分组**，
  所以目录为空时 Command Code Go 会整个从 Models 页消失。
  另外模型列表**不再等** effort 元数据（jsDelivr）或实时模态注册表——上游一慢就更容易看到空列表。
  若长期为 0，点「Models」页刷新，并检查宿主能否访问上述域名。
- **对话报 MISSING_CREDENTIAL**：先到「设置 → CommandCode Go」完成登录，或手动向 `~/.dsh/.credentials.yaml` 写入 `COMMANDCODE_API_KEY: user_xxxx`。
- **回调收不到**：回调服务器绑定在宿主 `127.0.0.1:5959..5968`；若浏览器与宿主不同机，需保证 `localhost:<port>` 能回到宿主（端口转发/SSH 隧道）。

> 非官方插件，仅限个人使用；请遵守 Command Code 服务条款。
