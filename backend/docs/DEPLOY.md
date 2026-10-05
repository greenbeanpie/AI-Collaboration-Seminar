# 部署说明（DEPLOY.md）

> 负责人在本地执行以下步骤创建 Cloudflare 免费资源并部署。按实际资源与供应商计费，AI 调用及超出免费额度的资源会产生费用。

## 0. 前置

```bash
cd backend
npm install
npx wrangler login        # 浏览器授权
```

## 1. 创建资源（以 staging 为例，production 同理替换后缀）

```bash
# D1 数据库
npx wrangler d1 create ai-office-db-staging
# R2 存储桶
npx wrangler r2 bucket create ai-office-files-staging
```

**AI Gateway**：Cloudflare Dashboard → AI & AI Gateway → Create Gateway，名称建议 `ai-office-staging`，记下 **Gateway ID**。

**API Token**：Dashboard → My Profile → API Tokens → Create Token，权限勾选：
- `Workers AI` → Edit（经 Gateway 调 Workers AI 模型）
- `AI Gateway` → Edit

记下 Token（只显示一次）。Account ID 在 Dashboard 首页右侧可见。

## 2. 填写 wrangler.jsonc

在 `env.staging`（及 production）中替换：

| 字段 | 填入 |
|---|---|
| `d1_databases[0].database_id` | `wrangler d1 create` 输出的 database_id |
| `vars.CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID |
| `vars.AI_GATEWAY_ID` | Gateway ID |
| `vars.ALLOWED_ORIGINS` | 前端部署域名（逗号分隔，如 `https://ai-office.pages.dev`） |

## 3. 配置 Secrets（每个环境分别执行）

```bash
npx wrangler secret put AUTH_SECRET --env staging       # 随机长字符串：openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN --env staging       # 运维管理员令牌
npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging
npx wrangler secret put RESEND_API_KEY --env staging    # 必须配置并验证发信域名
# 在 env.staging.vars / env.production.vars 中设置 EMAIL_FROM
```

## 4. 应用迁移并部署

```bash
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler deploy --env staging
```

## 5. 验证部署

```bash
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/health
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/health/deps   # d1/r2 应均为 ok
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/capabilities
```

## 6. 启用 AI（模型能力验证后）

模型默认 `enabled=0`（种子配置）。启用流程（PLAN 要求：未通过能力验证的模型不启用）：

```bash
# 1) 探测（中文/JSON/图片/用量字段四项检查，会发起真实模型请求）
curl -X POST https://.../api/v1/admin/ai-config/probe \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"purpose": "textEconomy"}'
# purpose 可选 textEconomy / visionEconomy / review，三类均应探测通过

# 2) 若 passed=true，写入 enabled=true 的新版本（配置只增不改）
curl -X PUT https://.../api/v1/admin/ai-config \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{ ...与 GET 返回的 config 相同..., "enabled": true, "notes": "探测通过 2026-10-xx" }'
```

正式模型（GLM 等）Key 到位后：修改配置中对应用途的 `provider/model`，重复探测 → 启用。

## 7. 前端接入

生产前端沿用 `greenbp-team-office`（预期域名 `team.greenbp.dpdns.org`）；前端 Worker 通过 **Service Binding** 绑定本 Worker（staging 服务名 `ai-office-api-staging`，production 服务名 `greenbp-team-office-backend`），`/api/*` 转发由前端 Worker 配置；`ALLOWED_ORIGINS` 需包含前端域名。契约以 `backend/openapi/openapi.json` 为准。

