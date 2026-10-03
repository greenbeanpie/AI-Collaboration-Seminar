# 帮助文档发布记录

日期：2026-10-03。入口：`https://greenbp-team-office.hddhp.workers.dev/app/help`，登录后左侧菜单「帮助文档」。

## 交付内容

- `frontend/src/help/USER-GUIDE.md`：面向普通成员和项目负责人，不包含部署、开发或网站管理员设置。
- `frontend/src/help/TECHNICAL-IMPLEMENTATION.md`：架构、认证权限、版本并发、协作、AI 调查及工具、预算重试、评分、通知和代码索引。
- `frontend/src/pages/HelpPage.tsx`、`HelpPage.css`：两份文档切换、章节目录、按章节搜索、完整 Markdown 下载及窄屏折叠目录。
- `frontend/src/App.tsx`、`frontend/src/components/AppShell.tsx`：登录保护路由 `/app/help` 与菜单入口。
- `HelpPage.test.tsx`、`SettingsRoutes.test.tsx`、`AppShell.test.tsx`：阅读、搜索、下载、普通用户访问及菜单回归。
- `README.md`：文档入口及源文件索引。
- `scripts/verify-help-ui.cjs`、`scripts/verify-help-production.mjs`：可重复的只读验证。

源 Markdown 通过 Vite 的 raw import 随帮助页面懒加载，不新增解析依赖或 API；渲染使用 React 转义文本，限制链接协议，不执行文档 HTML。下载的是完整源文档，不受当前搜索过滤影响。

## 验证

- `npm run test:frontend`：90 文件、482 项通过。
- 最终目录折叠修改后，相关 3 文件、21 项再次通过。
- 前端 TypeScript、lint、生产构建、`npm run verify:worker`、`npm run preflight:deploy -- production` 和 `git diff --check` 通过；构建无警告。
- 生产构建使用真实 Edge 浏览器验证1440像素浅色、390像素深色、320像素浅色：普通成员入口、两份文档、表格、搜索与空结果、章节跳转、刷新、完整下载逐字节一致；无页面横向溢出或浏览器错误。
- 本地未登录用户重定向登录页。结果及截图见 `verification.json` 和本目录 PNG。
- 线上入口 HTML、主入口 JS、帮助 JS/CSS 状态200，SHA-256与本次构建完全一致；匿名会话401、健康检查200，见 `production-verification.json`。
- 生产浏览器确认旧版本出现更新提示，更新后访问 `/app/help` 重定向 `/login`，未登录访问保护正常。

本地浏览器验证可在启动 `npm run preview --prefix frontend -- --port 5237` 后运行 `node scripts/verify-help-ui.cjs`。如 Playwright 未安装在项目内，可通过 `UI_PLAYWRIGHT_PATH` 指向已安装模块，`UI_CHROMIUM_PATH` 指定浏览器可执行文件。脚本只允许 loopback，所有 API 响应是只读夹具。

## 发布与边界

仅发布既有前端 Worker `greenbp-team-office`，继续使用既有 API Service Binding。没有应用迁移或部署后端，工作区原有 `.gitignore` 和后端修改保留。

- 前端发布前版本：`87d633f8-9a58-446b-af26-eb2f7e46f8e9`。
- 本次前端版本：`bb7cfcc4-8560-44be-ae31-516ebec7dab8`。

当前浏览器没有有效生产登录会话，登录后的线上文档交互未单独验收。没有新建生产测试账户、重置密码、产生项目写入或调用付费模型。技术文档描述当前源码，并明确包含未提交后端与实际线上版本的边界；本次帮助发布不证明那些业务变更已经上线或模型质量已经验收。
