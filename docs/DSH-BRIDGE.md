# 本地 DSH 桥接器

桥接器是独立的 DSH 官方插件格式包，网站使用现有 Workers、D1 和 R2。无需修改 DSH 本体、开放本机端口或另行配置模型密钥。

## 用户操作

1. 在 DSH 插件管理器安装 `https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.0.tgz`，启用补位桥接器。
2. 在插件内连接网站，登录并确认设备及授权项目，然后返回 DSH 为项目选择一次本地目录。
3. 正确配置后保持 DSH 打开，启动及网络恢复时会自动连接，无需在任务页面连接。任务保存后网站自动检查 AI 适用性，在网站任务的“AI 辅助 → 代实施”中主动点击执行；不适合、判断失效或失败时禁止投递。成果自动回传为草稿，用户核对后点击“采纳并提交验收”。DSH 的原生权限审批仍需按其配置确认。

网站“设置 → 本地 Agent”可以查看安装方法、连接及目录绑定状态、管理项目授权、设定当前账号的项目默认设备和撤销连接。修改本地目录需在 DSH 桥接器设置中重新打开原生目录选择器。自动连接不会自行派发任务，多个设备未设默认时在“代实施”中选择。取消项目授权会阻止排队交接并要求活动交接停止；回传和读取接口立即重新检查授权。关闭 DSH 时任务等待设备上线；目录只在本机保存，网站只接收显示名称。

## 执行与恢复

设备主动 HTTPS 轮询，默认 5 秒，故障退避至 60 秒。每台设备串行执行，服务端还限制一个任务只能有一个活动执行。固定上下文快照包含任务、目标、当前标准、前置任务的固定成果版本、资料正文和原始附件。原始附件流式下载并核对声明大小与 SHA256。

插件在投递前持久化执行日志，使用固定会话及请求 ID。受理状态无法确认时停止并显示执行状态不确定，不自动重放。取消与撤销必须等本地执行实际停止后才能释放活动执行位置。重启不能自动恢复或重投未结束的旧会话。

只上传执行目录 `outputs` 内显式登记的成果，拒绝越界、链接、密钥文件和不允许的扩展名。v1 回传最多 20 个成果，每个 50 MiB；这个限制不影响项目原始附件的流式下载或既有通用上传。成果不自动触发解析、音频或索引任务。采纳时重新核对任务和上下文版本，变化后保留草稿但禁用直接采纳。重复采纳返回同一份提交。

## 验证与兼容

2026-10-04 核对官方源码 HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，公开 API 比较版本为 `0.2.1-alpha.1`。实际启动验证使用安装的 Desktop `0.2.0-rc.2`。缺少必要公开服务时插件拒绝连接。DSH 尚处开发预览，升级应重新进行宿主验收。

```powershell
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend
npm run build
npm test --prefix packages/dsh-team-office-bridge
npm run smoke:host --prefix packages/dsh-team-office-bridge
```

`scripts/verify-dsh-bridge-local.mjs` 使用独立本地 Wrangler D1/R2 状态和真实插件 runner，DSH adapter 与适用性判定为显式 fixture。`smoke:host` 使用真实 RC2 会话、内置 DeepSeek provider 连接本地 SSE fixture，验证 prompt、专属成果工具、正常结束和草稿状态，不调用付费模型。原生目录选择点击、真实模型的任务完成质量和最新版源码的完整运行兼容性需另外验收。

协议、授权与迁移说明见 `backend/docs/AGENT-BRIDGES.md`；插件源码、安装方法与宿主测试位于 `packages/dsh-team-office-bridge`。迁移 `0053_agent_bridges.sql` 只增加桥接表与索引。部署先记录 D1 Time Travel 恢复点，再仅应用未执行的新增迁移，依次发布后端与含固定版本插件包的前端。
