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
# 1) 探测（中文/JSON/图片/用量字段四项检查，产生真实调用与费用记录）
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

前端 Worker 通过 **Service Binding** 绑定本 Worker（服务名 `ai-office-api-staging` / `ai-office-api`），`/api/*` 转发由前端 Worker 配置；`ALLOWED_ORIGINS` 需包含前端域名。契约以 `backend/openapi/openapi.json` 为准。

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

- 生产环境在**每次迁移前**执行：`npx wrangler d1 export DB --env staging --remote --output=backup-$(date +%F).sql`
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
| 项目 AI 并发 | 长期处于并发上限（2）说明排队积压 | `usage_reservations` `status IN ('reserved','pending_reconcile')` |
| 项目预算水位 | 已承诺金额 > 预算 80% 告警 | `usage_reservations` + `projects.ai_budget_usd` |
| 待对账费用 | `pending_reconcile` 记录 > 0 需人工核对 | `usage_reservations.status='pending_reconcile'` |
| 隔离文件 / 孤儿对象 | 单轮 GC 删除量异常升高（远大于日常）需排查 | `cron` 日志 `[cron] 孤儿对象回收` |
| 测试运行时告警 | workerd canceled request / RPC stub | 见架构文档 7.2，属测试池收尾现象，不隐藏日志 |

日志中可检索的关键前缀：`[cron]`（维护与恢复）、`[gc]`（孤儿回收失败）、`[events]`（账本写入失败）、`[email:resend]`（投递失败）。
