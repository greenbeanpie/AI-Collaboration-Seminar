# 实现与 PLAN.md 对齐记录

更新：2026-09-30。本次范围由用户明确授权：前后端功能核对与接入，保留游客演示，修复接入缺陷，处理 GitHub 依赖告警。Chrome 异常后，用户要求暂缓所有 Chrome 操作和页面读取；本记录将命令行验证与浏览器待验收分开。

## 接入前的核对

| PLAN.md 目标 | 后端原有实现 | 前端原有实现 | 本次处理方向 |
| --- | --- | --- | --- |
| 邮箱登录、会话、项目、邀请、成员 | Hono / D1 真实接口；local echo；云邮件配置待完成 | 演示身份、本地示例项目 | 正式入口使用真实会话和服务端项目，演示置于游客入口 |
| 来源导入、PDF/OCR、要求与评分确认 | 文件上传、来源版本、解析任务、页面图片、要求与评分 API | 模拟提取和示例要求 | 前端调用真实来源/任务/要求接口，显示禁用/失败/等待输入 |
| 任务、评论、团队分工 | 任务/评论 CRUD 与成员信息已实现；分工建议及应用此前缺失 | 浏览器演示状态 | 绑定真实实体和权限，保存使用服务端 revision |
| 富文本、材料版本、AI 三档、采纳 | Tiptap JSON/Markdown、不可变版本、三档任务、采纳审阅与幂等 | 模拟 AI、本地草稿 | 接入真实任务、保留人工复核与版本冲突内容 |
| 预审、答辩、过程账本和导出 | 输入快照、报告、逐题答辩、事件/贡献/更正/资源与导出 | 模拟评分和模拟反馈 | 展示真实记录；无数据/AI未配置时如实显示 |
| React、TS、路由、Query、编辑器、PDF.js、PWA | 不适用 | 单 HTML 原型；无构建与 PWA | 新增真实应用工程；原型作为独立游客资产保留 |
| 部署与真实联调 | 后端 staging/production 资源占位；文档过期；环境配置字段错误 | 无前端 Worker 工程 | 修复配置，配置 Service Binding，执行本地真实 HTTP 验证和离线构建验证 |

## 接入发现的具体缺陷

具体修复以本次提交和测试为准：

- Wrangler 的环境配置从无效 `environments` 改为 `env`；staging 和 production 使用 Resend 模式，部署迁移绑定与环境明确。
- 列表下一页游标应取当前页最后一条，防止第 `limit + 1` 条被跳过。
- 来源列表补齐游标过滤及同时间戳下的 ID 排序，避免下一页重复读取第一页。
- 来源版本读取、解析、待渲染页码和图片绑定校验项目/来源归属；服务端返回原文件关联，扫描页不再只能依赖导入时的浏览器存储。
- 来源解析和页面图片请求接入服务端幂等回放；图片整批校验后原子写入，失败不遗留部分上传状态。
- 项目截止日期清空和并发版本冲突语义修正。
- 生产或未知环境禁止验证码回显，避免错误配置将 OTP 写入日志。
- 补充项目作用域 AI 会话列表，支持从真实服务恢复历史会话。
- AI 并发预占和超时释放的具体问题修复。
- 任务重试路径补齐会话/项目鉴权，并在重试 AI 任务前预占并发额度。
- 普通任务创建/修改校验负责人和要求的项目归属，显式 null 可清空负责人及日期。
- 要求日期和评分备注的显式 null 清空语义修正。
- 导出汇总补充要求集、引用与评分版本，保留真实确认状态。
- 补齐计划已有但原后端缺失的异步分工建议与单任务人工应用。建议不直接修改正式任务，人工应用按 revision 检查。
- 统一各页面 Query 列表缓存形状，修复跨页读取数组/响应包装不一致；非游标列表遵循自身契约，分页列表完整读取。
- 草稿持久化失败时明确显示仅存页面内存；材料保存/退出不会被浏览器存储异常误报失败。

本次没有额外开展独立漏洞审查；这些修改来源于接入路径、业务状态和现有依赖告警。

## 计划阶段的实际完成范围

| 阶段 | 当前交付范围 | 尚不能认定通过的验收 |
| --- | --- | --- |
| F0 | React / TS / Vite / 路由 / Query 工程，按后端 OpenAPI 生成类型，正式入口与游客资产隔离 | 浏览器视觉验收 |
| F1–F3 | 邮箱、项目与邀请，来源与要求，团队与任务，材料与三档 AI，预审、答辩、账本和导出接入真实 API | Chrome 页面完整操作流程；真实模型输出及比赛原始材料正确性 |
| F4 | PWA 壳缓存、离线及更新提示；账户/项目/材料作用域草稿；409 保留内容并人工比较 | 安装、离线重连、移动端、键盘、打印 PDF 的实际浏览器验收 |
| F5 | 前端本地代理与真实 Workers/D1/R2 的多账户 HTTP 联调；静态资产 Worker Service Binding 转发验证 | Cloudflare 预览部署和云端端到端验收 |
| B0–B2 | 后端基础设施、鉴权协作、来源及解析/要求接口具备实现与本地集成测试 | Gateway 真模型费用/视觉能力、真实邮件、比赛 PDF 实际识别和人工核对 |
| B3–B4 | 任务、版本、AI 采纳、预审答辩、事件及导出具备实现与本地集成测试；补齐人工分工建议应用 | 真模型全流程及正式申报材料验收 |
| B5 | 幂等、版本锁、成员权限、异步恢复、AI 并发预占及接入缺陷修复 | 金额预算预占/结算仍不完整：`usage_reservations.estimated_cost` 仍为 0；并发/预算压测、监控及云端部署待完成 |