## 8. 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入本地密钥
npx wrangler d1 migrations apply DB --local
npm run dev                      # wrangler dev（D1/R2 本地模拟）
npm test                         # vitest（workerd 内集成测试）
npm run typecheck && npm run export:openapi
```

## 9. 回滚、备份与恢复

### 9.1 代码回滚

- `npx wrangler rollback --env staging`（或重新部署上一 commit）。
- 迁移只增不改；回滚代码不自动回滚数据库结构（backend_plan.md 5.10）。

### 9.2 备份

- 生产环境在**每次迁移前**执行：`npx wrangler d1 export DB --env production --remote --output=backup-YYYY-MM-DD.sql`（文件名日期由执行人填写）
- 本地演练（零云费用，不接触云端）：`npm run backup:drill:local`
  该脚本导出本地 D1 → 校验导出完整性（27 张表建表语句、含 INSERT、结尾完整）→ 把建表语句重排到数据之前 → 导入一个独立的本地演练库 → 查询验证行数，最后清理临时文件。

### 9.3 恢复演练步骤（云端）

1. 新建目标 D1：`npx wrangler d1 create ai-office-db-restore`。
2. 临时把 `env.staging.d1_databases[0].database_id` 指向恢复库（或用独立配置），执行：
   `npx wrangler d1 execute DB --env staging --remote --file=backup-YYYY-MM-DD.sql`
3. 用 `--command` 抽查关键表行数与最近一条材料/账本记录，确认恢复完整。
4. 校验通过后再切换正式绑定；未验证前不要覆盖生产库。
5. 记录演练时间、备份文件、执行人、抽查结果。

**已知导入注意事项**：D1 的导出席按表名交错输出建表与数据，且表间存在循环外键（`materials.current_version_id` ↔ `material_versions.material_id`），`source_versions` 的外键目标 `ai_config_versions` 建表位置靠后。直接导入会报 `no such table` 或 `FOREIGN KEY constraint failed`。正确做法是：**先全部建表、再灌数据，并在事务内使用 `PRAGMA defer_foreign_keys=TRUE;`**（本地脚本已按此实现）。

## 10. 数据保留与清理

保留策略以「可审计数据不自动删除、衍生物按期限回收」为原则。

| 数据 | 保留策略 | 实现 |
|---|---|---|
| 会话 / 验证码挑战 | 到期即删 | `cron.ts`（每分钟） |
| 隔离文件（校验失败暂存） | 按 `files.gc_after`（默认 48 小时）删除 R2 对象并置 `discarded` | `cron.ts` |
| 孤儿 R2 对象 | 只删除**数据库无引用**且上传超过 7 天的受管对象；单轮最多 200 个 | `services/gc.ts`、`LIMITS.orphanObjectGraceDays` |
| 幂等回放记录 | 仅清理 `status='completed'` 且超过 30 天的记录；**`processing` 永不自动删除**（业务可能已成功，需人工核对） | `services/gc.ts`、`LIMITS.idempotencyCompletedRetentionDays` |
| 业务与账本数据（projects / tasks / materials / events / jobs 等） | **不自动删除**，属审计与比赛留痕数据 | 无（需人工决策） |
| 模型调用快照（R2 `ai-calls/…`） | 仅当 `ai_calls` 行不存在时按孤儿回收 | `services/gc.ts` |

受管对象键（其余键一律不处理）：`ai-calls/{callId}/input.json|output.json`、`sources/{sourceVersionId}/…`、`{projectId}/{fileId}{ext}`。

手动预演：`gcOrphanObjects(env, now, { dryRun: true })` 只报告将删除的对象，不落删；回归测试见 `backend/test/25-gc-retention.test.ts`（同时断言有效对象与非受管对象不受影响）。

### 10.1 滞留幂等记录的处理（运维）

幂等键在处理中（`processing`）不会被自动删除：业务可能已经成功，只是响应记录没写进去，自动删除会导致重复副作用。

```bash
# 1) 列出滞留记录（olderThanMinutes=0 表示不过滤时长；默认 10 分钟）
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://.../api/v1/admin/idempotency/stuck?olderThanMinutes=30&limit=50"

# 2) 人工核对业务状态：该次操作是否已产生效果（材料版本、账本事件等）
#    确认「未生效」或「重试本身幂等」后，释放该键
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"idempotencyKey":"<key>","userId":"<uuid>","operation":"agent-run.adopt"}' \
  https://.../api/v1/admin/idempotency/release
