# Workflow 续跑队列屏障（subrequest depth 修复）

生产错误 `The request exceeded the maximum Workers subrequest depth. (10034)` 的根因不是 Cloudflare Workflows 的 step 数上限，而是续跑中继逐层同步创建下一实例：

`Workflow N -> continueExecutionSlice -> AGENT_WORKFLOW.create -> Workflow N+1 -> ...`

草稿预览分段同构：`enqueueDraftPreviewSegment -> dispatchDraftPreview -> AGENT_WORKFLOW.create`。Cloudflare 限制单条 Worker 调用管线最多 32 次调用，长 AI 任务在几十个续跑分段后必然失败。本补丁以异步屏障打断这条递归管线，已随基线 `08309bd` 之后的提交合入 main 并部署生产（2026-10-07）。

## 补丁改动

持久层不变：`ai_execution_slices` / `draft_preview_dispatches`（D1）仍是唯一的续跑事实源。新增 Cloudflare Queue 仅作为快速唤醒信号：

1. Workflow 写入下一条 pending D1 行，发送一条 Queue 消息，然后退出。
2. Queue 消费者运行在独立 Worker 调用中，由它创建下一个 Workflow 实例，从而切断递归管线。
3. 队列发送/投递不可用时，既有的分钟级恢复 cron 仍会找到 pending 行并派发——队列是加速器而非事实源。
4. 草稿预览续跑使用同一屏障（`dispatchDraftPreviewById` 按 `instance_id` 派发 pending 行）。
5. 消费幂等：至少一次投递语义下，仅当活动分片 `status='pending'` 且 `slice` 与消息一致才派发；生产者只产生内部消息，畸形消息直接 ack 丢弃而不是无限重试；处理异常按 5 秒延迟 retry。
6. `AI_CONTINUATION_QUEUE` 在代码中是可选绑定（`env.ts` 类型可选），缺失时回退 cron。

涉及文件：`backend/src/env.ts`、`backend/src/index.ts`（queue 消费者）、`backend/src/services/continuation-queue.ts`（新文件，生产者）、`backend/src/services/ai-execution-slices.ts`、`backend/src/services/draft-preview-jobs.ts`、`backend/src/workflows/ai-job.ts`、`backend/wrangler.jsonc`（production `queues` 绑定）、`backend/test/116-independent-workflow-slices.test.ts`。

## 应用方法

补丁以 `workflow-subrequest-depth-fix.patch` 形式分发，针对基线 `08309bd89ead10b54134bf8a7486a3e62cac7346` 生成。再次移植或复盘时按以下步骤：

```bash
git checkout main && git pull --ff-only
# main 已前移时：在基于基线的临时分支上应用，再整体 cherry-pick/合并
git apply --check workflow-subrequest-depth-fix.patch
git apply workflow-subrequest-depth-fix.patch
```

实测经验（正常路径之外必看）：

- **该 patch 文件本身是损坏的**：部分 hunk 头行数与内容不符（例如 `@@ -51,6 +52,11 @@` 的 hunk 实际只有 3 行旧内容 + 5 行新增），裸 `git apply` 报 `corrupt patch at :101`。修复方法：`git apply --recount workflow-subrequest-depth-fix.patch`，让 git 重算每个 hunk 的行数后再应用。先跑 `git apply --recount --check` 验证。
- patch 的 `index 0000000..0000000` 行没有 blob 哈希，因此 `git apply -3`（三方合并）不可用；冲突时只能人工对齐上下文。
- 应用后 `backend/test/116-independent-workflow-slices.test.ts` 有两处 TypeScript 错误：`vi.fn(async()=>({}))` 的参数元组是空类型，对其 `mock.calls` 取 `call[0]` 不合法（TS2532/TS2493）。修法是给 mock 显式声明参数类型：`vi.fn(async(_input:{id:string;params:{jobId:string;slice?:number}})=>({}))`。此修正已随补丁一起提交。
- 若补丁文件曾被误提交进仓库（而不是应用到代码），处理顺序是：先 `git apply` 应用到工作区，再 `git revert` 那个只含 patch 文件的提交（revert 只删该文件，与已应用的代码改动无冲突），最后把代码改动单独提交。需要取回补丁内容时用 `git show <误提交>:workflow-subrequest-depth-fix.patch`。

部署前置：`backend/wrangler.jsonc` 的 production 环境声明了 `queues` 绑定，**队列资源必须先于 deploy 存在**，否则部署时绑定校验直接失败：

```bash
npx wrangler queues create greenbp-team-office-ai-continuations
```

## 紧急模式（无队列资源）

代码有意把 `AI_CONTINUATION_QUEUE` 当作可选。如需避免创建队列，只删除 `backend/wrangler.jsonc` 中新增的 `queues` 块即可部署。递归修复仍然成立：续跑保持 pending，由每分钟的恢复 cron 在全新的 scheduled 调用中派发。代价是每次续跑最多等待约一分钟，长任务明显变慢——只作为紧急正确性修复，不是首选稳态配置。

## 测试

单元与集成（零模型费用，全部本地）：

```bash
cd backend
npm run typecheck
npx vitest run test/116-independent-workflow-slices.test.ts   # 6 用例，含「屏障不可用时不递归创建下一实例」
npm test                                                       # 全量（当前 145 文件 / 1328 用例）
```

116 号用例的关键断言：屏障不可用时 `AGENT_WORKFLOW.create` 不被同步调用、分片保持 `pending`、`recoverExecutionSlices`（cron 路径）之后才创建 `${jobId}-s1` 且只创建一次；以及 >16 分片在独立实例中确定性推进、恰好两次付费模型调用、工具结果无重复读取。

生产手动验收（需要一个以前能推进到 ~25-30 段以上的长任务）：

- 不再出现 `maximum Workers subrequest depth` / `10034`；
- 同一业务 job ID 跨分片持续 running；
- `ai_execution_slices.slice` 持续递增；
- 每个下一分片由 Queue 消费者或 cron 调用创建，而不是由前一个 Workflow 调用创建；
- 重试后无重复模型调用（确定性实例 ID 与既有 D1 守卫保持不变）；
- 队列发送暂时不可用时，任务停为 pending 等待 cron 派发，而不是把业务 job 判为失败。
