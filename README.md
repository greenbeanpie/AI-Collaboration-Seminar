# 「补位」AI 项目办公室

前端真实应用与 Cloudflare Workers 后端使用同源 `/api/v1` 接口。登录后读取真实项目和材料；原有演示原型保留在登录页的 **游客体验** 入口，演示数据和模拟 AI 只存在于 `/guest/`。API 失败不会退回演示成功。

## 目录

| 路径 | 用途 |
| --- | --- |
| `PLAN.md` | 功能、架构与验收计划 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 当前实现架构、数据关系、关键流程与编号待办 |
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

打开 <http://localhost:5173>。本地使用独立模拟 D1 / R2，但业务请求由真实后端实现处理；登录使用账号或邮箱与密码，注册需要管理员生成的单次邀请码。首次本地启动先执行 `npm run bootstrap:admin:local`，凭据保存在 gitignored 的 `.local-secrets/admin-credentials.json`。AI 默认禁用。系统管理员可在项目设置中的「AI 模型接入与测试」填写 API URL、key 和模型名称；模型地址和密钥默认留空。后端已强制要求同一配置版本的三用途探测通过才允许启用。capabilities 的启用标志仍不代表模型持续可用。未启用时真实入口会显示不可用。

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

## 未完成内容与上线条件

详细模块、数据模型及流程见 [架构文档](docs/ARCHITECTURE.md)。以下占位按固定编号跟踪；代码存在或本地测试通过不能替代云端验收。