三档 AI、识别、预审和答辩的成功路径在后端测试中使用模型适配器 fixture；真实 HTTP 联调验证默认禁用 AI 时明确失败，不生成模拟成功内容。游客入口保留原 HTML 原型，正式页不调用该演示数据源。

计划中的材料独立附件关联、作品介绍结构模板和来源全文片段定位尚无完整的正式实现。当前材料页提供正文、版本、评论和导出；来源页提供文件导入、逐页状态与引用原句/页码。答辩会话没有后端列表接口，前端提供本机最近记录及按真实 ID 恢复。这些缺口不计为已完成。

游客原型与接入前 `850a93e:frontend/index.html` 逐字节一致，SHA-256：`47ea209e64928bfa796dfaffd9b7f08fb29dd03435b4a85f9ef351fdbb4eddcd`。

## 主要交付文件

| 文件范围 | 交付内容 |
| --- | --- |
| `frontend/src/pages/`、`components/`、`auth.tsx` | 正式账户和项目页面、协作及 AI 工作流 |
| `frontend/src/api/` | 由 OpenAPI 生成的类型、错误处理、分页和幂等请求 |
| `frontend/src/storage.ts`、`App.tsx`、`vite.config.ts` | 草稿、离线/更新状态、PWA 资产缓存 |
| `frontend/public/guest/index.html` | 原游客演示原型，独立于正式数据入口 |
| `frontend/src/worker.ts`、`frontend/wrangler.jsonc` | 静态资产和 `/api` Service Binding 转发 |
| `backend/src/api/`、`services/`、`ai/`、`test/`、`openapi/openapi.json` | 接入缺陷修复、分工建议、导出及回归契约 |
| 前后端 `package.json` / `package-lock.json` | 可复现依赖、构建和告警修复 |
| `scripts/verify-integration.mjs`、`verify-worker.mjs` | 可复现的真实 HTTP 和转发验证 |
| `README.md`、`PLAN.md`、`backend/docs/` | 运行、部署和本次对齐记录 |

## 验证与剩余条件

2026-09-30，Node `26.3.0` / npm `12.1.0` 下的最终命令行验证：

| 验证 | 结果 |
| --- | --- |
| 两端 `npm ci --registry=https://registry.npmjs.org` | 成功，安装脚本策略明确；无安装脚本许可警告 |
| `npm run typecheck` | 前后端均通过 |
| `npm run lint` | 前端 0 errors / 0 warnings；生成资产不纳入源码 lint |
| `npm run test:backend` | 17 文件 / 75 项通过，退出码 0 |
| `npm run test:frontend` | 7 文件 / 25 项通过；登录、API、分页、存储失败、跨页 Query 缓存和 Worker 契约 |
| `npm run build` | Vite / PWA 成功，无大 chunk 警告；页面懒加载，PDF.js 按需加载 |
| `npm run verify:integration` | 62 项真实 HTTP 检查通过，经前端代理访问真实本地后端；3 个账户验证协作及越权边界 |
| `npm run verify:worker` | Service Binding 原样转发 Cookie / Origin / Set-Cookie / 错误；API 不回落游客或 SPA 内容 |
| 后端 export:openapi、前端 typegen 后比较 Git diff | 契约无漂移，57 路径 / 77 操作 |
| 两端 `npm audit --registry=https://registry.npmjs.org` | 均 0 vulnerabilities |
| 两端 production `wrangler deploy --dry-run` | 编译与绑定配置通过；未部署或创建资源 |
| `git diff --check` | 通过 |

构建文件位于验证 worktree 的 `frontend/dist/`。复现命令见根 README；HTTP 脚本只允许 loopback + local + echo，结束时归档一次性测试项目并注销会话。后端模型成功路径使用受控 fixture，HTTP 联调覆盖 AI 未启用时的真实失败。

**测试运行时残留告警：**已添加每测试的 Workflow introspection / dispose，并确保清理顺序先于 fetch mock 移除；仍观察到 3 次 workerd canceled request 和 1 次 RPC stub 未 dispose 提示，未抑制日志。全部 75 项断言通过，退出成功，Vitest teardown 超时为 0。测试池版本为 `@cloudflare/vitest-pool-workers@0.22.0`；后续仍需定位这些运行时告警，不能宣称完全无告警。完整日志保留在验证 worktree 的 `backend/.wrangler/final-backend-tests.log`。

浏览器视觉、实际键盘操作、移动端、打印 PDF、PWA 安装/离线交互及 PDF.js 实际渲染验收按用户要求延期；JSDOM 测试不替代这些 Chrome 验收。

Cloudflare 当前登录账户的只读检查显示：`ai-office-api` Worker 不存在；D1 列表无 `ai-office-db-staging` / `ai-office-db-production`。仓库生产资源 ID、Gateway 设置及发信配置仍未填入。这次执行本地真实后端联调，不宣称已上线或真实邮件/付费模型调用已验收。

## GitHub 依赖告警处理

暂停 Chrome 前读取到 7 条 open Dependabot 告警，均关联 `backend/package-lock.json` 中的开发工具依赖：sharp/libheif 和 undici。锁文件现将 Miniflare 使用的 `sharp` 固定到 `0.35.4`、`undici` 固定到 `7.29.1`，保留测试池兼容版本；官方 npm audit 已为 0。

修复随主分支推送供 GitHub 自动重新判定，未使用 dismiss 将告警标为忽略。`gh api` 认证此前返回 401；Chrome 暂停期间，GitHub 网页上的最终关闭状态仍未验收，不将“依赖已修复”写成“7 条告警已确认关闭”。
