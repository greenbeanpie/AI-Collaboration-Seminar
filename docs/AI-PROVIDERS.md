# AI 供应商、协议与参数

本次改动仅增加接入能力和管理界面。没有变更线上配置、读取已有明文密钥、购买套餐、创建新 Worker 或执行真实付费请求。预设不是模型可用性/套餐资格保证；实际启用仍需要管理员手动保存、分别探测三个用途并通过同一版本的启用门槛。

## 网页配置

入口：超级管理员的「系统设置 → AI 模型接入与测试」。原有运维令牌路径保留；普通管理员和项目成员不能管理系统配置。

- 每个用途独立选择供应商、模型、完整 API URL 和协议
- 协议可手选 `chat-completions`（OpenAI Compatible）、`responses`（OpenAI Responses）、`messages`（Anthropic）和 `gemini`（Google 原生）
- 预设填入官方地址和建议模型，不自动启用或发出网络请求。已知不兼容的协议/模型组合在保存和执行时均明确拒绝
- 未收录的 OpenCode 模型可以显式选择前三种协议，但不宣称已验证，也不发送未经核实的思考参数。原生 Gemini 使用独立预设
- 自定义接口保留完整 URL、模型和原有参数；代理请使用「自定义」。不因字符串中含有某个模型名称而自动推断能力
- 思考强度默认「不发送」，遵循供应商默认值。切换模型会清理不兼容的思考/采样参数；已保存的旧配置不会在读取时被改写
- 最大输出 token 在醒目的「全局输出 token 上限」区域编辑；常用参数包含 temperature、top_p、最大输入字符、超时、JSON 输出约束和图片能力声明。参数范围与供应商/模型/思考模式联动；不支持的值会被拒绝，不能绕过前端校验
- 保存配置默认停用；只有用户明确点击「测试」才会调用真实模型，可能产生费用。所有用途探测通过后才可再次明确启用

### 全局输出 token 上限

这是现有模型配置的 `maxOutputTokens`，单位为 **每次模型请求的输出 token**。统一模式只有一个全局值，适用于所有项目的各用途；高级模式保留文本、图片/OCR、预审/答辩三个独立值。界面显示已保存版本与上限，编辑草稿不会改变已保存值、其他用途的草稿或密钥。保存和启用继续走原有版本冲突检查与能力测试流程，旧任务冻结的配置版本不改写。

当前系统校验范围是整数 1–32768。这不是供应商能力保证，具体模型可能有更低的技术上限；部分模型的思考 token 与正文共同占用输出预算。输入长度仍按字符限制，累计 token 用量不是此参数的含义，也没有新增全局累计 token 额度控制。累计费用预算仍在各项目设置中以美元（USD）管理，原有金额预占、并发和重试保护保持独立。

## 已接入协议与预设

| 供应商 | 传输 | 鉴权/结构化输出 |
| --- | --- | --- |
| OpenAI | Chat Completions 或 Responses，独立手选 | Bearer；Chat `response_format`，Responses `text.format` |
| Anthropic Claude | Messages | `x-api-key` + `anthropic-version: 2023-06-01`；当前使用 JSON 提示及业务 schema 验证，不伪造 OpenAI response_format |
| Google Gemini | `models/{model}:generateContent` | `x-goog-api-key`；`generationConfig.responseMimeType` |
| DeepSeek | Chat Completions | Bearer；JSON 模式可选 |
| OpenRouter | Chat Completions | Bearer；请求 `provider.require_parameters=true`，防止供应商静默忽略指定参数 |
| OpenCode Zen | 根据模型支持 Chat / Responses / Messages | Chat/Responses 为 Bearer，Messages 为 x-api-key |
| OpenCode Go | 根据模型支持 Chat / Responses / Messages | 专用请求头配置及用途确认，详见下节 |
| Workers AI | 保留原 Chat Completions 路径 | 保留 Cloudflare Gateway 头、现有绑定与运维密钥 |
| 自定义 | 默认保留原 Chat；可显式选其他已实现协议 | 按所选协议构造鉴权，不提供任意 header/body 穿透 |

