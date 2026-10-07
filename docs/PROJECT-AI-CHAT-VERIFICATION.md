# 项目问答验证记录

日期：2026-10-07。代码在当前隔离 worktree 的 `codex/project-ai-chat` 分支交付；未部署生产。

## 已实现

- 主目标下方的个人问答卡片、服务端历史、连续追问、分页与清空。
- 每轮可折叠资源记录、真实工具名称/资料标题/固定版本跳转、运行/完成/失败状态及尝试编号。
- 复用加密检查点和重试链；已完成工具不重读，完整答案保存失败不重新调用模型。
- 用户/项目隔离、重复提交保护、权限和资料变更检查、旧尝试写入保护。
- 清空先永久失效会话与删除可见历史，再通过持久清理队列删除加密上下文。
- 修复清空时旧历史请求回填、任务结束刷新打断操作分页两处竞态。
- 网络断开后暂停状态读取，连接恢复后继续原任务；输入保留，支持中文输入法。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| 前端全量 Vitest | 142 个文件、870 项通过 |
| 后端全量 Vitest | 138 个文件、1,238 项通过 |
| 最终问答后端专项 | 14 项通过，包含全量运行之后补充的 2 项资料引用/缓存测试 |
| 最终前端相关专项 | 4 个文件、27 项通过；已包含在前端全量中 |
| 前后端 TypeScript | 通过 |
| 前端 ESLint | 通过 |
| 前端生产构建及 PWA 生成 | 通过 |
| OpenAPI 导出和前端类型生成 | 通过，聊天类型引用生成契约 |
| 迁移检查 | 62 个迁移通过，历史迁移保持不变 |
| `git diff --check` | 通过 |
| 浏览器验收 | 1440px 浅色桌面、390px 深色手机通过，无页面错误或横向溢出 |

后端专项使用实际本地 Worker、D1 与 R2 测试绑定，模型供应商请求使用固定测试响应，不读取真实密钥或产生实际调用费用。验证了资料工具读取正文后只保存模型选用的固定版本引用；模拟完整答案保存失败后恢复，供应商调用数保持为一次；模拟已完成工具后的请求中断，恢复不再执行该工具。还覆盖未知请求响应、个人权限、资料变更、AI 关闭、完整问答分页、清空/续跑并发和 R2 删除失败后的恢复。

浏览器验收针对构建产物，用固定 API 响应验证界面交互：位置、发送失败保留输入、操作记录与分页、资料链接、刷新恢复、从停止处继续、完成后折叠、答案引用、清空和布局。浏览器测试未连接真实模型或生产后端，不能作为云端供应商验收。

原有全量后端负向测试的 workerd 结束清理日志仍含 RPC stub、请求取消和断线提示。改动前后均为 9 条匹配日志，新问答专项没有这些提示；未屏蔽日志或修改无关清理代码。

## 可复现验证

在项目根目录运行：

```sh
npm ci --prefix backend
npm ci --prefix frontend
npm run typecheck
npm run lint
npm run test:frontend
npm run test:backend
npm test --prefix backend -- test/142-project-ai-chat.test.ts
node scripts/check-migrations.mjs
VITE_BUILD_VERSION=$(git rev-parse --short HEAD) npm run build
```

打开一个终端运行预览，构建更新后重新启动预览以确保读取最新产物：

```sh
npm run preview --prefix frontend -- --port 4173
```

另一个终端运行：

```sh
node scripts/verify-project-chat-ui.mjs http://127.0.0.1:4173
```

浏览器脚本默认使用本机 Codex 附带的 Playwright 和 Google Chrome；其他环境可设置 `PLAYWRIGHT_MODULE` 与 `CHROME_EXECUTABLE`。输出位于 `output/project-chat/browser/`，包括 `report.json`、桌面和手机的失败/完成截图。失败时另存诊断截图和页面文本。

## 主要修改文件

- 前端：`frontend/src/components/ProjectAiChat.tsx`、`project-ai-chat.css`、`AiActivityStatus.tsx`，`frontend/src/pages/ProjectOverviewPage.tsx`、`aiWorkflowSupport.tsx`，`frontend/src/api/project-chat.ts`、`openapi.ts` 及相关测试。
- 后端：`backend/src/api/project-ai-chat.ts`、`jobs.ts`、`ai-tools.ts`，`backend/src/services/project-ai-chat.ts`、`project-ai-tools.ts`、`project-context.ts`、`ai-jobs.ts`、`admin-ai-retries.ts`，`backend/src/app.ts`、`cron.ts`。
- 契约与迁移：`backend/openapi/openapi.json`、`backend/migrations/0064_project_ai_chat.sql`。
- 验收：`backend/test/142-project-ai-chat.test.ts`、`scripts/verify-project-chat-ui.mjs`。
- 文档：`docs/PROJECT-AI-CHAT.md` 与本记录。

## 发布边界

生产启用前需要先应用迁移 `0064_project_ai_chat.sql`，再部署后端及前端，并使用授权账户验证真实模型的工具能力和云端资料引用。当前未进行这些操作。

加密上下文删除失败时会进入定时重试，旧会话已经不可访问或恢复。极端情况下，原有检查点写入器已经发出的旧 R2 写入可能留下不可访问的孤立对象；当前采用会话失效保护，不声称对象在所有并发情况下都立即物理删除。系统级调用审计按既有规则保留。
