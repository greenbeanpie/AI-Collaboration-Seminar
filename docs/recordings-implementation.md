# 资料采集与会议导入交付记录

日期：2026-10-11。代码需进入 main；本次不推送、不部署、不调用真实模型。

## 已实施

- 资料导入增加录音、录像、拍照；先本地保存、预览，确认后上传。图片文件导入与本站摄像头策略同步开放。
- 网页音频为16kHz单声道WAV，视频运行时选择MP4/WebM；独立片段按五分钟或大小边界轮换。IndexedDB增量保存，恢复完整片段和音频尾段，损坏视频尾段单独导出。
- Windows采用Media Foundation，Android采用Camera2/AudioRecord/MediaCodec/MediaMuxer；使用本地文件流上传，不把整场文件传入JavaScript。Android前台服务提供停止通知，账号切换停止采集。暂停换设备、单会话、更新退出保护均已接入。
- 每场录制关联一份既有文档资料，片段序号从1开始。复用文件、来源版本、生命周期和供应商设置；上传失败可续传，无模型可保存原文件。
- 片段处理后分层汇总，保留不可变摘要版本、引用、中断和未覆盖范围。独立历史来源不因会议关联消失；详情分页加载。
- 新增0070录制会话与0071自动来源溯源迁移；OpenAPI及前端类型同步生成。没有修改历史迁移或生产数据。

主要代码位于 backend/src/api/recordings.ts、backend/src/services/recordings.ts、backend/src/services/recording-summary.ts，frontend/src/features/recordings，desktop/src-tauri/src/recording*.rs，以及desktop/android-plugin/src/main/java/cn/buwei/mobile/Recording*.kt和MediaTimelineBuffer.kt。完整清单可通过main中的提交差异核对。

## 已执行验证

| 验证 | 结果与边界 |
| --- | --- |
| 后端全量 | 159个测试文件、1453项通过；最后的来源绑定修复后10项录制专项测试重新通过 |
| 前端全量 | 158个测试文件、960项通过；整合修改后资料页与录制专项29项再次通过 |
| 类型、lint、契约 | 前后端类型检查、前端lint、OpenAPI导出/类型生成通过 |
| Windows媒体 | 合成AAC/M4A和H.264/AAC MP4连续生成两个片段，独立重新打开并核对轨道通过 |
| Windows真实设备短测 | 实际麦克风及摄像头均返回媒体样本；这不是后台、锁屏或长期稳定性证明 |
| 原生安全检查 | Rust测试及Clippy无警告；路径标识限制、活跃录制阻止更新/退出保护覆盖 |
| 浏览器短流程 | Chrome合成媒体与本地模拟服务：录音暂停/继续后保存两段，WAV预览46.106625秒；录像预览81.6105秒、640×360、无解码错误；拍照保存与JPEG预览 |
| 上传确认 | 浏览器录制/试听阶段服务写入0次，确认后才出现会话创建、文件上传、片段登记与完成提交；上述服务为模拟服务，后端由独立本地D1测试覆盖 |
| Android | ARM64/x86_64 release、Kotlin主代码与instrumentation编译、5项时间排序JUnit测试、现有密钥v2/v3签名和16KiB对齐校验通过 |
| 构建 | 前端生产构建、Windows x64 NSIS安装包、Android双架构APK；详见本地output/recordings交付文件及校验清单 |

## 明确未验证与延期项

- **按照用户最新要求，4小时连续录制验收延期，本次未执行。**不据此宣称长会议稳定性验收完成。
- 未连接Android实机；后台、锁屏、摄像头方向、强制终止恢复与A/V同步的实机验收待执行。iPhone Safari与手机Chrome短流程也未实机验收。
- Android原生录制不提供实时摄像头画面；可在完成采集后预览片段。Windows/Android的后台能力有实现，但不能从编译或短采样推断所有设备均通过。
- 未调用真实AI提供商；汇总与失败覆盖使用模拟模型验证。
- 未部署新前端或迁移。release安装包继续加载固定生产网址，因此安装新包并不会让尚未部署的新录制UI自动出现在生产页面。
- Windows本次构建为未签名安装包，不包含签名更新产物；Android复用既有签名密钥。

## 可复现验证

在仓库根目录运行前后端test/typecheck和前端lint/build。生产前端构建需设置VITE_BUILD_VERSION为当前Git提交SHA。

```powershell
npm run test --prefix frontend
npm run test --prefix backend
npm run typecheck --prefix frontend
npm run typecheck --prefix backend
npm run lint --prefix frontend
& "$env:USERPROFILE/.cargo/bin/cargo.exe" test --manifest-path desktop/src-tauri/Cargo.toml --lib
& "$env:USERPROFILE/.cargo/bin/cargo.exe" clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

真实设备短采样需显式运行忽略测试：cargo test --manifest-path desktop/src-tauri/Cargo.toml hardware_capture_smoke -- --ignored --nocapture。该测试访问本机麦克风与摄像头，不上传媒体。

浏览器合成媒体验收：运行node scripts/recording-browser-fixture.mjs，打开其输出的localhost地址。它生成临时页面，使用合成媒体与模拟服务，不访问真实项目；结束后按Ctrl+C自动清理临时入口。该夹具不进入生产构建。

Android验收入口、权限和恢复边界见desktop/android-plugin/RECORDING.md。后续生产发布需另行授权，并应用新迁移、发布前后端及核验线上能力；本次交付不等于线上发布完成。