Go 与 Zen 的模型协议不能混用。例如 MiniMax M3 和 Qwen3.8 Max 在 Go 使用 Messages，在 Zen 使用 Chat；Go GPT 6 Luna 使用 Responses，GLM-5.2 使用 Chat。模型 ID/协议表集中在 `shared/ai-providers.ts`，供前后端共同使用。模型列表是截至 2026-10-01 核对的提示列表，不是账户实际拥有的目录。

## 思考参数覆盖

- OpenAI：精确识别 GPT-5/mini/nano、GPT-5.1、GPT-5.2、GPT-5.4、o3/o4-mini 的已核实取值；不把 Codex 或未知后缀盲目归入同一类
- OpenAI Chat 使用 `reasoning_effort` 和 `max_completion_tokens`；Responses 使用 `reasoning.effort` 和 `max_output_tokens`
- GPT-5.1/5.2/5.4 仅在显式 `none` 时开放采样参数；GPT-5 原版和 o 系列不发送这些采样参数
- DeepSeek `deepseek-flash` / `deepseek-v4-pro`：`none/low/high/max`。Chat 的 `none` 映射为 `thinking: {type: "disabled"}`，不发送 `reasoning_effort: "none"`；其余档位发送 `reasoning_effort`。默认不发送时沿用供应商默认开启的 high 思考。非思考模式才允许 temperature；思考模式才允许 `top_p ≥ 0.95`
- DeepSeek 思考 token 和正文共同占用最大输出 token。保持用户配置的预算和超时，不自动增加费用上限；达到 `finish_reason=length` 时明确提示调整预算/强度，不自动再发同预算的付费修复。超时与未收到 HTTP 响应的网络失败分别显示，不把它们误报成密钥或模型不支持
- OpenRouter：只对公开模型元数据明确列出档位的 `openai/gpt-5` 暴露 `minimal/low/medium/high`，映射为嵌套 `reasoning.effort`。o3/o4-mini 元数据未列出档位，保持省略
- Gemini `gemini-3.8-flash`：`low/medium/high` 映射为 `generationConfig.thinkingConfig.thinkingLevel`。2.5 的 numeric thinkingBudget 暂不开放。Gemini 3.x 采样参数依官方建议保持默认（并非 API 不接受这些字段）
- Claude `claude-sonnet-5-5`：`low/medium/high/xhigh/max` 映射 `output_config.effort`；默认 adaptive thinking，不发送猜测的 off/disabled 开关。其他未核实的 Claude/Go/Zen 模型参数保持默认，不猜测可用档位；仍可调整文本长度、输出上限、超时等调用限制

## OpenCode Go 请求头

官方说明 Go 面向编码代理请求。本应用同时包含非编码的项目写作、分工和验收；诚实协议/header 适配不等于套餐适用或官方认证。管理员需核对自己的套餐允许此用途，确认后才可保存 Go 配置。

独立面板仅允许配置：

- `User-Agent`：默认 `AI-Collaboration-Seminar/1.0`，可改为实际应用名称/版本；不允许控制字符或模拟 OpenCode、Codex、Claude 等客户端身份
- `x-opencode-session`：默认自动生成稳定的不透明会话标识；可加最多 32 位非敏感前缀。不能填写密钥或用户资料

稳定性：AI 引导使用原会话 ID；答辩使用答辩 ID；OCR/要求提取使用来源版本 ID；其他任务使用冻结 job ID；一次探测的多个请求共享同一个随机探测会话。所有修复重试保留原 ID，不通过轮换身份、改变认证或自动换供应商处理 401/403。

鉴权由后端从加密密钥构造，面板不接受 Authorization、x-api-key、Cookie、Host 或任意键值请求头。Go Messages 用 x-api-key，Chat/Responses 用 Bearer。专用头不流向其他供应商。没有自定义 session ID 输入框，避免多个用户误用同一个固定会话。

## 密钥、版本与计费边界

