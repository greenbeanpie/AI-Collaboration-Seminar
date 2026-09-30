# 「补位」AI 项目办公室

前端真实应用与 Cloudflare Workers 后端使用同源 `/api/v1` 接口。登录后读取真实项目和材料；原有演示原型保留在登录页的 **游客体验** 入口，演示数据和模拟 AI 只存在于 `/guest/`。API 失败不会退回演示成功。

## 目录

| 路径 | 用途 |
| --- | --- |
| `PLAN.md` | 功能、架构与验收计划 |
| `docs/IMPLEMENTATION-ALIGNMENT.md` | 前后端逐项对齐、验证证据与剩余上线条件 |
| `frontend/` | React / TypeScript 应用、游客原型、PWA 与静态资产 Worker |
| `backend/` | Hono API、D1 迁移、私有 R2、Workflows、Gateway 和集成测试 |
| `backend/openapi/openapi.json` | API 契约 |
| `backend/docs/FRONTEND-INTEGRATION.md` | 请求、任务和页面接入说明 |
| `backend/docs/DEPLOY.md` | 云资源、密钥、迁移和部署步骤 |
| `scripts/verify-integration.mjs` | 经前端代理访问真实本地后端的 HTTP 验证 |

## 本地运行

先安装依赖并初始化本地数据库：

```sh
npm run install:all
cp backend/.dev.vars.example backend/.dev.vars
# 编辑 backend/.dev.vars，将 AUTH_SECRET / ADMIN_TOKEN 换成随机值。
cd backend
npx wrangler d1 migrations apply DB --local
cd ..
```

在两个终端分别启动：

```sh
npm run dev:backend
npm run dev:frontend
```

打开 <http://localhost:5173>。本地使用独立模拟 D1 / R2，但业务请求由真实后端实现处理；邮箱回显模式在页面明确标记为本地开发。云端 staging / production 配置为真实邮件模式。AI 默认禁用，配置 Gateway 并完成模型探测后才启用；未配置时真实入口会显示不可用。

## 验证

```sh
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend
npm run build
npm run verify:worker
npm run verify:integration  # 两个 dev 服务启动后执行，仅允许 loopback + local + echo
```

该 HTTP 验证创建一次性本地账户与项目，覆盖协作、材料保存、冲突、评分确认、文件权限和退出；结束后归档测试项目。它拒绝远端及生产环境，且不发送真实邮件或调用付费模型。

## 部署

前端使用 Workers Static Assets，Worker 将 `/api/*` 通过 `API` Service Binding 原样转发后端。前端构建后使用 `frontend/wrangler.jsonc` 的 staging / production 环境。后端必须配置对应前端域名的 `ALLOWED_ORIGINS`，并填入真实 D1、R2、邮件与 Gateway 设置。

代码接入与本地验证不等于云端上线。实际部署、真实邮件投递、真实模型费用和比赛材料验收状态见对齐报告。
