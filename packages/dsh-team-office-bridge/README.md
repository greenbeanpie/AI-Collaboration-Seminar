# 补位 DSH 桥接器

标准 DSH 外部插件，不改动 DSH 本体、不开放本地端口。DSH 保持运行时，插件每 5 秒从网站主动领取任务；网络故障按 10–60 秒退避。使用 DSH 自己的模型及权限审批。

## 安装与首次连接

1. 在 DSH 的“插件 → 安装插件”输入固定版本发布包 URL，或选择本地 `.tgz`：`https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.1.tgz`。开发验收用 `npm pack` 产出的本地文件。
2. 在下方“已安装”区域启用 `@greenbeanpie/dsh-team-office-bridge`，必要时重启 DSH；点击这个插件条目，直接在其详情页点击“连接网站”（自动打开授权网页；弹窗被拦截时点击“打开网站确认连接”），在已登录网站选择项目并确认。
3. 返回 DSH，为获授权项目点击“选择本地目录”；每个项目只需选择一次。

网站任务保存后自动检查 AI 适用性，通过后在“AI 辅助 → 代实施”中明确派发才排队。DSH 自动接收完整快照、将原始材料流式下载到磁盘（按声明大小和哈希核对，不施加成果的 50 MiB 限制）、执行并上传登记成果。网站保存草稿，用户核对后采纳与提交验收。DSH 原生审批继续由用户确认。

连接密钥仅写入 DSH 官方 credentials record；插件自己的 journal 不包含密钥。目录映射仅保存在 `$DSH_HOME/team-office-bridge/state.json`。DSH 会话工作目录就是用户选择的项目目录，可读取和编辑已有项目；运行输入与输出位于该目录的 `.team-office-bridge/<handoffId>/inputs|outputs`。断开连接先在网站撤销设备，再等待本地任务停止并确认取消，最后删除凭据；网络中断时保留原凭据和日志供重试。执行状态不确定时阻止重新连接或切换端点。断开连接保留输入、成果文件与历史会话。

## 配置入口与升级

0.1.1 使用 DSH 的 `plugins.bundle.config`，以插件包名注册配置页。上方的独立“补位桥接器”入口已移除；连接、刷新、断开以及各项目的目录选择都在下方已安装插件的详情页。已核查 Desktop 0.2.0-rc.2 支持该入口，未修改 DSH 本体。

0.1.0 用户需通过 DSH 的官方插件管理器卸载旧包，再使用 0.1.1 链接安装并启用新包；不要点击插件内“断开连接”。版本升级保留原凭据记录、目录映射和执行日志，安装前请等待当前执行结束。旧固定版本发布包继续保留。

## 稳定性约束

每设备串行执行；固定会话 ID 和 prompt requestId。投递前持久化记录；投递响应丢失时核对持久日志，无法证明受理则停止并显示 `dispatch_uncertain`，不自动重新执行。上传与完成请求可重复，按成果 ID 和哈希去重。只有 DSH 正常 turn end 且调用本会话专属 `team_office_complete` 登记成果后才能回传完成。

回传只允许 outputs 内明确登记的普通文件，拒绝越界、符号链接、密钥文件、超限文件。默认每文件 50 MiB、最多 20 个文件，并执行网站快照声明的扩展名限制；网站另行执行其上传限制。不上传原始会话或工具记录。连接 origin 与密钥一起保存，改变端点必须重新配对。

## 开发验证

在本目录运行 `npm test`、`npm run check`、`npm pack`。Windows 已安装官方 Desktop 时，可运行 `npm run smoke:host`：在隔离 DSH_HOME 中将内置 DeepSeek 适配器连接本地 SSE fixture，验证实际 prompt、scoped completion、正常 turn end 与草稿回传；不调用付费模型、不读取个人密钥。不安装本地依赖、不复制 Cordis；宿主服务均来自 DSH。插件只依赖已有官方 API：`sessionController`、`credentials`、`connection.fetch`、scoped `agent.ctx.tools`、native directory picker。浏览器端按官方 `__ModuleLoader__` 工厂格式提供构建文件，React 使用宿主 module table。

兼容门禁检查这些公开接口；缺少任意必要服务时拒绝连接和接收。参考源码 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` / `0.2.1-alpha.1`；Desktop `0.2.0-rc.2` 须单独真实启动验收。不能将 mock 测试等同于真实模型、原生目录选择或生产完整链路验收。
