# 上传文件自动处理与正文提取入口

## 问题与修复

成果附件、来源正文属于不同的数据链。旧任务附件常只有文件关联，材料页没有补提取入口；来源解析完成也不会自动成为可评分成果。

- 文件保存、分片完成、材料关联、项目开启 AI 和每分钟补处理接入同一持久化处理服务。文件生命周期与阶段领取去重，失败保留原文件，显式重试已有失败阶段。
- 自动处理同时检查项目和全局 AI 开关。DOCX/XLSX/PPTX 在服务端受限解压并读取 XML；PDF/TXT/Markdown 沿用正文管线，图片和音视频复用既有识别流程。
- 上传初始化接受可选用途，任务成果提前声明 output，避免上传与登记之间误提取评分要求。成果及背景仅总结，参考来源提取待确认要求。
- 原文同步到新材料版本，保留历史与手写正文。音视频总结不作为材料原文；派生成果随父材料用途、附件移除及归档退出当前评分范围。
- 公共文件、来源、材料附件与旧任务成果均有可见处理操作和分阶段状态。扫描 PDF 需打开页面准备图片，上传后 OCR 继续在后台；未新增云端浏览器渲染。
- 接口：GET/POST `/api/v1/projects/{projectId}/files/{fileId}/processing`；POST 校验文件生命周期与管理权限。接口契约已重新生成。
- 增量迁移：`0066_file_processing.sql`，新增处理绑定、派生文件关系及上传用途。没有重置数据或替换既有云资源。

## 验证

可复现命令：

```powershell
npm run typecheck --prefix backend
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm test --prefix backend -- --run test/141-file-processing-api.test.ts test/139-file-processing.test.ts test/143-office-text.test.ts test/139-office-documents.test.ts test/70-sources-parse.test.ts test/98-source-lifecycle-processing.test.ts test/134-task-files.test.ts test/134-multipart-races.test.ts test/102-project-simplification.test.ts test/101-profile-resource-simplification.test.ts test/74-source-summary.test.ts
npm test --prefix frontend -- --run
cargo test --locked --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --locked --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings
node --test desktop/scripts/release-manifest.test.mjs desktop/scripts/update-smoke-routes.test.mjs
node --check desktop/scripts/android-upgrade-smoke.mjs
npm run verify:worker
npm run check:secrets
```

后台相关 11 文件 122 用例通过；正文终态修改后相关 3 文件 35 用例再次通过。前端全量 155 文件 931 用例通过，用途提前声明后相关 5 文件 40 用例通过。Rust 单元测试 10 项、桌面发布脚本 4 项通过；类型检查、lint、Workers 校验及生产部署 dry-run 通过。

现有解析与分片竞态测试的 Worker teardown 会输出 RPC dispose／request stream disconnected 诊断；测试退出码为 0，未忽略失败断言。没有浏览器测试、ADB/CDP 验收或重新生成原生安装器。Office 日期格式、备注、图片等不能可靠还原的内容保留解析警告。

## 历史工作区整合与保全

用户明确要求收拢仓库全部历史 worktree／分支。Android 与 Windows 有效代码按段合并，保留主分支较新的权限、分页、网络读取与离线保护；Android 升级 smoke 的未提交增强也已纳入并修复监听清理。

其余历史分支经 patch 等价性与代码核对，已被当前实现覆盖的补丁保留祖先关系，不重复应用旧代码。特别核对 `c88049b0`、`96e1c7b1`、`b3082657`、`070b0e5d`，当前实现已包含其事务、账户 epoch、序列化保留与 SDK 配置保护。旧 Office 分支的迁移和实现已被较新主分支覆盖，不重放旧迁移编号。

清理前在主工作区 Git 忽略目录 `output/worktree-preservation-20261007/` 保全完整 Git bundle、各工作区 HEAD、未提交二进制 patch、安装包、签名、私钥、备份与验证日志；私钥不进入 Git。主工作区 `.local-secrets/` 保留现有更新签名材料。已有 stash 保留。

发布提交、部署版本、迁移书签、资源哈希与生产任务状态核验保存在主工作区 ignored `output/file-processing-release-20261007.json`；最终交付说明报告实际部署和清理结果。
