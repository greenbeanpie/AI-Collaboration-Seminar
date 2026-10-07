# 材料检查修复与自动化验证（2026-10-07）

## 原因与修改

- 无成果正文也能创建评分作业，快速路径生成 `unscorable` 报告后记录显示 `succeeded`。创建接口现于预留 AI 作业之前检查冻结成果正文，空成果、空白、未提取正文的附件、只有背景资料均返回可操作提示，不创建评分作业。
- 自动发现成果未过滤已归档材料，现排除归档材料；用户明确选择的固定版本仍按已有规则处理。
- 维度、要求及原文证据校验此前在 `aiJsonCall` 返回后执行，因此引用不符直接导致评分失败。现使用业务 schema 校验，错误包含字段路径，可进入现有输出修复及续跑流程。保留逐字匹配、固定版本和实际回答约束；调用窗口耗尽时暂停，未通过校验不发布报告。
- 前端历史列表区分“已评分”和“已完成 · 无法评分”，保留原始历史报告及失败记录。

## 修改文件

- `backend/src/api/project-simplification.ts`
- `backend/src/services/assessments.ts`
- `backend/test/102-project-simplification.test.ts`
- `frontend/src/pages/AssessmentWorkspacePage.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.test.tsx`

合并远端主分支后，代码差异仅上述五个文件。保留远端已有成果文件正文提取、AI 调用窗口、续跑和暂停机制。本次无需新增数据库迁移。

## 已通过验证

- 后端5文件45项测试：评分创建与证据修复、标准有效性、历史评分读取、成果文件登记及正文、供应商续跑。
- 前端2文件21项测试：材料/答辩记录与状态、人工修正入口。
- 前后端类型检查、前端 lint、Worker Service Binding 转发检查、`git diff --check`。

可复现命令：

```powershell
npm test --prefix backend -- test/102-project-simplification.test.ts test/110-project-plans-assessments-tools.test.ts test/125-effective-standard-core.test.ts test/134-task-files.test.ts test/116-ai-json-provider-continuation.test.ts
npm test --prefix frontend -- src/pages/AssessmentWorkspacePage.test.tsx src/pages/ManualAssessmentEditor.test.tsx
npm run typecheck
npm run lint --prefix frontend
npm run verify:worker
$env:VITE_BUILD_VERSION = git rev-parse HEAD
npm run build --prefix frontend
npm run preflight:deploy -- production
```

## 验证边界

按用户要求不进行浏览器测试。本轮未重放生产付费评分，也未改写历史材料或评分；旧版本没有正文时需补充正文或重新上传并完成提取，再发起新一轮检查。自动化模型响应用于验证业务流程，不代表真实供应商一定能修正任何引用错误。

初始旧分支全量测试在同步主分支期间中止，结果不作为验收。通用本地集成脚本因未启动本地5173服务未完成，不将其报告为通过；评分接口链路由上述Workers测试夹具验证。生产构建和部署结果以本次发布输出及交付报告为准。
