# 实现与 PLAN.md 对齐记录

更新：2026-09-30。本次范围由用户明确授权：前后端功能核对与接入，保留游客演示，修复接入缺陷，处理 GitHub 依赖告警。用户确认 Chrome 恢复后已继续本地生产构建的页面验收；本记录区分已通过的操作、仍待验证的路径和云端条件。

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
| F0 | React / TS / Vite / 路由 / Query 工程，按后端 OpenAPI 生成类型，正式入口与游客资产隔离 | 完整视觉覆盖仍待完成；本次已实际操作登录、项目、任务、材料、来源、评分及账本 |
| F1–F3 | 邮箱、项目与邀请，来源与要求，团队与任务，材料与三档 AI，预审、答辩、账本和导出接入真实 API | 已通过本地两账户邀请、资料隔离、PDF 上传与实际 PDF.js 渲染；真实模型输出、OCR 与比赛原始材料仍待核对 |
| F4 | PWA 壳缓存、离线及更新提示；账户/项目/材料作用域草稿；409 保留内容并人工比较 | 已验证键盘登录、390px 布局、离线编辑/刷新、重连、JSON/Markdown 下载及材料 PDF；Chrome 安装条件检查通过，操作系统实际安装仍未验收 |
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
| `frontend/src/pages/`、`components/`、`auth.ts` | 正式账户和项目页面、协作及 AI 工作流 |
| `frontend/src/api/` | 由 OpenAPI 生成的类型、错误处理、分页和幂等请求 |
| `frontend/src/storage.ts`、`App.tsx`、`vite.config.ts` | 草稿、离线/更新状态、PWA 资产缓存 |
| `frontend/public/guest/index.html` | 原游客演示原型，独立于正式数据入口 |
| `frontend/src/worker.ts`、`frontend/wrangler.jsonc` | 静态资产和 `/api` Service Binding 转发 |
| `backend/src/api/`、`services/`、`ai/`、`test/`、`openapi/openapi.json` | 接入缺陷修复、分工建议、导出及回归契约 |
| 前后端 `package.json` / `package-lock.json` | 可复现依赖、构建和告警修复 |
| `scripts/verify-integration.mjs`、`verify-worker.mjs` | 可复现的真实 HTTP 和转发验证 |
| `frontend/verification/`、`docs/evidence/` | 可复现 PDF 渲染验收工具、浏览器截图及真实下载/PDF 样本 |
| `README.md`、`PLAN.md`、`backend/docs/` | 运行、部署和本次对齐记录 |

## 验证与剩余条件

2026-09-30，Node `26.3.0` / npm `12.1.0` 下的最终命令行验证：

| 验证 | 结果 |
| --- | --- |
| 两端 `npm ci --registry=https://registry.npmjs.org` | 成功，安装脚本策略明确；无安装脚本许可警告 |
| `npm run typecheck` | 前后端均通过 |
| `npm run lint` | 前端 0 errors / 0 warnings；生成资产不纳入源码 lint |
| `npm run test:backend` | 17 文件 / 78 项通过，退出码 0；新增成员更新隔离、null 清空及省略/零值语义回归 |
| `npm run test:frontend` | 13 文件 / 37 项通过；覆盖材料草稿、PDF 资源清理/尺寸边界、活动说明、概览空态、邀请用尽与按钮可访问名称 |
| `npm run build` | Vite / PWA 成功，无大 chunk 警告；页面懒加载，PDF.js 按需加载 |
| `npm run verify:integration` | 62 项真实 HTTP 检查通过，经前端代理访问真实本地后端；3 个账户验证协作及越权边界；本轮再次经构建预览 localhost:4173 全部通过 |
| `npm run verify:worker` | Service Binding 原样转发 Cookie / Origin / Set-Cookie / 错误；API 不回落游客或 SPA 内容 |
| 后端 export:openapi、前端 typegen 后比较 Git diff | 契约无漂移（当轮快照 57 路径 / 77 操作；当前为 60 / 81） |
| 两端 `npm audit --registry=https://registry.npmjs.org` | 均 0 vulnerabilities |
| 两端 production `wrangler deploy --dry-run` | 编译与绑定配置通过；未部署或创建资源 |
| `git diff --check` | 通过 |

构建文件位于验证 worktree 的 `frontend/dist/`。复现命令见根 README；HTTP 脚本只允许 loopback + local + echo，结束时归档一次性测试项目并注销会话。后端模型成功路径使用受控 fixture，HTTP 联调覆盖 AI 未启用时的真实失败。

**测试运行时残留告警：**已添加每测试的 Workflow introspection / dispose，并确保清理顺序先于 fetch mock 移除。本轮最终测试仍观察到 2 次 workerd canceled request 和 1 次 RPC stub 未 dispose 提示（此前次数为 3 / 1），未抑制日志。全部 78 项断言通过，退出成功，未发生 Vitest teardown 超时。测试池版本为 `@cloudflare/vitest-pool-workers@0.22.0`；根因尚未完全定位，不能宣称完全无告警。新增成员隔离的单独 8 项测试无此告警。

