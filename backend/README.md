# 「补位」AI 项目办公室 — 后端

Cloudflare Workers 上的模块化单体后端（比赛项目：AI 赋能组队作业辅助系统）。技术栈与实施计划见根目录 [PLAN.md](../PLAN.md) 第二章与 [backend_plan.md](../backend_plan.md)。

- **运行时**：Cloudflare Workers（免费套餐优先）+ D1 + 私有 R2 + Workflows + AI Gateway
- **技术栈**：TypeScript + Hono + @hono/zod-openapi（OpenAPI 3.1）+ Zod + unpdf + Vitest（workerd 集成测试）
- **执行分支**：`backend`（merge 进 main 由组长执行；禁止 force push）

## 文档

| 文档 | 内容 |
|---|---|
| [docs/FRONTEND-INTEGRATION.md](./docs/FRONTEND-INTEGRATION.md) | **前端联调指南**（接入手册、调用约定、端到端流程、未实现接口清单） |
| [docs/DEPLOY.md](./docs/DEPLOY.md) | 部署说明（资源创建清单、Secrets、迁移、AI 启用流程） |
| [docs/SPIKE-unpdf.md](./docs/SPIKE-unpdf.md) | unpdf 免费版 CPU spike 结论 |
| [../backend_plan.md](../backend_plan.md) | 后端实施计划与进度记录 |
| [openapi/openapi.json](./openapi/openapi.json) | API 契约（唯一来源，前端 MSW 依据；由 `npm run export:openapi` 生成） |

## 快速开始

```bash
npm install
cp .dev.vars.example .dev.vars   # 填本地密钥
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

## 当前进度与未完成部分（2026-09-29）

已完成 **M0–M3**（脚手架 / 基础设施 / 身份项目 / 来源解析），45 个测试用例全绿。**未完成**：

- **M4**：任务与评论、材料与版本、三档 AI 补位（代做/带做/只审）与采纳、事件账本、`Idempotency-Key` 幂等、AI 预算预占与并发限制
- **M5**：预审、答辩演练、贡献与来源声明、导出 bundle
- **M6**：长期任务核对等加固、staging/production 部署、与前端真实联调
- 外部依赖：Resend 发信域名、正式模型 API Key（当前验证码为回显模式、AI 为 Workers AI 兜底且默认未启用）

对各里程碑接口细节的影响见 [docs/FRONTEND-INTEGRATION.md](./docs/FRONTEND-INTEGRATION.md) 第 8 节。
