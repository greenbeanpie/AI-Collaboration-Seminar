# 「补位」AI 项目办公室 — 后端

Cloudflare Workers 上的模块化单体后端（比赛项目：AI 赋能组队作业辅助系统）。技术栈与实施计划见根目录 [PLAN.md](../PLAN.md) 第二章与 [backend_plan.md](../backend_plan.md)。

- **运行时**：Cloudflare Workers（免费套餐优先）+ D1 + 私有 R2 + Workflows + AI Gateway
- **技术栈**：TypeScript + Hono + @hono/zod-openapi（OpenAPI 3.1）+ Zod + unpdf + Vitest（workerd 集成测试）
- **仓库状态**：后端已合并至 `main`；通过独立 worktree 完成前后端接入。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/FRONTEND-INTEGRATION.md](./docs/FRONTEND-INTEGRATION.md) | **前端联调指南**（接入手册、调用约定、端到端流程、未实现接口清单） |
| [docs/DEPLOY.md](./docs/DEPLOY.md) | 部署说明（资源创建清单、Secrets、迁移、AI 启用流程） |
| [docs/SPIKE-unpdf.md](./docs/SPIKE-unpdf.md) | unpdf 免费版 CPU spike 结论 |
| [../backend_plan.md](../backend_plan.md) | 后端实施计划与进度记录 |
| [openapi/openapi.json](./openapi/openapi.json) | API 契约（唯一来源，真实前端接入依据；由 `npm run export:openapi` 生成） |

## 快速开始

```bash
npm ci
cp .dev.vars.example .dev.vars   # 填本地密钥
npx wrangler d1 migrations apply DB --local
npm run dev                      # wrangler dev（D1/R2 本地模拟）→ http://127.0.0.1:8787
npm test                         # 全量测试（workerd 内运行，自动应用迁移）
npm run typecheck                # tsc --noEmit
npm run export:openapi           # 重新生成 openapi.json（路由变更后必须执行）
```

本地健康检查：`curl http://127.0.0.1:8787/api/v1/health`；契约：`curl http://127.0.0.1:8787/api/v1/openapi.json`。

## 目录结构

```
src/
  index.ts        # Worker 入口（fetch + scheduled + Workflow 类导出）
  app.ts          # 应用装配（统一响应/错误处理/Origin 校验/路由注册）
  core/           # 横切：错误目录、requestId、鉴权/成员校验、分页、Origin
  api/            # 按域路由（auth/projects/members/invitations/files/sources/requirements/jobs/admin/...）
  services/       # 业务逻辑（解析流水线、任务派发、验证码、网页抓取）
  ai/             # AI Gateway 客户端、配置版本化、能力探测、调用记录
  email/          # 邮件适配器（回显实现 / Resend 实现）
  workflows/      # Cloudflare Workflows（ParseSourceWorkflow）
migrations/       # D1 SQL 迁移（只增不改）
openapi/          # 生成的契约文件
test/             # Vitest 集成测试（workerd + 本地 D1/R2）
docs/             # 部署/联调/spike 文档
```

## 当前进度与未完成部分（2026-09-30 更新）

已实现 **M0–M5** 的主要业务模块（脚手架 / 基础设施 / 身份项目 / 来源解析 / 任务材料与三档 AI / 预审答辩与活动历史）。本次补齐分工建议与人工应用接口并接入真实前端；最终验证证据见 [实现对齐报告](../docs/IMPLEMENTATION-ALIGNMENT.md)。**未完成**：

- **B5 / M6 剩余项**：金额预算预占与按费用结算尚未实现（`estimated_cost` 仍为 0）；长期非终态任务核对、并发/预算压测、监控指标及云端 Service Binding 联调仍需后续验收。
- **外部依赖**：真实 Cloudflare D1 / R2 / Worker 资源、Resend 发信域名和密钥、Gateway 与正式模型设置。local 使用回显；staging / production 必须使用真实邮件模式。AI 默认禁用，需能力探测后启用。

接口行为与联调注意事项见 [docs/FRONTEND-INTEGRATION.md](./docs/FRONTEND-INTEGRATION.md) 第 8 节。

### 手工账本功能退役

手工决策、贡献及更正、第三方资源声明接口已移除；活动历史事件流与成果导出继续提供。迁移 `0033_remove_manual_ledger.sql` 删除三张专用表，历史事件和 AI 结果的依据引用仍保留。旧决策引用不能作为新 AI 操作依据，返回来源已移除提示；先备份，再发布应用验证，最后执行删表迁移。