- 原有 AES-GCM 密钥加密保留；GET 仅返回 keyConfigured。明文 key 仅存在输入框和保存请求，保存成功即清空，不写浏览器存储
- 更换供应商或自定义 URL 时必须重填/清除密钥，不能自动将旧 key 发到新目标。相同已核实官方预设下的模型/协议路径可复用该供应商密钥
- 预设使用精确官方地址；自定义地址仍要求公开 HTTPS、无用户信息/查询/片段，禁止直接本机/内网主机名与 IP。仅 local 可用回环 HTTP，并同样禁止 URL 凭据/查询
- 禁止重定向；HTTP 错误只显示状态，不暴露供应商原始错误体。网络错误不返回底层 err.message，避免运行时泄露 URL/头
- 该策略是 URL 语法检查，不进行 DNS 固定/重绑定防护。自托管部署必须同时限制网络出口，不能把语法检查当作完整 SSRF 保护
- 新增字段为可选 JSON 属性，不需要数据库迁移。旧 provider 字符串、旧自定义地址和冻结配置仍走原 Chat 行为
- 任务继续冻结配置版本（含协议、思考参数和安全头）。修改任何参数都会使探测证据失效；已排队任务不读取新配置覆盖冻结版本
- 原有两次调用预占、并发限制、费用记录与恢复语义保留。对 401/403 等不可重试服务错误不再发出无意义的付费修复重试；输出 schema 失败/可重试网络错误仍受原两次总数限制
- 自定义/第三方模型和 OCR 仍不允许有限金额预算；不能假设所有兼容接口的 max_tokens 包含思考 token。原子预占与价格未知状态不变
- 原生 OpenAI 输出 token 含思考；Claude 输入总量合并普通/缓存读/缓存写，输出不重复添加 thinking；Gemini 输出合并 candidates+thoughts，输入不重复加缓存。供应商差异化缓存价/附加费用不等于本应用简单单价记录，最终以账单核对
- Responses/Messages/Gemini 返回未完成、拒绝、工具调用或被过滤结果时不会作为完成成果接受。适配器不执行模型工具调用，只归一答案文本和用量

## 验证与未验证

测试全部使用假密钥、本地 D1/R2 和模拟 fetch。`21-provider-adapters.test.ts` 断言实际发出 URL、header、body、OCR 转换、用量归一、拒绝/未完成输出、选项白名单、密钥屏蔽、冻结版本、Go 会话稳定性和两次调用上限。

来源解析（含 OCR）、AI do/guide/review、分工建议、预审、答辩、协作分解/自动分工/成果验收测试均额外使用 Go fixture，断言实际专用 header、JSON 开关和旧成本 guard 行为。原有 Workers/自定义配置另有回归测试。前端测试覆盖手动协议、请求头、保存/读取/密钥清空、能力切换与权限。

`scripts/verify-ai-provider-ui.cjs` 为仅 loopback、全部 API 拦截的浏览器场景。当前云容器 Chromium 在创建本地 socket 时遇到 EPERM（已在允许的提升模式重试，结果一致），因此本次未完成真实浏览器截图/布局验收，不能把 React 测试等同于视觉通过。

真实提供方授权、套餐资格、模型质量/OCR质量、实际费用、线上部署均未验证，也未自动调用。

## 核对来源

- [OpenCode Go 使用与端点](https://opencode.ai/docs/go/)
- [OpenCode Zen 端点](https://opencode.ai/docs/zen/#endpoints)
- [Go Messages 官方路由](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/messages.ts)
- [OpenAI GPT-5 参数](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5)、[GPT-5.1](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.1)、[GPT-5.2](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)、[GPT-5.4](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4)
- [OpenAI Responses 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response.py)
- [Claude 思考强度](https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-sonnet-55)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)、[模型 ID](https://platform.claude.com/docs/en/models/overview)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[用量语义](https://ai.google.dev/api/generate-content#UsageMetadata)
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [OpenRouter 思考参数](https://github.com/OpenRouterTeam/docs/blob/main/guides/best-practices/reasoning-tokens.mdx)、[公开模型元数据](https://openrouter.ai/api/v1/models)
