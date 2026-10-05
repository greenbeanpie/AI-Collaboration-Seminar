# 项目资料回收站与处理生命周期

## 使用与权限

“项目资料”中的文件库显示已保存、校验失败以及尚未完成上传的文件。文件移入回收站前有确认提示；负责人可管理项目文件，成员仅可删除/恢复自己上传的文件。普通/超级管理员的账户等级不扩大项目成员权限。粘贴与网页来源由负责人或创建者管理。

删除是可恢复的状态变更，不删除 D1 原行、R2 原文件、正文片段、要求集、材料版本、附件与引用历史，也没有永久清空入口。文件或来源恢复不会发起解析、OCR、要求提取或总结；已取消任务保持终态。人工再次开始处理会重新检查 AI 能力和项目权限。

相关来源当前及历史版本使用的原文件或 OCR 页图被回收时，来源一并隐藏。恢复依赖文件时，只有全部关联原文件/页图均退出回收站才恢复来源。已有引用仍展示原句/历史，并标记来源不可用；材料历史保留附件名称与 ID。

## API 和并发契约

- GET /api/v1/projects/{projectId}/files?deleted=false|true：分页文件库/回收站，包含 pending 上传，服务端返回 canDelete 与 lifecycleVersion
- DELETE files/{fileId}、POST files/{fileId}/restore：JSON {expectedLifecycleVersion}，返回受影响 source IDs
- GET sources?deleted=false|true：活动/回收来源；文件来源通过文件库管理
- DELETE sources/{sourceId}、POST sources/{sourceId}/restore：同一 CAS，只适用于粘贴/网页
- 删除与恢复分别递增 files.lifecycle_version 和所有受影响 sources.lifecycle_version，过期操作返回 409，原文件下载与来源操作在回收状态返回 404

0022_file_recycle.sql 仅添加软删除与生命周期字段/索引，无生产删除或现有内容改写。迁移后先发布后端，再发布前端。现有垃圾回收保留带数据库引用的回收对象；回收文件清空 gc_after，避免校验失败的原文件随后被既有隔离回收删除。

## 与其他来源工具的接入契约

来源版本 UUID 标识内容版本，不能独自证明资料仍可使用。新的工具读取、模型请求、异步结果和采纳应冻结 sourceLifecycleVersion，并在真正调用前/写入时核对：项目范围、sources.deleted_at IS NULL、来源生命周期一致、原文件 available 且未删除。可复用 backend/src/services/source-lifecycle.ts 及 source-inputs.ts。

createJobAndDispatch 冻结生命周期并在同一 D1 batch 中条件创建 job/outbox。删除原子取消 queued/running/waiting_input 任务并终止 outbox 派发；已开始的外部请求无法撤回。token 用量和调用状态保留为审计记录。所有解析、OCR、要求/总结阶段在调用与写入两端有生命周期及任务终态防线。解析输出采用生命周期版本化 R2 key，旧在途输出不覆盖恢复后的正文；历史片段不删除。

协作/项目 AI、要求驱动的分工与评审冻结来源生命周期；删除后禁止作为新输入，删除再恢复也不能复活原快照。已有材料正文和已确认人工工作继续保留。今后合入本地项目创建向导/文件工具草稿时应使用同一契约，不能只查版本 UUID 或客户端 canDelete。

## 验证边界

自动化验证使用本地 D1/R2 和受控模型 fixture，不创建生产测试项目、不删除生产资料、不调用付费模型。已有 in-flight 供应商调用仍可能产生费用，这是无法撤销的外部事实。

2026-10-02 本轮最终验证：后端 54 文件 / 537 测试、前端 60 文件 / 325 测试通过；双端类型检查、前端 lint/生产构建、Service Binding 验证、production 静态预检通过。后端全量测试以 --maxWorkers=2 重跑，默认并行曾被内存限制终止；既有 workerd/Workflow 收尾 RPC、DNS 告警仍在。提供 scripts/verify-file-recycle-ui.cjs 的 loopback-only 页面 fixture，但当前云端 Chromium 因 socket EPERM 无法启动，浏览器截图/视觉验收未完成。测试与脚本不调用生产业务或真实付费模型。
