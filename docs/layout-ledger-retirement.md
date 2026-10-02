# 任务布局与手工账本功能删除

日期：2026-10-02。已完成本地实施与验证，未发布生产，未运行远程数据库迁移。

## 修改

- 子任务卡片等高、底部操作对齐；依赖警告仅保留在状态右侧，支持悬浮与键盘聚焦查看完整提示。标题、摘要、依赖名称限制展示行数，详情保留全文。
- AI 操作入口位于新建子任务左侧，筛选标签与下拉框横向对齐；折叠 AI 面板不会清空草稿。
- 任务设置增加“任务介绍”，移除重复执行人信息，依赖编辑入口在标题左侧，编辑区展开在下方。
- 项目 AI 与后端能力卡片宽屏并排；团队成员负荷与邀请区域分栏，成员卡片自适应排列。窄屏纵向排列。
- 活动历史保留入口、地址和事件流分页，删除“过程账本”大标题以及三项手工记录功能。旧事件仍可阅读。
- 删除决策、贡献及更正、第三方资源声明 API 和专用类型，导出不再包含 `decisions`、`contributions`、`resources`。AI 不再搜索或读取决策表；旧引用标记“来源已移除”，禁止作为可重新验证的依据应用。
- 迁移 `0033_remove_manual_ledger.sql` 删除三个表。先清空贡献更正链自引用，保证外键开启时可安全删表；不删除项目文件、任务验收决定或内部事件。

## 文件

| 部分 | 修改文件 |
| --- | --- |
| 任务界面 | `frontend/src/pages/CollaborationWorkspace.tsx`、`CollaborationWorkspace.css`、`CollaborationWorkspace.test.tsx` |
| 设置与团队 | `frontend/src/pages/ProjectSettingsPage.tsx`、`TeamPage.tsx`、`CompactSettings.css` |
| 活动历史与导出 | `frontend/src/pages/LedgerPage.tsx` 及测试、`ExportPage.tsx` 及测试 |
| 历史引用提示 | `frontend/src/pages/RemovedSourceNotice.tsx` 及测试、`ProposalCorrection.tsx`、`AssessmentWorkspacePage.tsx` |
| 后端 | `backend/src/api/ledger.ts`、`backend/src/services/project-context.ts`、`project-evidence.ts`、`project-reference-guard.ts` |
| 迁移与契约 | `backend/migrations/0033_remove_manual_ledger.sql`、`backend/openapi/openapi.json`、`frontend/src/api/openapi.ts`、`types.ts` |
| 后端回归 | `backend/test/86-ledger-export.test.ts`、`99-recycled-ai-inputs.test.ts`、`119-retired-ledger-context.test.ts` |
| 样式清理 | `frontend/src/styles/app.css`、`readability.css`（删除三项功能的专用样式） |
| 验证与文档 | 本文件、后端 README、架构与简化文档、`scripts/verify-layout-retirement-ui.cjs`、`verify-ledger-removal-migration.py`、`verify-simplification-migration.py`、`verify-integration.mjs`、`backup-drill-local.mjs`、旧UI验证脚本中的手工记录测试数据 |

## 验证

- 后端完整测试：77 文件、717 项通过（`--maxWorkers=4`）。默认并行初次运行有一个既有个人资料测试超时，隔离重跑及限制并发的完整重跑通过；既有 workerd canceled-request / RPC 清理告警仍可见。
- 前端完整测试：83 文件、438 项通过；最后删除重复警告后，相关27项测试再次通过。
- 前后端类型检查、前端 lint 与生产构建通过；OpenAPI 和前端契约重新生成。
- 真实本地 Worker HTTP 验证：104 项通过，覆盖多账户协作、依赖、提交验收、版本冲突、权限、私有文件、删除的接口及导出。使用本任务专用的前端5190与后端8790端口。
- SQLite 迁移演练：含三级更正链的旧库，备份和恢复逐表逐行一致；删表后其余70张表及历史事件一致，外键与完整性通过；全新数据库完整迁移通过。结果见 [`output/ledger-removal-migration.json`](../output/ledger-removal-migration.json)。
- 本地 D1 完整迁移通过；D1 导出与独立恢复演练6项通过。
- Chromium 使用真实 React 页面与本地 API 测试数据验证1440、768、390px：所有卡片等高、底部对齐、AI入口左于新建按钮、筛选/弹窗/键盘提示/草稿保留/设置分栏/事件分页通过，无横向溢出或浏览器异常，无删除接口请求。截图与测量见 [`output/layout-retirement-ui/report.json`](../output/layout-retirement-ui/report.json)。界面测试数据与真实 Worker HTTP 验证分开，未调用真实模型。

复现核心检查（仓库根目录）：

```powershell
npm run typecheck
npm run lint
npm run build
npm test --prefix backend -- --maxWorkers=4
npm test --prefix frontend -- --maxWorkers=4
py scripts/verify-ledger-removal-migration.py
py scripts/verify-simplification-migration.py
node scripts/backup-drill-local.mjs
```

浏览器检查需要 Playwright 与 Chromium。先在一个终端运行 `node scripts/verify-layout-retirement-ui.cjs --serve`，再在另一个终端设置 `UI_PLAYWRIGHT_PATH` 为 Playwright 包路径、`UI_CHROMIUM_PATH` 为现有 Chromium/Chrome 可执行文件，运行 `node scripts/verify-layout-retirement-ui.cjs`。测试服务仅绑定127.0.0.1，使用5198/8798端口。

## 生产发布与恢复

以下仅为执行步骤，本次未执行。删除三张表会删除其中全部历史记录，SQL不可逆；恢复必须依靠迁移前备份。

1. 暂停写入并等待在途写操作结束。记录当前前后端 Worker 版本和数据库迁移状态，在 `.local-backups/` 保存远程 D1 全量备份。该目录已被 Git 忽略。记录每张表的行数。
2. 使用独立恢复库或 SQLite 恢复文件验证备份：建表语句先于数据导入，事务中延迟外键检查；比对表、行数和外键完整性。不要导入覆盖现有项目库。保存校验记录后才继续。
3. 发布本次清理后的后端，再发布构建后的前端。此时三张旧表可以暂时保留；新代码已不读写它们。核对登录、活动历史、任务协作、导出与 AI 项目查询正常，三项删除接口返回404。
4. 确认0033之前的迁移均已应用，然后执行生产D1迁移。再次核对三张表不存在，其余表行数、任务验收和事件历史保持一致，接口检查通过，再恢复写入。
5. 删表前可回滚应用版本。删表后若需恢复旧功能，维持暂停写入，先恢复迁移前完整数据库及迁移状态，验证后再回滚应用；仅回滚代码会因缺表而失败。备份后的新增写入不能用旧备份覆盖，因此迁移窗口须暂停写入。

备份、发布与迁移命令分别在对应子目录运行：

```powershell
# backend/；先创建仓库根目录的 .local-backups/。
npx wrangler d1 export DB --env production --remote --output ../.local-backups/ledger-before-0033.sql
npx wrangler deploy --env production

# frontend/；完成上面的应用验证后，再进入删表阶段。
npm run build
npx wrangler deploy --env production

# backend/；仅在备份恢复验证、应用验证和迁移状态核对均通过后运行。
npx wrangler d1 migrations apply DB --env production --remote
```

生产备份恢复、远程部署、真实模型调用和生产删表均未验证。本地凭据保存在被忽略的私有文件，未纳入交付或输出。
