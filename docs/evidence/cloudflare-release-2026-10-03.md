# Cloudflare 正式发布验收（2026-10-03）

用户授权推送仓库及 CF 部署；本轮不执行离线测试。

## 推送与部署

- 仓库 `greenbeanpie/AI-Colleboration-Seminar`，`main` 已推送实现提交 `92736b5`，随后推送登录账户归属补充修复 `f5bb855`。
- 后端 `greenbp-team-office-backend`：版本 `119fc84e-2c89-433c-a79e-ef3b6f23e14f`，代码标签 `92736b5`。补充修复仅影响前端，后端代码未变化。
- 前端 `greenbp-team-office`：版本 `9c284289-ecfe-4b71-8b44-5c3ae7a0459d`，代码及构建标签 `f5bb855`。
- 正式入口：<https://team.greenbp.dpdns.org>。原 D1、R2、Workflow、Service Binding 和凭据保持原配置。
- 登录补充修复：成功登录或注册时立即更新本机账户归属及会话快照，避免新账户的数据被归入之前账户；相关12项登录/API测试与类型检查通过。

## 数据备份与迁移

迁移前已导出正式 D1：`.local-backups/release-20261003-1858.sql`，2,258,533 bytes，SHA-256 `312e5fa98e1797fbb06fefad162ccbd3c8defe4f63bb39979d0cfbd57b8701f0`。备份含建表与数据，已确认被 Git 忽略，未推送。

实际待执行列表只有以下三项，均已完成，随后确认无待执行迁移：

- `0040_invitation_task_approval.sql`
- `0041_project_feedback_versions.sql`
- `0042_score_correction_permissions.sql`

迁移前后行数一致：用户5、项目8、成员关系12、任务32、材料版本18、来源版本4、文件3、原反馈4、AI配置版本12。`PRAGMA foreign_key_check` 返回空；全部成员已具备评分修正默认字段。部署前无 queued/running/waiting_input AI 作业。

本轮没有执行历史迁移或重新创建资源。迁移前生产记录已经包含 `0033`；本次只应用上述三个新增迁移。

## 线上验证

- 正式健康接口200且环境为production；依赖接口D1/R2均ok；能力接口200；未登录会话接口401。
- 正式HTML引用的JS/CSS文件与本地构建完全一致；主JS文件内容哈希一致：`9c47550ee04f2736c4f9391c94be051bfbc5f20010841d47991acdbc0b5ad5f5`。
- 使用真正的 Google Chrome 可执行程序（非Edge），正常联网进行6项检查：普通账户UI登录、新反馈/历史/邀请申请/评分权限契约、概览布局、持续反馈与标题历史、普通成员邀请控件、390px手机概览。无pageerror。
- `production`静态预检、前端Worker转发检查、前后端类型检查、lint、生产构建通过。此前实现验收的完整测试结果见工作台验收说明。

Chrome验证脚本：`node scripts/verify-workspace-release-production.mjs --production`。它从被忽略的私人文件读取现有登录资料，不打印密码，不提交反馈或方案，不修改AI配置，也不执行模型探测。除登录/退出外的网页写操作被拦截。Service Worker在测试上下文中禁用；没有断网、离线缓存恢复或离线同步测试。

本机JSON及截图位于被忽略的 `output/cf-release-20261003/`。数据库前后计数证据位于被忽略的 `.local-backups/release-20261003-*-counts.json`。

## 未完成的线上验证

现有管理员登录资料被正式服务拒绝（401），未重置真实凭据，因此管理员登录后的线上页面检查没有完成。普通账户检查全部通过。未调用真实模型，也未变更既有AI启用状态或密钥。