```

释放后客户端可用同一幂等键重试；业务侧的自然唯一键（材料 revision、运行状态、任务 outbox）保证不会重复产生正式结果。参考回归测试 `backend/test/27-idempotency-recovery.test.ts`。

## 11. 监控与告警阈值

健康检查（不触发付费调用）：`GET /api/v1/health`、`GET /api/v1/health/deps`（D1 一次查询、R2 一次头校验）。

| 指标 | 建议阈值 | 来源 |
|---|---|---|
| 5xx 错误率 | > 1% 持续 5 分钟告警 | Worker 观测 / 日志 |
| 任务失败率 | > 10% 持续 15 分钟告警 | `jobs` 表按 `status='failed'` 聚合 |
| 任务排队时长 | p95 > 60 秒告警 | `jobs.created_at` → 首次 running |
| 长期非终态任务 | 超过 5 分钟仍 `running` 需核对（cron 每轮处理并记录） | `cron.ts` 日志 `[cron] Workflow 状态核对失败` |
| 派发重试耗尽 | 任一 job `attempts >= 5` 立即关注 | `job_outbox.last_error='dispatch_exhausted'` |
| 项目 AI 并发 | 长期处于并发上限（2）说明排队积压 | `usage_reservations.status='reserved'` |
| 隔离文件 / 孤儿对象 | 单轮 GC 删除量异常升高（远大于日常）需排查 | `cron` 日志 `[cron] 孤儿对象回收` |
| 测试运行时告警 | workerd canceled request / RPC stub | 见架构文档 7.2，属测试池收尾现象，不隐藏日志 |

日志中可检索的关键前缀：`[cron]`（维护与恢复）、`[gc]`（孤儿回收失败）、`[events]`（账本写入失败）、`[email:resend]`（投递失败）。

## 12. 当前发布状态（2026-09-30，19dedbd）

production 的 Worker 名称、Service Binding 和资源字段在仓库中已对齐，`npm run preflight:deploy -- production` 通过。staging 的同命令仍报缺 EMAIL_FROM、D1 ID、Origin。以上均是静态配置验证，不代表远端资源或发信域名已验收；当前 `EMAIL_FROM` 仍使用 `onboarding@resend.dev`，真实邮件投递需单独验证。

正式放量前先修复架构文档 A03/A07/A08 所列代码缺口；随后验收 Secrets、D1 迁移、私有 R2、两端部署与回滚、Service Binding、真实邮件、模型/OCR、云端恢复与监控。模型 URL/key 继续留待用户在网页设置填写；模型 fixture 成功不能替代真模型和云端故障验收。

## 13. 密码身份与一次性注册码

生产设置 `AUTH_MODE=password`。先备份 D1，应用 0012 密码身份迁移，再执行仓库根目录的 `npm run bootstrap:admin:production`，最后部署后端与前端。初始化使用特权 D1 操作，不提供公开创建管理员接口。迁移新增 auth_accounts、account_invitations、auth_password_rate_limits，并将原会话标记 legacy；旧会话不再通过认证。

脚本将管理员绑定到已有目标邮箱的 user ID，保留所有项目外键；遇到邮箱歧义或用户名已被其他身份占用立即停止。设置管理员密码同时撤销其旧会话。随机密码保存在 `.local-secrets/admin-credentials.json`，不可提交、公开或写入日志。重复初始化校验既有密码并复用，无法静默轮换。管理员登录后可生成 16 位单次注册码和管理 AI 设置；ADMIN_TOKEN 仍可作为运维方式，不可发给普通成员。

密码使用 scrypt（N=32768、r=8、p=3，32 MiB 内存工作集）、随机 16 字节盐。注册码只保存 SHA256 哈希，注册与消费原子提交。登录与注册均有持久化限流。邮箱可选且不自动验证或关联旧账号；现无自助密码找回，需要管理员通过可信途径处理旧账号密码配置。

RESEND_API_KEY 和原邮件域名配置保留供未来通知使用，密码认证不依赖邮件、Turnstile 或 AUTH_ALLOWED_EMAILS。不要恢复旧验证码认证路径。AUTH_SECRET 保持原值并继续使用 Worker Secret。私有 D1 备份位于 gitignored 的 `.local-backups/`。

## 14. 未来 VPS 迁移准备（未实际部署服务器）

目标是把前端静态资产和同源 `/api/*` 代理放到 VPS，后端、D1/R2 与现有用户 ID 继续复用，不进行数据库身份体系迁移。

文件：`deploy/vps/Caddyfile`、`deploy/vps/compose.yaml`、`deploy/vps/.env.example`。镜像固定为本轮验证过的官方 Caddy digest。`docker compose config --quiet` 与容器 `caddy validate`（network none）通过；已消除格式和冗余 Host header 告警。此验证不含实际域名 TLS 颁发或上游网络联通。

准备过程：

1. 提供 Linux VPS，开放 80/443 TCP（可选 443 UDP），安装 Docker/Compose；先用测试域名验收。
2. 在本仓库执行 `npm run build`，把 `frontend/dist` 和 `deploy/vps` 按相同目录关系复制到服务器。
3. 复制 `.env.example` 为 `.env`，填写 APP_HOST 与 API_UPSTREAM_HOST；密钥继续留在 Cloudflare，VPS 不保存 Resend 或模型 key。
4. 在 VPS 的 `deploy/vps` 执行 `docker compose config --quiet`，然后 `docker compose up -d`。
5. DNS-only 指向 VPS 并验证 HTTPS，再验收同源 API、Cookie、密码登录与邀请码注册、材料和导出，最后再切换正式域名；不要关闭整个 zone 的安全设置。若正式 hostname 绑定 Worker route/Custom Domain，切换时需按实际绑定解除该 hostname，保留其它资源。
6. 代码或 DNS 回滚使用保留的 Worker 和当前 DNS 记录，不能先删除旧服务。域名变化后需重新登录，项目和材料仍由同一 D1 保存。

**切换前的 IP 限流边界：**目前 Workers 用 `CF-Connecting-IP`；经过 VPS 代理后它会变为 VPS 出口 IP，所有用户共享密码登录与注册的 IP 额度。示例 Caddy 不信任客户端注入的 IP header。正式迁移前需要设计有认证的真实 IP 传递或调整受邀小团队限流策略，不能直接信任任意 `X-Forwarded-For`。这是未完成的迁移条件，不宣称该样例已经完成线上压力验收。

线上密码派生必须实际验收：本地运行时支持 PBKDF2 600000，但生产实测仍有 100000 次上限，因此使用原生 scrypt 的 OWASP 推荐等价参数，不降低 PBKDF2 迭代数。此前已初始化的管理员可用同一凭据文件加 `--upgrade-kdf` 更新存储哈希，原密码不变且会撤销旧会话；不要在无法校验原密码时覆盖账号。