## 本轮 Chrome 页面验收

使用 `npm run preview -- --host localhost --port 4173 --strictPort` 加本地 Wrangler 后端，未调用云邮件或付费模型。一次性测试项目：`f7b7545d-ea97-4f4d-899a-837526c15047`。

| 实际操作 | 观察结果 |
| --- | --- |
| 邮箱验证码、Enter 提交 | 本地 echo 登录成功，新账户项目列表为空 |
| 创建项目、负责人任务、状态更新 | 项目与任务保存成功，AI 页读取到真实任务状态“进行中” |
| 材料创建、正文、评论、刷新 | 修复后空材料不再误报草稿；正文产生 r2，评论读取成功 |
| 双标签页编辑 | B 先保存 r3；A 收到 409，展示两份正文，勾选确认后保存 r4 |
| PWA 构建更新 | 实际显示“立即更新”，点击后加载新构建，修复效果复核通过 |
| 在线页切换离线并编辑 | 保存按钮禁用，显示“离线草稿已写入本机” |
| 重连与原生确认 | 重连没有自动提交；确认后保存 r5，刷新读取到离线正文 |
| 粘贴来源原文 | 服务端创建来源，AI 未启用时明确禁止解析 |
| 自拟评分草稿及负责人确认 | 初始未预填权重，人工填写后保存并确认；预审读取到该评分版本 |
| AI、预审、答辩 | 显示真实材料版本；新建操作禁用，没有模拟结果 |
| 决策和贡献补录 | 保存成功，导出汇总显示各 1 条记录 |
| 手机 390px 宽度 | 来源、要求、AI 页面 document.scrollWidth 与 clientWidth 均为 390；导航可用键盘进入导出 |
| 浏览器控制台 | 材料流程采样未见 warn / error |

本轮发现并修复的材料问题：`setEditable` 默认会发送 Tiptap update 事件，导致未编辑正文被写成草稿。现在状态切换明确 `emitUpdate=false`。保存前重新持久化本标签页正文，避免另一标签页完成保存后清除共享草稿导致 409 正文只留内存；409 同步服务端详情与版本历史，主保存按钮在比较期间禁用。两项新增回归测试均通过。

截图：`docs/evidence/chrome-material-conflict.jpg`、`chrome-offline-draft.jpg`。冲突截图记录修复前后这轮操作中的状态，截图之后又补齐了详情版本同步和主保存按钮禁用。

### 保存框恢复后的补充验收

| 实际操作 | 观察结果 |
| --- | --- |
| JSON 和 Markdown 导出 | 原生保存框分别保存到 Downloads；JSON 可解析，二者包含实际材料正文及决策，已复制为仓库证据 |
| 材料打印 / PDF | 产品按钮触发打印预览；通过 Chrome 打印引擎生成 1 页 PDF，提取与图像检查确认中文正文和 r5，未混入导航/评论。未完成原生“另存为 PDF”菜单与保存流程 |
| 离线刷新 | PWA 外壳正常打开，明确显示服务无法连接和离线提示；没有展示缓存的私人 API 数据。恢复网络并重试后进入材料页 |
| 安装条件 | Chrome `Page.getInstallabilityErrors` 返回空数组；未进行操作系统级实际安装 |
| PDF.js 实际渲染 | 5 页样本的第 2 页为 707×1000 / 43,190 字节；20,000 字节限制下自动缩小至 580×820 / 19,085 字节；中文材料 PDF 为 773×1000 / 14,993 字节 |
| PDF 失败路径 | 页数上限 4 拒绝 5 页文件；第 6 页被拒绝；加密 PDF 显示缺少密码；失败后仍能正常渲染中文 PDF |
| 正式 PDF 来源上传 | 初始化、二进制上传、来源创建成功；刷新后关联原文件仍在。AI 未启用时没有发起解析或伪造要求 |
| 双账户邀请及资料隔离 | 负责人创建 1 次邀请；新账户加入成功；成员页不显示负责人邀请功能；成员修改及负责人反向修改均仅影响各自记录，刷新后保持，时间留空成功清除 |
| 用完的邀请 | 使用 1 / 1 后显示“已用完”，有效邀请数为 0 |
| 活动记录 | 概览与账本使用可读的真实活动说明，保留时间；概览不会多出孤立的 0 或同时显示矛盾的空态 |

补充修复：成员 PATCH 原先仅按 project_id 更新，导致同项目全部成员的技能和投入时间被覆盖。现在同时限定已认证成员的 user_id；时间字段显式 null 清除、省略则保留。真实 D1 回归先复现失败，再验证修复。PDF loadingTask 的加载等待纳入 finally，失败也释放；每页和画布在异常路径释放，尺寸舍入留出余量保证不超过限制。移除成员的图标按钮补齐可访问名称。

验收页位于 `frontend/verification/pdf-render.html`，直接调用生产渲染函数，不模拟 API/模型，不进入生产构建。生成样本、启动和复现方法见该目录 README。Chrome 文件选择初次因扩展未允许本地文件网址而阻止；用户开启权限后已完成实际验收。

