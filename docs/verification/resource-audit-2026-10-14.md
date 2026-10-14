# 安全、资源额度与首用整改验收

基线：`c4021d9865cbdee451c7245a8e3e3b05085f8270`。保留生产资源 ID、现有模型配置、数据及邀请码注册。邮件恢复是主入口，管理员人工恢复为后备。发布 SHA、CI 和部署收据见独立 release receipt。

## F01–F12 对照

| 发现 | 实施及主要文件 | 回归证据 |
|---|---|---|
| F01 上传者授权 | files、file-multipart、agent-bridges、bridge-authority：读取正文之前、发布和隔离均核查真实操作者、成员和原上传者；管理员没有代上传特权 | 175-upload-boundaries、131-agent-bridges：跨项目 ID 替换、同项目他人上传、管理员、Bridge 撤销及迟到结果 |
| F02 对象竞争 | 独立 UUID key，CAS 只公布赢家；输了不覆盖/删除赢家；未知结果保留预占 | 同上，加 149-file-concurrency、151-managed-storage：有效/隔离交错、分片/快捷交错、旧对象保护、迟到 RPC 与回收权竞争 |
| F03 AI 硬闸 | ai-resource-quota/gateway/probe/Whisper/media/Gemini Live；UTC+8 日限300/1000/5000，并发10；实际重试逐次计数；unknown保留槽位；运维令牌诊断共享受限actor | 164-ai-resource-quota及供应商/voice集成：争抢、撤权、继续窗口、重复派发、kill switch、未知语音期限和诊断拒绝不覆盖已有成功 |
| F04 存储和50MiB | managed-storage；全部 fetch/queue/cron/Workflow 包装受控R2；十进制250MB/1GB/9GB（仅当前应用桶），上传池≤80%且≤7.2GB；24h过期、租约保护、有界回收 | 151、152、175-upload-boundaries、176；全部分片长度先预占；删除/abort确认后释放；故障保留额度 |
| F05 安全回跳 | auth-continuation、LoginPage、AcceptInvitationPage；保留站内深链及参数；项目邀请预览后确认；注册邀请码独立 | auth-continuation、LoginPage.recovery、AcceptInvitationPage；本地真实Worker浏览器验证登录→原邀请预览→键盘确认→项目 |
| F06 校园出口 | accounts：验证前120/IP/10min；Turnstile后注册120/IP/h、登录600/IP/h；账号10/15min；无验证保留严格限制及实际等待 | auth校园出口回归和模拟Turnstile；未执行真实校园出口压测 |
| F07 在线撤权 | project级持久化epoch、子请求错误联网核对根权限、隔离快照、blocked队列、账号分区；草稿保留可导出/明确删除 | offline/store/client/ProjectShell回归；本地实际缓存后撤权并刷新：显示权限变更、旧项目内容消失；换号/迟到响应由IndexedDB回归覆盖 |
| F08 未知结果/恢复 | 短控制30s期限及取消；认证核对会话、注册原用户名核对；草稿稳定意图键；已验证邮箱恢复和管理员后备 | client.deadline、LoginPage.recovery、creation-drafts、126/130 recovery、RecoveryEmail/PasswordReset；模拟供应商而非真实邮件 |
| F09 查询及回收 | projects列表JOIN一次返回权限/修订；无跨请求权限缓存；分钟恢复前后各最多25并稳定游标 | 175-project-list-permissions/175-maintenance-pagination；1/20/100项目五轮，详见benchmark JSON |
| F10 静态直出 | 仅/assets哈希资源绕过Worker；HTML/API/SPA/PWA根脚本仍走Worker；nonce/no-store/安全头保留 | verify-static-routing.mjs用实际本地Wrangler脚本计数和HTTP响应核对；仅上游API替换为本地fixture |
| F11 环境隔离 | 默认前后端改开发名称，生产名称/ID/绑定原样保留；preflight校验SHA、D1、R2、Service Binding、Origin | 工程6测试；生产dry-run；不完整staging明确阻断 |
| F12 完整发布 | 双端整合验证、生成契约一致性、构建、dry-run、main整合、同SHA CI；备份/恢复点、盘点先于增长启用 | 最终收据记载，未通过阶段不标完成 |

## 使用边界

次数限制不承诺金额封顶。R2按账户GB-month与操作量计费；外部应用仍可独立增长。后续按用户要求，仅统计当前应用桶，不扣除其他桶占用；Worker令牌自动核查及外部用量24小时失效规则已移除。库存未初始化仍拒绝增长，已完成库存由对象与预占账本实时维护。