| 状态 | 尚需完成 | 详细占位 |
| --- | --- | --- |
| 生产主路径已验证 / 部分待验收 | 两端 Worker、D1/R2、迁移与 Service Binding 已部署；Resend 域名、真实投递及受邀登录已通过；自定义域名自动化挑战与 staging 仍待处理 | [A01](docs/ARCHITECTURE.md#a01)、[A02](docs/ARCHITECTURE.md#a02) |
| 已加固 / 真模型待验收 | 已修复先派发后预占和失败费用释放；有限预算仅支持已知价格的 Workers 文本模型，供应商实际账单仍需核对；探测、冻结与切换已有本地覆盖 | [A03](docs/ARCHITECTURE.md#a03)–[A05](docs/ARCHITECTURE.md#a05)、[A15](docs/ARCHITECTURE.md#a15) |
| 已加固 / 边界保留 | Workflow 实例缺失可安全恢复，已发出调用不会自动重放；采纳冲突不再留下版本或账本事件；幂等响应与业务仍分两次提交，保留人工恢复路径 | [A06](docs/ARCHITECTURE.md#a06)–[A08](docs/ARCHITECTURE.md#a08) |
| 已实现（本地） | 材料附件、作品介绍模板、来源全文引用定位、答辩跨设备历史列表 | [A09](docs/ARCHITECTURE.md#a09)–[A11](docs/ARCHITECTURE.md#a11) |
| 本地已完善 / 云端与人工待验收 | PWA 安装入口、保留策略、GC、本地恢复与预算竞争测试已新增；实际安装、原生 PDF 保存、云端监控与压测待验收 | [A12](docs/ARCHITECTURE.md#a12)、[A13](docs/ARCHITECTURE.md#a13) |
| 待验证（云端） | 真模型/OCR 云端全流程与比赛原始材料、最终申报内容人工验收 | [A14](docs/ARCHITECTURE.md#a14) |

既有本地浏览器/HTTP 验证、测试结果及残留告警见 [实现对齐记录](docs/IMPLEMENTATION-ALIGNMENT.md)。**本地验证不等于云端验收**：模型成功路径使用受控 fixture（本地零费用端到端见 A14），PDF 渲染成功不代表 OCR 正确，金额预占与结算的数值规则仍需与真实供应商账单核对。各项占位包含代码位置与完成判据，关闭时应补充提交和验证证据。

## 最新进度核对（2026-09-30，基线 19dedbd）

本次核对自文档基线 `99edc16` 之后的两个提交：`e700086`（本地 A01–A15 功能与验证）和 `19dedbd`（生产 Worker 命名与绑定）。当前分支仍为 `launch_prep`。

- 本次重跑：后端 **25 文件 / 109 项**、前端 **15 文件 / 43 项**通过；typecheck、lint、build、verify:worker 通过。测试仍有 workerd / RPC 释放告警，未隐藏。
- production 静态部署预检通过；staging 仍缺 EMAIL_FROM、真实 D1 ID 和 HTTPS Origin。预检只检查仓库配置，不证明云资源、Secrets、邮件或部署已经验收。
- 生产目标：前端 `greenbp-team-office`，后端 `greenbp-team-office-backend`；API Service Binding 已对齐。预期入口 `https://team.greenbp.dpdns.org`，本次未访问或验证该云端入口。
- **发布前代码阻碍仍有 A03/A07/A08**：先派发再预占、失败费用释放、非保守 token 估算；Workflow 创建前崩溃且实例不存在时无恢复；采纳版本冲突可能留下补偿未清理的账本事件。不能将全部本地测试通过等同于预算与恢复语义完整。

逐项证据与未完成边界见 [架构文档](docs/ARCHITECTURE.md)，本次测试记录见 [进度核对记录](docs/IMPLEMENTATION-ALIGNMENT.md#最新提交进度核对2026-09-30基线-19dedbd)。模型 URL/key 继续由用户在网页填写，真模型测试尚未执行。

## 历史生产状态：邀请制邮箱登录（2026-09-30，已被密码认证取代）

用户选择暂用邀请制，未来再迁移 VPS 前端/反向代理。现已部署：

- 临时可用入口：<https://greenbp-team-office.hddhp.workers.dev/>。`team.greenbp.dpdns.org` 对自动化请求仍有 Cloudflare 挑战，未关闭该 zone 的 Bot Fight Mode。
- `AUTH_MODE=invite-only`；批准邮箱存为 Worker Secret `AUTH_ALLOWED_EMAILS`，不写进仓库。只关闭本应用的 CAPTCHA 路径，生产公开模式仍强制 Turnstile，未批准邮箱和被移出名单的会话都拒绝访问。
- 全站最多 **30 次发信尝试 / UTC 日**、单邮箱最多 **6 次 / UTC 日**、IP 最多 **10 次 / 滚动小时**；计数在真实发信前同一 D1 batch 预占，验证码清理不重置日/小时计数。供应商失败也保留尝试计数。
- Resend 发信子域 `auth.greenbp.dpdns.org` 已 Verified；邮件 Delivered、用户实际登录、生产材料 r2 保存/刷新、匿名项目访问 401、未批准邮箱 403 已验证。验收项目归档后保留历史，会话保留方便继续配置 AI。
- 本轮：后端 **142 项**、前端 **48 项**、本地 HTTP **68 项**通过；typecheck/lint/build、恢复演练及生产部署通过。已知 Workers 测试池收尾告警保留。
- AI URL/key 仍由用户在网页设置填写，真实模型/OCR 未调用。原生 JSON 下载等待超时，导出预览及内容已验证；操作系统 PWA 安装/原生 PDF 保存仍待人工。

未来 VPS 文件在 `deploy/vps/`：Docker Compose 配置检查和固定镜像的 Caddy 离线配置验证通过；尚未部署云服务器。实际步骤与 IP 传递限制见 [部署说明](backend/docs/DEPLOY.md)。当前云端证据见 [验收记录](docs/IMPLEMENTATION-ALIGNMENT.md)。此前 19dedbd 的进度核对是历史快照，上述状态覆盖其中已修复问题。

## 密码登录与邀请码注册（2026-10-01）

登录填写用户名或邮箱和密码。注册填写用户名、12–128 位密码和管理员生成的 16 位一次性邀请码；邮箱选填。用户名为 3–32 位英文字母、数字、下划线或连字符，账号与邮箱登录不区分大小写，密码保留原始字符。

系统管理员在「账号与邀请码」生成注册码，每个只能使用一次；完整码仅在生成时显示，数据库只存哈希。项目负责人不能生成系统注册码。AI 设置支持管理员登录会话；模型 URL/key 继续留空并保留测试按钮。

默认管理员账号 `greenbp`，邮箱 `zgpride87@outlook.com`。随机密码和登录地址只保存在本机 `.local-secrets/admin-credentials.json`，目录已排除 Git 并限制当前 Windows 用户访问。分别用 `npm run bootstrap:admin:local` 和 `npm run bootstrap:admin:production` 初始化，重复执行复用凭据，不自动重置密码。

迁移保留原用户 ID、项目和材料。旧验证码会话失效，已有普通邮箱账号需另行安全设置密码，不能通过自填邮箱认领；邮箱选填不代表邮箱已验证，也不能作为自动找回凭据。旧验证码接口返回 410，不再发信。当前尚未提供自助密码找回。

本轮已部署并验收：后端150项、前端54项、本地HTTP73项、生产认证14项通过，类型检查、lint、构建和本地恢复演练通过。管理员网页登录和原项目保留已实际确认。详情见 [密码认证验收](docs/IMPLEMENTATION-ALIGNMENT.md#密码认证与注册邀请码验收2026-10-01)；测试池既有收尾告警仍保留。

## 三级账户权限

账户等级与项目 `owner/member` 权限独立：
- 超级管理员：管理账户等级、系统 AI 设置与运维恢复；管理一般用户与邀请码。
- 普通管理员：查看账户、修改一般用户显示名称、生成与查看注册邀请码；不能任命管理员、修改管理员/超级管理员或操作系统设置。
- 一般用户：管理自己的资料与密码，仅访问获准加入的项目。

`0013_account_roles.sql` 为增量迁移，不更改密码哈希、用户 ID、会话、项目或材料。仅当既有账号同时匹配已核实的生产用户 ID `f5f71370-f8cf-4fb5-b0b7-d337c36a9711`、`greenbp`、`zgpride87@outlook.com`、原管理员标志和已有密码时升级为超级管理员；其他管理员维持普通管理员。部署前应只查询上述身份和角色字段确认匹配，若不匹配则先核实，不能批量提升。新注册账号固定为一般用户。角色变更在数据库同一原子操作中重验操作者权限并保护最后一位可登录超级管理员，记录操作者审计；已有会话每次请求读取最新等级。

部署顺序：确认生产身份 → 在现有 D1 应用迁移 → 部署后端 → 部署前端 → 验证现有账号登录和三级权限。无需运行密码初始化脚本或重置凭据。旧 `isAdmin` 返回字段保留（两级管理员均为 true）；`role` 为账户等级权威字段。旧运维 `ADMIN_TOKEN` 仅保持原有接口能力，不可访问新增账户列表、资料管理或等级变更接口；等级变更必须使用超级管理员密码会话。

## 站内支持工单

`/app/support` 提供文字问题/求助工单。一般用户只能创建、读取、回复自己的工单；普通管理员和超级管理员可读取、回复全部工单并修改状态。支持权限不扩大任何项目访问权限，游客/旧验证码会话和运维 Bearer 不能访问工单。

- 状态：待处理、处理中、待用户回复、已解决、已关闭。管理员可重新打开已关闭工单；关闭期间不接受回复。
- 标题最多 160 字、正文/回复最多 8000 字；纯文本展示，无附件、邮件通知或 HTML 渲染。请勿提交密码、验证码、API 密钥或支付资料。
- 工单和沟通历史分别分页；状态变更使用版本检查，保留操作者和状态历史，避免并发覆盖。
- 提交限每账户每小时 10 次、每 IP 每小时 30 次；回复限每账户每小时 60 次，状态修改限每管理员每小时 120 次。
- `0014_support_tickets.sql` 仅新增工单与消息表、索引，不修改既有账户和项目。无需生产测试工单或新外部服务。

本次验证包含 D1 权限/IDOR、角色撤销、并发状态更新、分页、验证/限流与 React 界面测试。云端浏览器的本地 Chromium 启动受到 socket EPERM 限制，视觉验收尚未完成；生产验收和发布需单独进行。`scripts/verify-account-roles-ui.cjs` 为仅限 loopback 的角色界面 fixture 检查，不使用真实凭据。
