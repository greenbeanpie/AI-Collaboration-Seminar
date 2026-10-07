# 文件处理并发与历史错误修复（2026-10-07）

## 原因与改动

现场只读查询确认没有 `reserved` 并发预占，但 5 条文件记录仍显示历史并发拒绝错误。此前临时并发不足被持久化为阶段失败，页面用阶段标志而非真实作业判断重试可用性。

- 后端文件状态接口新增 `jobStatus`、`executionState`、`concurrency`、`errorIsHistorical`、`waitingForConcurrency`；历史错误与当前容量独立显示，忽略已被后续 OCR 完成替代的扫描等待任务。
- 正文/OCR、总结、要求和媒体处理的并发拒绝保存为同一作业的延迟执行片段。现有 outbox 保存一分钟延迟，由分钟恢复器派发，保留检查点且不立即重新调用供应商。快速实例启动与派发确认之间使用后继片段保护。
- 成功、失败、等待输入及显式取消及时释放名额；恢复器回收终态及安全暂停名额。孤儿预占保留两分钟创建宽限；活跃调用、结果未知调用及后台续跑保留保护。
- 页面依据真实作业开放重试，历史错误显示“上次处理失败”，显示当前项目容量；排队禁止重复提交，暂停指向处理记录。
- 不增加每项目 2 个名额，不删除原文件、日志和用量记录，无数据库结构迁移。

## 修改文件

后端：`services/ai-reservations.ts`、`jobs.ts`、`ai-execution-control.ts`、`ai-execution-slices.ts`、`file-processing.ts`、`parse.ts`、`source-summary.ts`、`media-summary.ts`、`cron.ts`、`api/file-processing.ts`，以及 OpenAPI 契约。

前端：`pages/FileProcessingActions.tsx`、`file-processing-client.ts`、生成的 `api/openapi.ts`。回归文件包括 `149-file-concurrency`、`146-reservation-recovery`、`139-file-processing`、`28-reservation-adoption-atomic`、`82-agents` 和组件测试。

## 可复现验证

```powershell
npm test --prefix backend -- test/149-file-concurrency.test.ts test/146-reservation-recovery.test.ts test/139-file-processing.test.ts test/141-file-processing-api.test.ts test/74-source-summary.test.ts test/28-reservation-adoption-atomic.test.ts test/82-agents.test.ts test/116-independent-workflow-slices.test.ts test/116-ai-execution-control.test.ts test/23-job-recovery.test.ts test/27-idempotency-recovery.test.ts test/133-snapshot-etag-cron.test.ts test/98-source-lifecycle-processing.test.ts test/128-media-summary.test.ts test/149-mimo-media-pipeline.test.ts test/138-admin-ai-retries.test.ts
npm test --prefix frontend -- src/pages/FileProcessingActions.test.tsx
npm run typecheck
npm run lint
npm run export:openapi --prefix backend
npm run typegen --prefix frontend
$env:VITE_BUILD_VERSION = git rev-parse HEAD
npm run build
npm run verify:worker
npm run check:migrations
npm run check:secrets
git diff --check
```

部署使用现有生产资源与 `--keep-vars`。部署号、提交号、HTTP 健康检查、静态资源 SHA-256 和精确恢复批次结果保存在主工作区忽略文件 `output/file-concurrency-release-20261007.json`。历史失败任务保持不可变，恢复使用既有管理员重试队列与检查点链接，只选择当前关联且仍因并发失败的阶段。

未进行浏览器测试。结果未知的请求保留保护，需原有人工确认流程，不能仅凭五分钟没有新日志放行。