证据位于 `docs/evidence/`：`chrome-project-export.json` / `.md`、`chrome-material-print.pdf` / `.png`、`chrome-offline-refresh.jpg`、`chrome-member-isolation.jpg`、`chrome-pdf-render.jpg`、`chrome-pdf-chinese.jpg`、`chrome-pdf-upload.jpg`、`chrome-project-overview.jpg`。导出文件是加入第二个测试账户前的快照。

首次 Markdown 下载触发 macOS 保存框时，等待下载超时；取消保存框后页面恢复。该超时由未完成的保存流程阻塞，不能认定为 Chrome 网络故障。此轮已正确处理两个保存框并验证文件落盘，未遗留保存对话框。

**仍未验收的路径：**操作系统实际 PWA 安装、原生“另存为 PDF”完整交互、真实邮件、Gateway 模型/OCR 到要求提取的云端全流程及比赛原始材料正确性。当前没有真实模型/发信配置，不能用本地渲染及 fixture 单元测试替代这些验收。

此前对 Cloudflare 登录账户的只读检查显示：`ai-office-api` Worker 不存在；D1 列表无 `ai-office-db-staging` / `ai-office-db-production`。仓库生产资源 ID、Gateway 设置及发信配置仍未填入。这次执行本地真实后端联调，不宣称已上线或真实邮件/付费模型调用已验收。

## GitHub 依赖告警处理

暂停 Chrome 前读取到 7 条 open Dependabot 告警，均关联 `backend/package-lock.json` 中的开发工具依赖：sharp/libheif 和 undici。锁文件现将 Miniflare 使用的 `sharp` 固定到 `0.35.4`、`undici` 固定到 `7.29.1`，保留测试池兼容版本；官方 npm audit 已为 0。

修复已合并并推送 `main`。推送后再次尝试 `gh api`，本次认证可用；Dependabot API 返回此前的 #1、#4、#5、#6、#7、#10、#11 均为 `fixed`，当前 open 告警为 **0**。没有使用 dismiss 忽略告警。推送时 GitHub 的旧状态提示仍为 7 条，随后由依赖扫描自动判定为修复；本结论以推送后的 API 响应为准。

本轮收尾再次通过 Dependabot API 确认 open 为 0，不需要读取 Chrome 页面。主工作区已执行 `npm run install:all` 安装与锁文件一致的依赖。浏览器验收恢复后另启动本地后端和构建预览；本轮状态以以上实际验收记录为准。

## launch_prep 本轮：A01–A15 本地推进与验证（2026-09-30）

用户明确授权：继续解决 A01–A15，进行本地测试，**不部署云端、不向任何可能产生费用的 API 发送请求**。本轮全部模型路径使用受控 fixture 或测试注入的 fetch mock。

### 实现与测试结果

本地 Node `v24.21.0` / npm `11.19.0`：

| 验证 | 结果 |
| --- | --- |
| `npm run typecheck` | 前后端通过 |
| `npm run lint` | 前端 0 error |
| `npm run test:backend` | 22 文件 / 100 项通过，退出码 0（本轮由 17/80 增加到 22/100） |
| `npm run test:frontend` | 14 文件 / 38 项通过 |
| `npm run build` | 通过 |
| `wrangler deploy --dry-run --env staging`（前后端） | 编译与绑定通过，未部署、未创建资源 |
| `npm run preflight:deploy -- staging` | 按预期 BLOCKED 并列出 3 项缺失：EMAIL_FROM、真实 D1 database_id、前端 HTTPS Origin 白名单 |
| `npm run export:openapi` + `npm run typegen` | 契约无漂移，当前 60 路径 / 81 操作（新增两个幂等运维端点） |
| `npm run verify:integration` | **本轮未执行**：本机 8787 端口被会话开始前已存在的 workerd（PID 44936，19:18 启动）占用，Vite 代理固定指向该端口，运行会验证到旧代码。该命令仍为可用本地验证，需先释放 8787 后自行执行 |

本轮修复的真实缺陷：

- 空 OCR 结果（模型返回不含 `text` 的 JSON）此前会被当作识别成功，导致跳过失败页并在后续误报「来源没有可分析的文本内容」。现在空文本使该页标记失败，任务以 `AI_OUTPUT_INVALID` 失败且该页可重新上传重试。
- 过期额度清理此前会释放「任务仍在运行」的预占，存在重复扣款与超额放行风险；现在只在对应任务已终态或任务记录缺失（孤儿）时回收，且清理前检查条件更新影响行数。
- 任务恢复不会再把已终态任务改回运行中；工作流实例已结束但业务未提交时标记失败并释放额度。

新增占位与既有占位的状态见 [架构文档第 7 节](ARCHITECTURE.md#7-未完成与不确定事项登记)。A01/A02/A14 的云端部分仍保留「待云环境验收」，A12 需人工在操作系统完成，A13 的保留策略与压测仍待完善。
