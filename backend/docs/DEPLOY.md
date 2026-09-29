# 部署说明（DEPLOY.md）

> 负责人在本地执行以下步骤创建 Cloudflare 免费资源并部署。全程使用免费套餐（Workers Free / D1 Free / R2 Free / AI Gateway 免费）。

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

在 `environments.staging`（及 production）中替换：

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
# 以下两项等接通后再配：
npx wrangler secret put RESEND_API_KEY --env staging    # 有域名后启用真实发信时
```

## 4. 应用迁移并部署

```bash
npx wrangler d1 migrations apply ai-office-db-staging --remote
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
npm run dev                      # wrangler dev（D1/R2 本地模拟）
npm test                         # vitest（workerd 内集成测试）
npm run typecheck && npm run export:openapi
```

## 9. 回滚与恢复

- 代码回滚：`npx wrangler rollback --env staging`（或重新部署上一 commit）。
- 数据库备份：`npx wrangler d1 export ai-office-db-staging --remote --output=backup-$(date +%F).sql`（生产环境在每次迁移前执行）。
- 迁移只增不改；回滚代码不自动回滚数据库结构（backend_plan.md 5.10）。
