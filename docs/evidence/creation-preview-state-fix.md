# 单设备创建项目状态错误修复

日期：2026-10-03，Asia/Singapore。

截图错误为 INVALID_STATE，表示最终创建时草稿状态未满足确认条件，不意味着使用了多个设备。只读检查生产草稿曾观察到 revision=2、previewRevision=2、预览 JSON 存在而 previewState=failed，稍后该草稿又保存为 manual/ready；未修改该真实草稿或文件。截图未展开原始 message，因此没有将某个后台异常断言为该次请求的唯一原因。

已确认并用测试复现两种同设备缺陷：

- 预览成功保存为 ready 后，读取返回详情失败，原来的异常处理仍可将已发布预览写成 failed。重复或迟到的后台执行也可能改坏已发布状态。
- 重新生成时查询缓存保留第一次 ready 结果，非模板预览的数值 revision 不变；过期轮询结果可以让界面过早回到可提交状态。最终提交原来没有再次读取服务端状态。

修复范围：

- 成功发布及失败记录均校验运行状态、草稿版本及本轮 attempt；迟到错误不能覆盖已成功、已取消或已提交的草稿。
- 轮询携带请求代次并响应取消，过期结果不覆盖新操作。
- 提交前绕过 HTTP 缓存读取最新草稿；失败、未保存、运行中或已替换预览须重新核对，不自动创建、不自动调用 AI。
- 增加可选 previewAttemptId / expectedPreviewAttemptId，事务同时锁定预读的预览标识与正文，旧客户端保持兼容。
- 明确区分 PREVIEW_FAILED、PREVIEW_NOT_READY、PREVIEW_OUTDATED、PREVIEW_REPLACED。失败时保留资料、目标及手动任务。

验证：后端全量 83 文件/756 项通过；修复工作区前端 89 文件/479 项通过；保留当前线上帮助/移动端界面的隔离发布快照 90 文件/489 项通过；两端类型检查、前端 lint、生产构建通过。包含发布后读取失败、失败预览禁止提交、同版本预览替换、事务竞态及重新生成复用旧查询缓存的回归。

改动文件：backend/src/services/creation-drafts.ts、backend/src/api/creation-drafts.ts、frontend/src/pages/CreateProjectPage.tsx、frontend/src/pages/project-wizard.ts、frontend/src/api/client.ts；同步生成 OpenAPI/类型，并更新前后端回归测试。scripts/verify-creation-preview.mjs 可进行独立 HTTP 验收，--production 需要显式指定；只使用手动预览，无外部模型调用，测试项目随后归档并撤销测试会话。

无数据库迁移。保留主工作区其他未提交改动；前端发布使用当前线上界面的隔离快照叠加本次修复，后端从已核对生产版本的源代码更新。
