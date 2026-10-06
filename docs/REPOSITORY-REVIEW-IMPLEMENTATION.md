# 仓库审查改进实施与验收

基线：main `81873a4763fde0732256cc9757961dc25c5ed003`。本轮使用独立 worktree 分工实施，保留任务模型、历史迁移、既有权限及不可变版本。没有使用本地浏览器。

## 已实施

- 文件、来源、任务询问、任务文件、提交及任务引用按页批量读取；协作 API 和 AI 合同/证据处理分域抽取。文件列表 1/20 条均为 3 次投影查询；任务 1/100 条的补充读取固定上限 6 次；账号与项目权限检查保留。
- GitHub Actions 验证类型、lint、测试、生成契约、迁移、秘密扫描、可重复构建及部署 dry-run；配置 Dependabot/CodeQL，不自动部署。GitHub 仓库公开，Secret scanning、push protection 及 Dependabot security updates 已在现有仓库设置启用。
- HTML/静态资源使用统一 CSP、逐次 HTML 响应 nonce、nosniff、Referrer/Permissions policy；保留麦克风、PDF Worker、blob 媒体及 Turnstile 必要许可。保留 PWA 原有禁止缓存入口规则。访客示例脚本抽为同源外部文件，避免放宽 script CSP。文件响应带安全 filename、资源隔离及下载/预览策略。
- 普通退出保留本机草稿/快照；清除退出确认待同步数量，原子删除当前账号 IndexedDB 两个存储，并清除账号草稿、工作流跟踪、通知和设备偏好；其他账号保留。存储失败显示错误；离线退出说明服务端会话尚未撤销。
- 新密文按 AI 配置/私有检查点用途使用版本化 HKDF 密钥，媒体授权、限流/邮件配额使用独立用途。可选独立 secrets；当前生产沿用 AUTH_SECRET 派生，兼容所有旧密文、旧限流桶和未过期媒体授权。不能直接更换根密钥而不迁移。
- 密码登录/邀请码注册均接入 Turnstile，检验 hostname、action、有效期与单次使用，保留限流。现有 widget 域名覆盖两条生产 Origin；生产开启由发布步骤最后执行。
- Collaboration 和 Sources 拆分查询、操作及领域视图；任务入口统一。成果检查提供主目标/标准/成果补齐入口、安全项目内返回路径及账号隔离草稿；既有字段键继续自动生成/隐藏。
- 增长列表和选择器使用游标、服务端搜索及加载更多；100 条以上展示列表动态行高窗口化。完整图/统计独立读取，完整成员 ID 和工作量来自服务器；离线乐观项去重。全文片段可分页搜索，直接定位跨页引用；上传重试按已知 fileId 查询。
- 可缓存 GET 使用账号隔离 ETag，授权之后判定 304；服务器增量哈希，前端移除大快照 stringify 比较。旧快照升级，保留现有 no-store。Cron 分为每分钟恢复、10 分钟回填、每小时清理、每日孤儿 GC；后台日期对齐 2026-09-26，测试明确使用对应 workerd。
- 发布构建必须显式 Git SHA，开发为 dev；历史 60 个迁移 SHA 基线不可改写，两个 0025 保留。189 份历史证据已逐项 SHA 验证归档，再删除 106 份冗余二进制，保留报告和精选截图。

## 验证

- 最终全量后端：135 文件，1209 项通过；前端：139 文件，844 项通过。新增流式 ETag 在后续针对性回归中再次验证。
- 前后端类型检查、全量前端 ESLint、4 项工程检查、60 个迁移保护、生成 OpenAPI/类型一致性、Service Binding 命令行验证通过。
- 本机真实 HTTP：104 项检查通过；涵盖账号权限、持久化、版本冲突、文件、权限撤销、完整导出、真实失败与自动重试。验证脚本已更新为“保存即生效”的项目标准契约及实际自动重试状态，不把排队重试当作 AI 成功。
- 复现：先在 backend 应用本地迁移，再运行 `node scripts/bootstrap-password-admin.mjs --local`；配置仅本地 AUTH_SECRET，启动 `wrangler dev --local --port 8799 --test-scheduled`；frontend 以 AI_OFFICE_API_TARGET 指向该端口启动 5199；运行 INTEGRATION_URL=http://127.0.0.1:5199 及 INTEGRATION_CRON_URL=http://127.0.0.1:8799/__scheduled?cron=%2A%20%2A%20%2A%20%2A%20%2A 的 `node scripts/verify-integration.mjs`。整个流程仅 HTTP，不启动浏览器。
- 生产备份：D1 因 FTS5 不能原生整库导出，已记录完整 Time Travel 书签，并导出 114 个业务表；恢复到临时 SQLite 的 integrity_check 为 ok。恢复书签、SQL、哈希及旧部署记录位于 Documents/AI-Colleboration-Seminar-archives/review-release-20261006，仅本机保存。

## 限制与发布记录

没有进行浏览器视觉验收或真人 Turnstile 挑战成功/重放验收。单元测试模拟 siteverify；生产 HTTP 检查仅可确认配置和拒绝无效挑战。

后端测试中仍出现既有负向 Workflow teardown 的 RPC/取消请求警告，未压制；测试全部通过，原说明见 backend/test/setup.ts。GitHub 新扫描发现的 source-map-js、sharp 开发依赖高危项已升级到 1.2.2/0.35.5；全依赖审计后端 0、前端 0 high/critical。前端运行依赖 npm audit 有 3 项 moderate：Mammoth → argparse → sprintf-js；后端运行依赖为 0。官方建议将 Mammoth 降到 0.3.29 是破坏性修改，未执行。默认镜像不提供 audit API，本轮改用 registry.npmjs.org 审计。

实际构建哈希、云端版本、生产 HTTP 结果及 CI 结果写入同目录 release evidence；本文件的本地验证不能替代生产验收。

生产 HTTP 已核对两个域名的应用入口、静态资源 SHA、安全头、Service Binding、验证码能力与拒绝路径。自定义域名的 Cloudflare 注入脚本携带本次 CSP nonce，依据官方说明 https://developers.cloudflare.com/cloudflare-challenges/challenge-types/javascript-detections/ 配置；这仅证明返回 HTML/策略匹配，不代表已做浏览器执行验收。