邮件复用现有Resend设置：绑定须当前密码，确认邮件15分钟；密码恢复30分钟、哈希存储、原子一次消费、撤销目标账号旧会话。邮箱版本与密码指纹变化使旧代码失效；匿名申请统一受理，不等待后台查询/供应商；平台邮件≤30/日、同收件人≤5/日，60秒冷却；unknown发送保额度，不自动重发。验证码和恢复链接不进入日志。旧注册邮箱不会自动被视作已验证。

本机成果保留规则及导出入口见产品提示；blocked操作不会自动重放。测试未调用真实付费模型、未实际发送恢复邮件。真实邮件到达/垃圾箱、生产Turnstile交互、真实校园出口、物理移动设备及长时间语音仍需分开验收。

## 运维复现

从仓库根目录执行 `npm run typecheck`、`npm run lint`、`npm run test:backend`、`npm run test:frontend`、`npm run test:engineering`、`npm run check:secrets`、`npm run check:migrations -- <published-base-sha>`。生成契约：`npm run export:openapi --prefix backend` 后 `npm run typegen --prefix frontend`，检查生成文件无diff。

构建和发布前设置 `VITE_BUILD_VERSION` 为实际待发布完整Git SHA；`npm run verify:reproducible-build`、`npm run preflight:deploy -- production`，双端 `wrangler deploy --env production --dry-run`。真实部署加 `--keep-vars`，逐一核对双端版本/构建SHA及D1/R2健康。

先保存D1关键表逻辑备份与Time Travel点，应用0072–0076加法迁移。旧迁移保持原样。先部署未就绪账本保护，确认无正在派发任务，再用 `node scripts/inventory-resource-storage.mjs --production --output <仓库绝对路径>/.local-secrets/<批次>` 做当前应用R2桶元数据盘点，检查全部未完成分片。脚本只准备私有SQL，不自行执行。核对对象数、字节、归属后，用Wrangler D1执行准备的SQL；最后一步才ready=1。有在途/unknown先核对，不盲目释放账本。

回滚应用时保留新增表与全部业务数据。不要部署会绕过硬闸的旧Worker；应先关闭新增派发/增长，再用前向修复。确需D1 Time Travel需单独核对恢复点之后的数据影响，不能把恢复当普通无损回退。

## 浏览器证据

本地合成项目，实际前后端及D1/R2运行；手机390×844、平板768×1024，无横向溢出。登录恢复邀请码并显示预览，Enter确认后进入项目；撤权后刷新停止展示缓存内容。恢复表单有标签及取消等待；密码输入/提交没有由浏览器代理执行。截图见 `docs/audit-evidence/revoked-project-tablet.jpg`。

## 最终本地整合结果

后端完整168文件1559测试；前端完整174文件1075测试；随后仅恢复请求hook清理函数去除lint警告，恢复目标11项再次通过。双端类型检查、frontend lint、工程6测试、76迁移与历史基线一致性、密钥扫描通过。后端负向Workflow/流中断测试仍有workerd RPC/connection teardown诊断，进程退出0且全部测试通过；没有屏蔽这些诊断。

邮件主入口窄屏浏览器：/help显示邮件恢复主按钮和管理员后备，/password-forgot有明确标签和中断不重发说明；本地不存在账号使用Enter申请后统一受理，无实际邮件。绑定/兑换的密码步骤采用自动化后端/组件测试，浏览器代理没有设置密码。

最终线上收尾补充：资源用量接口的匿名/参数错误也明确禁止HTTP缓存（25项目标回归）；人工盘点覆盖default/eu/us全部管辖区及有界分页，权限/分页/未完成指标不完整均不准备启用SQL（7项模拟API回归，含EU独有的空分片）。盘点与草稿提交交错会使旧快照覆盖新归属的问题已先复现再修复：既有账本归属不会由迟到盘点降为未知，项目占额保留（152库存回归）。最终提交和部署证据以release receipt为准。

## 9 GB 与人工盘点调整

按用户后续要求，0077 加法迁移把平台总上限收紧为十进制 9 GB，上传池最高 7.2 GB；已超额的对象保留，只阻止新增增长。删除 Worker 的自动用量查询服务、令牌字段、定时调用和 external-usage 接口，并重新生成契约。仅计算当前应用桶的对象与预占，不查询或扣除其他桶；取消外部核查过期阻断，保留库存未初始化的拒绝增长保护。针对性后端 20 项、前端 7 项回归，类型、lint、13 项工程检查和历史迁移一致性通过；最终完整 CI 与生产证据见新的发布回执。
