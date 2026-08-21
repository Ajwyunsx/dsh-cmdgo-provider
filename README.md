# dsh-cmdgo-provider

CommandCode **Go 套餐**（$1/mo）供应商插件：把只能用 `cmd` CLI 的 Go 订阅接入 DSH 模型列表，并把 `cmd login` 的 OAuth 登录提取成设置页里的专用登录选项。

## 背景

Command Code 的订阅分两种：

1. **Provider API**：标准 OpenAI/Anthropic 兼容端点，任何 harness 可直连。
2. **Go / GOAT / Pro 套餐**：调 Provider API 返回 `403 upgrade_required`，只能走 CLI 私有网关 `POST /alpha/generate`（自定义信封）。

本插件针对第二种情况。

## 安装

```sh
# npm（推荐）
dsh plugin --profile web add dsh-cmdgo-provider

# 或从 GitHub 安装
dsh plugin --profile web add github:Ajwyunsx/dsh-cmdgo-provider
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
- **HTTP API**：`GET /api/cmdgo/status`、`POST /api/cmdgo/login|cancel|logout`。

## 协议实现

请求信封与流式解析对齐官方 CLI（`x-command-code-version`、NDJSON 事件流 text-delta / reasoning-delta / tool-call / finish-step），参考了 [MAXeaglet/commandcode-proxy](https://github.com/MAXeaglet/commandcode-proxy)、[synthetic-coworkers/cmdcode2api](https://github.com/synthetic-coworkers/cmdcode2api) 与 [jiesou/dsh-commandcode-go-provider](https://github.com/jiesou/dsh-commandcode-go-provider)。

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | 凭据引用（登录成功后自动写入） |
| `baseURL` | `https://api.commandcode.ai` | 网关 base URL |
| `maxTokens` | `64000` | 单次输出上限 |
| `defaultContextWindow` | `1000000` | 模型无精确上下文时的兜底 |

## 排错

- **装完不显示**：`dsh plugin add` 只写 profile 清单，运行中的 loader 需要重启（或热装配工具）才会加载；另外检查 `~/.dsh/profiles/web/cordis.patch.yml` 是否残留同 id 的 `disabled: true` 条目——卸载器会写它阻断自装配，重装前应删除。
- **模型列表为空**：目录来自 `https://api.commandcode.ai/provider/v1/models`（免鉴权），检查宿主网络；首次扫描失败会在日志告警并每 15 分钟重试。
- **对话报 MISSING_CREDENTIAL**：先到「设置 → CommandCode Go」完成登录，或手动向 `~/.dsh/.credentials.yaml` 写入 `COMMANDCODE_API_KEY: user_xxxx`。
- **回调收不到**：回调服务器绑定在宿主 `127.0.0.1:5959..5968`；若浏览器与宿主不同机，需保证 `localhost:<port>` 能回到宿主（端口转发/SSH 隧道）。

> 非官方插件，仅限个人使用；请遵守 Command Code 服务条款。
