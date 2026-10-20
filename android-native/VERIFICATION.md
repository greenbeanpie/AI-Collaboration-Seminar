# 原生 Android 迁移预览版验证报告

## 当前交付：0.2.5-preview（2026-10-20）

本轮按 [双端原型](../docs/ui-prototypes/buwei-dual-platform-prototype.html) 的移动端设计新增「舒展蓝」，保留「经典绿」为默认。入口：**我的 → 外观 → 主题设计 → 舒展蓝**。设计与明暗模式独立，可选择跟随系统、浅色或深色；写入本机 DataStore 后立即应用，重新打开恢复。未知/旧偏好保持经典绿，保存失败保留原选择并允许重试。AI 引用偏好、现有账号及业务接口保持原规则。

### 设计与代码

- 提取原型的浅色 `#2563EB` 蓝、`#F5F7FB` 手机底色、白色卡片、`#6D28D9` 紫色辅助色；深色使用 `#161B26` 底色、`#222A3B` 表面及原型悬停蓝 `#60A5FA`，提高小字号可读性。常用前景/背景对比度均检查 ≥4.5:1。
- 手机卡片圆角 15dp，控件层级 7/10/15/20/24dp；标题加重、正文增加行距，使用 Android 系统字体和可缩放字号。不引入字体包、图片背景、模糊层、WebView 或额外依赖。这是现有原生界面的主题扩展，没有把原型中的演示数据写入业务。
- [PrototypeTheme.kt](app/src/main/java/cn/buwei/nativeapp/PrototypeTheme.kt)集中配色、圆角、字体；[NativeTheme.kt](app/src/main/java/cn/buwei/nativeapp/NativeTheme.kt)保存两项独立偏好并保留旧设置；[外观设置](app/src/main/java/cn/buwei/nativeapp/NativeReferencePreferences.kt)显示可选择预览与错误反馈；[MainActivity](app/src/main/java/cn/buwei/nativeapp/MainActivity.kt)全局应用并同步状态栏/导航栏明暗，读取保存值后再展示界面。

### 安装包与验证

- [签名 APK 0.2.5-preview](../output/android-native/buwei-native-0.2.5-preview-release.apk)，versionCode 7、5,586,133 bytes；复用原签名，v2/v3 验证通过。[构建元数据](../output/android-native/release-artifact.json)源提交 `fc5f5f5d6fc7f6243f318b586da7de335efd5b06`，`sourceTreeDirty=false`；后续仅更新文档。
- SHA-256：`a3733838f3b369221f6252cfa2a45333ae2e4c2b7cf748e3d81425c4dc74e181`。另检查最终 APK DEX 中含新增主题名称与错误反馈文字，避免只验证 Debug。
- [main Release 构建](../output/android-native/tests/0.2.5-main-release.log)通过：**165 项 JVM 测试**（新增 5 项主题/兼容/对比度规则）、R8、资源压缩和签名。[Lint](../output/android-native/tests/0.2.5-lint-debug.txt)：0 errors、1 项既有 BouncyCastle EST 告警，`-checkdiscard` 继续保证未保留 EST。工具链弃用提示仍存在。
- API 37 手机[最终 8 项设备测试](../output/android-native/tests/0.2.5-theme-device.log)全部通过，16.760 秒：主题切换立即改变全局主色、深浅色与经典绿互换、模式独立保存、DataStore 关闭重建后恢复、非法设计值不覆盖原值、保存失败与重试、280dp/2 倍字体无横向裁切，以及原有 4 项 AI 引用偏好回归。使用隔离本机偏好和测试宿主，不涉及生产登录或业务写入；本轮未重跑完整业务套件，也未启动 BlueStacks 平板。
- 已查看原生截图：[浅色](../output/android-native/0.2.5-theme/prototype-theme-light.png)、[深色](../output/android-native/0.2.5-theme/prototype-theme-dark.png)、[大字体](../output/android-native/0.2.5-theme/prototype-theme-large-font.png)。设置可纵向滚动，卡片与文本保持在宽度内；截图为 Compose 测试宿主，不能代表所有厂商设备和业务页面。
- 最终签名包覆盖安装后，[初始页启动检查](../output/android-native/0.2.5-theme/smoke-20261020-112422/report.json)通过，默认仍是经典绿；截图已查看。没有登录真实账户，因此不声称签名 Release 内已人工走完授权后的外观设置流程；设置交互由上述 Debug 实际组件验证。
- 本轮没有改动/部署后端或网页，没有付费模型调用。测试后已关闭临时无窗口手机模拟器，保留旧应用和数据；平板保持关闭。整体迁移的真实授权与外部服务边界沿用下方历史报告和[验收清单](docs/ACCEPTANCE.md)。

## 历史交付：0.2.4-preview（不代表当前状态）

本轮补齐文件/来源处理状态、派生页归属、录制元信息与云端详情，并修复自定义来源标题破坏原文件预览的问题。业务继续使用现有后端；没有新增替代接口或独立账号体系。真实授权、外部服务及物理设备验收仍未完成，不声明全量迁移目标已达成。

### 改动与文件

- 文件与来源仅在前台轮询活动处理，普通网络错误标记旧快照，401/403/404 清除服务端内容。文件独立总结/要求阶段失败也允许按已有身份重试；暂停作业阻止重复创建；展示音频质量、回退权限及不完整摘要。实现：[DataWorkspaceProcessing](app/src/main/java/cn/buwei/nativeapp/features/DataWorkspaceProcessing.kt)、[状态规则](app/src/main/java/cn/buwei/nativeapp/features/NativeProcessingStatus.kt)。
- 扫描页上传携带 `derivedFromFileId`，保持原文件贡献人和派生归属；上传 manifest 隔离父文件身份。准备前核对来源与固定版本文件；新来源本机恢复保存已上传原文件 ID，旧草稿只读恢复已确认身份，不能据此跳过未知分片。实现：[PDF 页准备](app/src/main/java/cn/buwei/nativeapp/media/PdfPageImages.kt)、[传输](app/src/main/java/cn/buwei/nativeapp/media/AttachmentTransfer.kt)、[新增资料](app/src/main/java/cn/buwei/nativeapp/features/DataWorkspaceIntake.kt)。
- 录制状态快照可观察暂停/继续/停止，控制可换行；本机状态与磁盘轮询限制在前台。标题及贡献人可编辑，首次请求前冻结参数，未知结果重试沿用原身份；旧录制继续用原普通 manifest 和实际分片续传。当前材料接入云端会议、片段分页、固定来源、原文件与明确确认后重试；轮询只刷新已加载页，丢弃旧会话响应。实现：[MediaWorkspace](app/src/main/java/cn/buwei/nativeapp/media/MediaWorkspace.kt)、[RecordingStore](app/src/main/java/cn/buwei/mobile/RecordingStore.kt)、[云端详情](app/src/main/java/cn/buwei/nativeapp/media/NativeRecordingDetail.kt)、[资料入口](app/src/main/java/cn/buwei/nativeapp/features/DataWorkspace.kt)。
- 来源预览按现有文件列表接口精确读取真实文件名，标题不再决定预览格式；元信息身份不符、归档/删除或拒权时不下载。中文长文件名按 UTF-8 字节截断并保留扩展名，附件状态按账户/epoch/目标隔离。实现：[AttachmentActions](app/src/main/java/cn/buwei/nativeapp/media/AttachmentActions.kt)。

### 最终签名包及验证范围

- [Release APK](../output/android-native/buwei-native-0.2.4-preview-release.apk)：5,586,133 bytes（约 5.33 MiB），versionCode 6；独立包名 `cn.buwei.mobile.nativepreview`，最低 API 26，ARM64 / x86_64。
- SHA-256：`b83ae00af8e19e4c7ac9f8fa03a2d9576a3cc590818903454dde20cd1c49ae28`。复用原签名，v2/v3 校验通过。
- [历史构建元数据](../output/android-native/0.2.4-release-artifact.json)：源提交 `63707ecb3c475fcc69a75d6efc6e3d7b3bb77ecb`，`sourceTreeDirty=false`；最后仅更新报告。已合并同期 Windows 文档/资源审计改动，没有覆盖并行成果。
- [主分支最终构建](../output/android-native/tests/0.2.4-final-main-release.log)通过：**160 项 JVM 测试**、Lint、R8、资源压缩和签名。[Lint](../output/android-native/tests/0.2.4-lint-debug.txt)为 0 errors、1 项既有 BouncyCastle EST 告警；Release `-checkdiscard` 确认 EST 未保留。Gradle/JDK/第三方 protobuf 弃用提示仍存在，未隐瞒或全局压制。
- 完整基础 instrumentation **161 项**（源 `4878be75`，含本轮处理与录制、尚未加入最后的原文件名修复）：[API 37 手机](../output/android-native/tests/0.2.4-full-phone.log)161/161，通过，356.370 秒；[API 33 平板](../output/android-native/tests/0.2.4-full-tablet.log)160/161，通过 160、失败 1，431.827 秒。失败与修复证据见下文，不能写成最终全套双端通过。
- 最后原文件名修复及测试时钟修正后，**30 项相关回归双端全部通过**：[手机](../output/android-native/tests/0.2.4-final-related-phone.log)70.417 秒；[平板](../output/android-native/tests/0.2.4-final-related-tablet.log)73.045 秒。包含真实 PDF 的无扩展标题/错误 MP3 标题预览、元信息身份不符不下载、拒权去除旧导出入口；录制 14 项；资料工作区 6 项及拒权读取 6 项。不是最终 165 项全套重跑。
- 更早的处理/上传相关 **26 项双端通过**：[手机](../output/android-native/tests/0.2.4-processing-phone.log)49.183 秒、[平板](../output/android-native/tests/0.2.4-processing-tablet.log)53.028 秒；包括派生文件归属、恢复上传身份、前后台处理轮询、失败重试及撤权。上述自动化均为 Debug、隔离账户与本机模拟接口，不代表生产账号或 R8 后全部业务验收。
- 311 个生成契约一致，路由检查 [11 项通过](../output/android-native/tests/0.2.4-routes-tests.log)。[最终静态请求检查](../output/android-native/final-routes-0.2.4.json)：189 个绑定、138 个独立操作、错误 0，另有 189 个动态绑定未被静态验证。不能换算成业务覆盖率或迁移完成率。
- 最终签名包覆盖安装后，[手机启动检查](../output/android-native/0.2.4-phone/smoke-20261020-003948/report.json)与 [localhost:5555 平板启动检查](../output/android-native/0.2.4-tablet/smoke-20261020-003948/report.json)通过，UI WebView 节点为 0；[同一 APK 的 DEX 扫描](../output/android-native/0.2.4-dex/smoke-20261020-003954/report.json)未发现 WebView 引用。两张最终未登录页截图均已查看，无裁切/横向溢出。未卸载旧应用或清除用户数据。

### 平板失败的诊断与修复

第二页片段轮询测试在平板上等待 15 秒仍未更新；单独复现同样失败，保留[初始诊断](../output/android-native/tests/0.2.4-recording-diagnostic-tablet.log)、[带时钟诊断](../output/android-native/tests/0.2.4-recording-diagnostic2-tablet.log)与[实际请求/语义树](../output/android-native/tests/0.2.4-recording-clock-diagnostic-logcat.log)。页面生命周期为 RESUMED，仍显示“处理中”，只有初始详情与第二页读取；Compose 虚拟时钟仅推进 **4880 ms**，尚未到 5000 ms 轮询延迟。此时延长真实等待或修改生产间隔均不对症。

测试现明确推进 Compose 时钟 5000 ms 后再等待网络与 UI 更新；延迟切换会话测试也显式推进同一轮询间隔，保留全部页数、状态与身份断言，并保留失败诊断。没有修改业务轮询实现、增加时限或忽略异常。最终两端 30 项相关组均通过；它证明测试在触发既定轮询后更新已加载页，不代表所有设备/负载下的时序问题均已排除。

### 资源与剩余验收

[最终 Release 五轮采样](../output/android-native/0.2.4-performance/benchmark-20261020-004009-emulator-5556/report.json)核对已安装 APK 哈希一致且非 Debug。API 37 模拟器未登录页：进程冷启动 TotalTime 中位数 **452 ms**（381–499），PSS 中位数 **28,055 KiB**（27,902–28,136），短窗口空闲 CPU 中位数 **0%**（0–0.327%）。仅 `-NativeOnly`，未清理存储/编译缓存，非真实业务、耗电或与旧版的可比实验。

用户暂不方便完成 Turnstile，本轮没有再次尝试生产登录，没有调用付费模型、OCR/语音、发送 FCM 或修改生产业务。真实授权回调/退出撤销、FCM 实际投递、模型/语音、DSH、四小时物理录制及可比业务资源负载仍按[验收清单](docs/ACCEPTANCE.md)完成；不能以代码入口、模拟测试或旧发布记录代替。

测试和采样结束后已按用户要求关闭两台模拟器：[退出记录](../output/android-native/tests/0.2.4-emulators-shutdown.json)。手机 emulator/QEMU 与平板 HD-Player 目标进程均已退出，ADB 设备列表为空；保留应用及用户数据。源码、报告和复现命令保留，见 [README](README.md)。

## 历史交付：0.2.3-preview（不代表当前状态）

本轮继续按网页端实际交互核对缺口，补齐讨论、资料正文与首页任务入口；仍对接既有后端，真实账户授权和外部服务验收尚未闭环，不声明全量迁移目标完成。下方各旧版本仅作为历史记录。

### 本轮改动

- 首页待响应事项移除 30 条上限，用惰性列表展示全部已加载记录，直接打开指定任务；归档视图增加任务列表和详情入口。保留项目分页及统计完整性提示。
- 资料当前正文和历史版本均优先渲染该版本 canonical `doc`，保留表格、行内格式及原生内部链接，Markdown 仅作旧响应回退；合法空文档不会恢复旧 Markdown。版本比较读取 canonical 正文，并明确提示纯格式/结构差异。
- 新增材料讨论，任务讨论复用同一流程：现有项目 comments 接口、分页、4000 字输入、账户/项目/目标隔离的持久本机草稿。待同步或结果不明时保留草稿及原操作身份，禁止再次创建；不把 queued 当成已发送。发送前释放焦点并收起键盘。
- 资料详情、材料、来源版本、目录原文和通用分页在明确 401/403/404 后清除相应内存内容；普通读取失败保留并标记上次内容。历史版本成对读取后才更新，不在新版本失败时继续显示旧选择。

主要代码：[首页](app/src/main/java/cn/buwei/nativeapp/features/ProjectDashboardWorkspace.kt)、[资料](app/src/main/java/cn/buwei/nativeapp/features/DataWorkspace.kt)、[版本与原文](app/src/main/java/cn/buwei/nativeapp/features/DataWorkspaceReference.kt)、[共用讨论](app/src/main/java/cn/buwei/nativeapp/features/MaterialDiscussionWorkspace.kt)、[任务接入](app/src/main/java/cn/buwei/nativeapp/features/TaskWorkspace.kt)、[分页读取](app/src/main/java/cn/buwei/nativeapp/features/TaskWorkspaceSupport.kt)。对应测试位于 JVM / androidTest 的 Dashboard、DataDocumentParity、DataReadAccess、MaterialDiscussion、TaskDiscussion、DataWorkspace 和 NativeBusiness 类。

### 签名包与实际验证范围

- [Release APK](../output/android-native/buwei-native-0.2.3-preview-release.apk)：5,553,365 bytes（约 5.30 MiB），versionCode 5，独立包名 `cn.buwei.mobile.nativepreview`，Android 8+、ARM64 / x86_64。
- SHA-256：`33fe72775624045ca5933573938a6f53df8f468e73f5504de74802d5fe925a92`。
- [历史构建元数据](../output/android-native/0.2.3-release-artifact.json)：源提交 `a063621d2710843a2ddea47aff6e331a415fbc17`，`sourceTreeDirty=false`；后续仅调整测试及文档，生产源码未变。复用原有签名，v2/v3 验证通过。
- [主分支 Release 构建](../output/android-native/tests/0.2.3-main-release.log)通过：148 项 JVM 测试、Lint、R8/资源压缩、签名。Lint 为 0 errors、1 项既有 BouncyCastle EST 依赖告警，`-checkdiscard` 检查未保留 EST；工具链弃用提示仍存在。
- 同轮基础完整 instrumentation 123 项：[API 33 平板](../output/android-native/tests/0.2.3-full-tablet.log)全部通过，333.653 秒；[API 37 手机](../output/android-native/tests/0.2.3-full-phone.log)122 项通过、1 项聊天等待失败，342.107 秒。该完整套件发生在最后的讨论共用调整之前，不能写成最终全套双端通过。
- 最后针对受影响的 5 个测试类（材料讨论 9、任务讨论 11、任务工作区 8、NativeBusiness 7、canonical 资料 5）完整执行 **40 项相关回归**：[手机 40/40](../output/android-native/tests/0.2.3-related-phone.log)，97.289 秒；[平板 40/40](../output/android-native/tests/0.2.3-related-tablet.log)，109.937 秒。包含真实任务讨论入口、失败/queued 保稿、跨目标/账户隔离及修正后的对话轮询；不是最终全套复跑。其余读取拒权与首页用例见上述基础完整记录。全部为 Debug、隔离账号和本机模拟服务，不代表生产账户或 R8 下全部业务验收。
- 路由检查 11 项通过，311 个生成契约一致；[静态请求结果](../output/android-native/final-routes-0.2.3.json)为 185 个绑定、135 个独立操作、错误 0，另有 185 个动态绑定未由静态检查验证。不能换算为业务完成率。
- 整合主分支同期 Windows 授权扩展后，后端 [native-auth 10 项](../output/android-native/tests/0.2.3-auth-backend.log)、网页 [授权页 14 项](../output/android-native/tests/0.2.3-auth-frontend.log)及两端类型检查通过。Android 仍使用原默认授权客户端。本工作流没有部署这次并行扩展或应用新增 0081 迁移，不能据源码推断其生产状态。
- 最终签名包已覆盖安装到手机和平板 `localhost:5555`：[手机冒烟](../output/android-native/smoke-20261020-000624/report.json)、[平板冒烟](../output/android-native/smoke-20261020-000951/report.json)通过，UI WebView 均为 0；[同一 APK 的 DEX 扫描](../output/android-native/smoke-20261020-000315/report.json)引用为空。两张最终登录页截图已查看，无裁切或横向溢出。没有卸载旧应用或清理用户数据。

### 失败诊断与修复边界

先前源文档测试同时提供空 canonical doc 和非空 Markdown，却要求旧 Markdown 差异，已将 fixture 的 canonical 正文修正一致；空文档不恢复旧文字另有独立回归。新增来源拒权 fixture 最初缺少处理状态的必需 summaryRevision，补齐后通过，未删减断言。

手机聊天等待失败的原诊断又在 `printToString()` 等待空闲时抛错，覆盖最初证据，已改为安全采集。模拟作业“完成”原本依赖虚拟化卡片触发 job GET，而测试在答案未生成时不断滚动查找。现在显式显示一次作业卡片，确认第一次 GET 后允许模拟完成，等待后续真实轮询和答案响应，再定位答案；不增加超时、不忽略异常、不修改生产实现。最后两台设备相关组均已通过；这证明修正步骤下的流程，不宣称任何潜在 Compose 间歇问题均被排除。

平板第一次 40 项相关组在第 39 项采集截图时中断，不能计为通过。[崩溃记录](../output/android-native/tests/0.2.3-tablet-screenshot-crash.log)显示 shell `am instrument` 进程在 BlueStacks 的 `lib_renderControl_enc.so` / gralloc / ScreenCaptureResults 路径 SIGSEGV，随后 UiAutomation 断连。新增 canonical 截图改为显式参数 `-e captureCanonical true`，正常回归不强制截图；保留所有功能断言。重跑 40 项全部通过，原[中断日志](../output/android-native/tests/0.2.3-related-tablet-interrupted.log)保留。图形驱动问题不代表原生业务断言成功，也不能当成真实手机稳定性证据。

[当前正文手机样本](../output/android-native/tests/0.2.3-canonical-phone.png)、[历史正文手机样本](../output/android-native/tests/0.2.3-history-phone.png)和此前成功采集的平板样本已查看，确认正文、下划线与表格单元格可读、内部链接通过原生路由。它们为隔离测试宿主截图，不能替代完整应用的系统栏、无障碍或所有布局验收。

### 资源采样与剩余验收

[最终 Release 五轮原始采样](../output/android-native/benchmark-20261020-000718-emulator-5556/report.json)核对已安装哈希一致，非 Debug。API 37 模拟器未登录页：进程冷启动 TotalTime 中位数 **557 ms**（508–837），PSS 中位数 **28,057 KiB**（27,913–28,089），短窗口空闲 CPU 中位数 **0%**（0–0.327%）。使用 `-NativeOnly`，没有操作旧应用；未清理存储或编译缓存，主机有并行模拟器负载。不能据此声称真实业务耗电、更快可交互时间或相对旧版的资源节省比例。

用户暂不方便完成 Turnstile，本轮没有再次尝试生产登录，也未调用付费模型、OCR/语音、发送 FCM 或修改生产业务数据。真实授权回调/退出撤销、FCM 实际投递、模型/语音、DSH、四小时物理录制及可比业务负载等仍按 [验收清单](docs/ACCEPTANCE.md) 独立完成。原有 0078–0080 发布与备份记录见历史报告；不将过去部署记录等同于当前全部源码已部署。复现命令见 [README](README.md)。

## 历史交付：0.2.2-preview（不代表当前状态）

当前版本继续使用现有后端与账号体系。原生业务界面使用 Kotlin / Compose / Material 3；完整迁移目标仍需完成真实授权和外部服务验收，不能以接口数量或模拟测试代替。

### 安装包与验证结果

- [签名 Release APK](../output/android-native/buwei-native-0.2.2-preview-release.apk)：5,536,981 bytes（约 5.28 MiB），versionCode 4，独立包名 `cn.buwei.mobile.nativepreview`。
- SHA-256：`91e1dc28ef3fe665be28ba31b611d34de49e4bea2f5a75679b91ba313bc7518b`。
- [历史构建元数据](../output/android-native/0.2.2-release-artifact.json)：来源提交 `ba8857a370339c4a0347ebee9705afcf2feb4fb2`，`sourceTreeDirty=false`。后续修改仅涉及验证脚本和文档，无需重建 APK。复用已有签名，v2/v3 校验通过。
- [主分支 Release 构建](../output/android-native/tests/0.2.2-main-release.log)通过：143 项 JVM 测试、Lint、R8/资源压缩与签名。Lint 为 0 errors、1 项既有 BouncyCastle EST 依赖告警，未打包的 EST 代码由 `-checkdiscard` 检查；工具链仍有弃用提示。
- 完整 instrumentation：API 37 手机 [101 项通过](../output/android-native/tests/0.2.2-phone.log)，220.591 秒；API 33 平板 `localhost:5555` [101 项通过](../output/android-native/tests/0.2.2-tablet.log)，270.002 秒。使用本机模拟服务与隔离账号，未访问生产业务。测试业务源码为 `2ba5f6ee`；最终 APK 其后仅改登录说明、文档与测试，最终登录页另用签名包冒烟核对。
- 最终签名包在[手机](../output/android-native/smoke-20261019-233850/report.json)和[平板](../output/android-native/smoke-20261019-234424/report.json)初始登录页冒烟通过，UI WebView 节点均为 0；同一哈希 APK 全部 DEX 未发现 WebView 引用。两张最终截图均已查看，无裁切或横向溢出。原应用和用户数据保留。
- 路由检查 11 项通过；[静态结果](../output/android-native/final-routes-0.2.2.json)为 184 个静态绑定、134 个独立操作、错误 0，另有 186 个动态绑定未被静态检查验证；311 个生成契约一致。这些数量不代表全量业务完成率。

### 本轮业务改动与修复

- 富文档直接渲染原始 JSON，保留行内格式、换行、列表、表格单元格和固定引用；完整导出预览按有限文本块展开，支持刷新和失败恢复。
- AI 失败作业在确认及重新核对状态后恢复；任务建议支持逐条选择、显式空选择、过期修订与冲突保留，反馈使用实际冻结版本及历史。
- 私密问询固定点击时已展示消息，去重并每批最多 200 条；失败停止，由用户明确继续，区分处理数与实际新增已读数。
- AI 引用标识按账户保存显隐；输入标签和徽标改为框上方独立布局，修复 280dp、2 倍字体的顶部裁切。[手机截图](../output/android-native/tests/0.2.2-reference-phone.png)与[平板截图](../output/android-native/tests/0.2.2-reference-tablet.png)已查看。
- 短窗口内对话输入可滚动到达；发送前释放焦点并收起键盘，修复插入回复时焦点滚动导致的持续重组。历史刷新不再依赖作业卡片是否处于可见区域；后台暂停轮询，已知撤权清除服务器消息并保留未发送草稿。
- 输入契约的空 schema 正确允许结构化 JSON，修复建议更新被误判为文本的实际阻断。另修正禁用输入框测试选择器，以及作业卡片滚出可见区后的测试前置条件；最终完整套件均已重跑通过。

涉及文件主要位于 `features/` 的富文档、对话、建议、反馈与问询工作区，`media/ExportWorkspace.kt`、`ui/` 引用偏好与输入组件，以及对应 JVM / instrumentation 测试；具体清单可由 Git 提交差异复核。

ADB 验证脚本修复 TCP 设备序列号含冒号时的路径问题：共享 `scripts/adb-artifact-path.ps1` 对文件名编码，原始序列号仍用于 ADB；冒烟和资源脚本的 `-ValidateOnly` 均通过，含冲突与非法输入检查。此前平板脚本失败属于路径生成问题，修复后已在 `localhost:5555` 实际重跑通过，未用设备别名掩盖。原失败报告保留在本机输出目录。

### 当前 Release 资源采样与验收边界

[五轮原始报告](../output/android-native/benchmark-20261019-233909-emulator-5556/report.json)核对安装包哈希与交付包一致，非 Debug。API 37 模拟器未登录页进程冷启动 `TotalTime` 中位数 511 ms（476–1011），PSS 中位数 28,001 KiB（27,980–28,042），短窗口空闲 CPU 中位数 0%（0–0.327%）。使用 `-NativeOnly`，未操作旧应用；未清理存储或编译缓存。结果不能代表真实业务可交互时间、手机电量或相对旧版的资源节省比例。

本轮没有修改或重新部署 backend/frontend；此前获授权的备份、0078–0080 迁移和部署记录保留在下方历史报告。用户暂不方便完成 Turnstile，因此本轮没有继续生产登录尝试。真实浏览器回调、PKCE 交换及账号一致性，FCM 实际投递，真实模型/OCR/语音、DSH、四小时物理录制、生产权限竞争和可比业务负载仍按 [验收清单](docs/ACCEPTANCE.md) 完成。未调用真实付费模型、发送推送或修改生产业务数据，未将这些边界记为通过。

复现构建、路由校验、设备测试与资源脚本的命令见 [README](README.md)。下方为历史证据，不代表当前安装包或本轮测试数量。

## 历史交付：0.2.1-preview（不代表当前状态）

以下为当时结果；不能用于判断当前构建状态或功能缺口。专用 Compose / Material 3 工作区已覆盖项目、创建、任务协作、资料、富文档、评分与演练、AI 协作、人员、帮助和管理入口，继续使用现有后端。实际生产授权及外部服务验收仍未闭环，不声明全量迁移目标完成。

- 签名安装包：[buwei-native-0.2.1-preview-release.apk](../output/android-native/buwei-native-0.2.1-preview-release.apk)，5,504,213 bytes；versionCode 3；独立包名 `cn.buwei.mobile.nativepreview`。
- SHA-256：`6f25a937e738dbc162746e146a22593be5e0049863800d57010c490fedbe25ba`。
- APK 源提交 `c65ee43a2745663ac76abfe51bc02be09cce0b8f`，`sourceTreeDirty=false`；后续提交仅增加验收脚本与文档。复用原有签名，v2/v3 校验通过。
- 主分支构建通过：112 项 JVM 测试、Android Lint、R8/资源压缩、Release 签名与校验。Lint 为 0 errors、1 项既有 BouncyCastle EST 依赖告警；未保留的 EST 包由 `-checkdiscard` 验证。仍有 Gradle/JDK 工具弃用提示。
- 最终完整 instrumentation：API 33 平板 `OK (71 tests)`，137.506 秒；API 37 手机 `OK (71 tests)`，114.795 秒。覆盖模拟服务下的专用业务界面、修订冲突、账户隔离、固定引用、持久草稿、导航与原生 Markdown 等；不等于生产账户验收。
- 路由检查 11 项通过；183 个静态请求绑定对应 134 个 OpenAPI 操作，错误 0；178 个动态绑定仍未由静态检查验证。生成的 311 个契约一致，数量不代表全部业务验收。
- 原生授权生产验证脚本离线 6 组自检通过；后端原生相关 21 项及 readiness 30 项通过。网页授权页构建、发布预检及两端部署 dry-run 通过。
- 最终 Release 已覆盖安装到两台模拟器，初始登录页冒烟通过。对应 APK 全部 DEX 未观察到 WebView 引用；UI 层级 WebView 数量均为 0。原有客户端和私有数据保留。

证据：[历史构建元数据](../output/android-native/0.2.1-release-artifact.json)、[冒烟与 DEX 报告](../output/android-native/smoke-20261019-225028/report.json)、[静态路由结果](../output/android-native/final-routes.json)。完整套件日志位于集成工作区 `output-native-markdown-phone-device.log` 与 `output-native-markdown-tablet-device.log`，主分支构建日志为 `output-native-main-0.2.1-release.log`；这些本机产物不入库。

### 当前 Release 资源采样

最终 0.2.1 APK 的已安装哈希与交付包一致，非 Debug。API 37 模拟器未登录初始页五轮进程冷启动：`TotalTime` 中位数 542 ms（467–759 ms），PSS 中位数 27,421 KiB（27,168–27,468 KiB），短窗口空闲 CPU 五轮均 0%。[原始报告](../output/android-native/benchmark-20261019-225053-emulator-5556/report.json)。脚本使用 `-NativeOnly`，没有操作旧应用。不清存储或编译缓存；这些值不代表业务可交互时间、真实手机电量或已登录业务负载，不能据此计算相对旧版的节省比例。

本次手机和平板最终登录页截图均已人工查看，无裁切或横向溢出。真实项目长列表、字体放大和复杂长文仍按剩余验收处理。

### 已授权的生产备份与部署

用户明确允许备份、迁移和发布后，已保存 D1 Time Travel 恢复书签、146 张普通业务表 SQL（10,718,539 bytes）及 125 个索引/视图/触发器定义。全库 SQL 导出受既有 FTS5 限制；普通表备份与补充结构在内存恢复校验 `integrity=ok`、外键违规 0。全库恢复依赖 Time Travel，不能将普通表 SQL 当作完整 FTS 备份。备份保存在忽略目录 `output/native-production-preflight/`，不提交生产数据或临时下载链接。

已应用迁移 0078–0080，线上无待应用迁移。核对的 12 张核心表迁移前后计数全部一致，线上外键检查 0 违规。既有资源绑定、账号和密钥保留；未重置数据，未调用真实付费模型。后端版本 `18a08cc1-e0f2-4c6a-950e-b6a94044b6cc`，网页版本 `ae0aa68b-78f4-4ff8-9f75-57f14fe9b0d2`；发布源 `754b09ae` 之后的修改不涉及 backend/frontend。此前缺失的 7 条路由均已出现在生产 OpenAPI。

一次受限的生产授权尝试：事务创建 201、未登录读取事务 401、授权页 200。Turnstile 需要人工验证，登录按钮禁用，密码登录 POST 数量为 0；没有绕过或重复尝试。独立浏览器和原生上下文清理均确认无会话。**线上授权确认、PKCE 交换、账户一致性、重放拒绝及真正 Android 浏览器回调尚未验收。** 可复现脚本：`node scripts/verify-native-auth-production.mjs --self-test`；生产执行必须显式 `--production` 并指定已有凭据路径，报告不输出凭据或授权码。

FCM 实际投递、真实模型/OCR/实时语音、DSH 外部设备流程、四小时物理录制、无障碍及可比 Release 业务负载仍需按 [验收清单](docs/ACCEPTANCE.md) 完成。

## 历史交付：0.1.0（不代表当前状态）

日期：2026-10-19。可执行代码已合并到 `main`，构建源提交 `2bf4d4be48eacfcd772beac0115edcd797225167`。后续文档提交不改变此安装包。原有用户未提交文件和旧安卓客户端保持不变；未推送、部署、执行生产迁移或调用真实付费模型。

## 交付物

- [签名 Release APK](../output/android-native/buwei-native-preview-0.1.0-release.apk)：4,967,384 bytes，约 4.74 MiB；独立包 `cn.buwei.mobile.nativepreview`，支持 Android 8+。
- SHA-256：`4f275bb3f47df6c5860ad2b6d43bd8328c578b4619bd53350dc7c0cfa00449cb`。
- [历史构建与哈希元数据](../output/android-native/0.1.0-release-artifact.json)、[签名验证](../output/android-native/buwei-native-preview-0.1.0-release.apk.signature.txt)、[主分支构建日志](../output/android-native/main-release-build.log)。复用已有签名，APK v2/v3 验证通过；没有创建或重置密钥。
- [迁移矩阵](docs/MIGRATION_MATRIX.md) 与 [剩余验收](docs/ACCEPTANCE.md) 区分原生专用界面、契约表单和真实服务验收。本版本仍是预览版，不能声明全部业务体验对等。

## 已运行检查

| 检查 | 实际结果与范围 |
|---|---|
| 主分支构建 | `build.ps1` 执行 JVM 测试、Android Lint、启用 R8/资源压缩的 Release 构建、对齐与签名验证，通过 |
| 原生 JVM | 22 项通过：离线策略、业务/富文档保留与输入校验、Office 日期、通知会话/过滤、语音协议 |
| Android 13 / API 33 | BlueStacks，20 项 instrumentation 全通过；模拟账户/本机服务，不访问真实业务账号 |
| Android 17 / API 37 | Android Emulator，20 项 instrumentation 全通过；同一套测试 |
| instrumentation 范围 | 仓库 6、业务 UI 5、文档读取 5、导出 2、扫描页渲染 1、原生本地音频播放/暂停 1；覆盖离线保存、冲突阻断、撤权后拒用缓存、延迟响应体不在主线程读取、富文档无损保存、创建预览后确认、模拟 AI 轮询和原生播放控制 |
| 后端全量 | 172 个测试文件、1,565 项通过；新扫描页 prepare 不调度模型、PKCE 和通知派发回归包含其中 |
| Web 全量 | 175 个测试文件、1,082 项通过；随后重新通过类型检查、ESLint 和 Web 构建 |
| 主分支整合检查 | 后端/Web 类型检查、浏览器授权页 5 项、新增后端相关 21 项、契约一致性与迁移编号检查通过 |
| 契约 | 311 个 OpenAPI 原生操作契约一致；15 个硬编码业务操作路径与 OpenAPI 匹配。数量不代表业务体验完成率 |
| 增量迁移 | 80 个迁移检查通过；保留历史重复 0025，新 0079/0080 编号唯一递增。没有应用到生产 |
| 最终 APK 冒烟 | 两台模拟器安装和启动通过，登录界面层级无 WebView；截图已查看，无横向溢出 |
| 最终 APK 静态检查 | DEX 中 `android.webkit.WebView` 引用为 0。曾发现 Media3 UI 的备用 WebView 字幕后端，已移除该依赖并改用原生 SurfaceView + Compose 控制，再次扫描通过 |
| 启动配置 | API 37 未登录启动路径采集 `OK (1 test)`；APK 包含 `assets/dexopt/baseline.prof`（11,306 bytes）与 `baseline.profm`（861 bytes）。未采集真实业务账号路径 |

[最终 APK 冒烟记录](../output/android-native/smoke-20261019-174416/report.json)、[API 33 测试](../output/android-native/tests/output-native-device5554-final.log)、[API 37 测试](../output/android-native/tests/output-native-device5556-final.log)、[后端全量日志](../output/android-native/tests/output-native-backend-tests-final.log)、[Web 全量日志](../output/android-native/tests/output-native-frontend-tests.log)、[主分支相关后端测试](../output/android-native/main-server-tests.log)。

已查看原生 [项目](../output/android-native/ui/5556/projects.png)、[任务详情](../output/android-native/ui/5556/task-detail.png)、[材料编辑](../output/android-native/ui/5556/rich-editor.png)、[创建完成](../output/android-native/ui/5556/creation-committed.png)、[横屏 AI 对话](../output/android-native/ui/5554/ai-conversation.png) 的 fixture 截图。这些是模拟数据路径，不能替代生产权限和真实模型验收。

## 资源测量

最终签名 APK 在 API 37 模拟器上进行五轮进程冷启动、空闲 PSS/CPU 测量；具体中位数与范围见交付目录的最终测量记录。启动计时采用 Android `am start -W` 的 `TotalTime`，不是完整业务内容可交互时间；不清存储或编译缓存。CPU 为短采样窗口中应用可归属进程的 CPU 核等效占用，不是设备总 CPU 或电量。

| 原生 Release 未登录页面，五轮 | 中位数 | 最小到最大 |
|---|---|---|
| 进程冷启动 TotalTime | 404 ms | 330–438 ms |
| 可归属进程 PSS | 25,794 KiB（约 25.2 MiB） | 25,651–25,999 KiB |
| 空闲 CPU 核等效占用 | 0% | 0–0.328% |

[最终原始测量报告](../output/android-native/benchmark-20261019-174436-emulator-5556/report.json) 记录每轮启动、进程归属、内存、CPU、帧统计、设备参数、Debug 标记与实际安装 APK 的 SHA-256，原生包哈希与交付包一致。这里只报告初始页面，未进行真实项目长列表滚动或持续录制负载测量。

旧应用基线来自另一台模拟器只读拉取的已安装 Debug APK（约 200 MiB），在本次测试设备上全新安装，未复制旧账号或修改原设备数据。它需要本机 Vite 开发服务；实际捕获为服务连接错误页面。虽然脚本记录了关联 WebView 进程和五轮数据，**构建类型、页面及服务状态不一致，因此这些记录不构成有效的新旧性能对比，不计算节省百分比**。正式比较还需要相同业务负载、同条件 Release 包和真实设备。

## 告警及尚未验收

Android Lint 为 0 errors、1 dependency warning：BouncyCastle 未使用的 EST 辅助类含宽松信任实现。Release 配置 `-checkdiscard class org.bouncycastle.est.**`，构建通过证明其未保留；映射文件无该包，应用仍使用平台 TLS 校验。没有全局屏蔽 Lint。Firebase 26 的旧 token 模式通过有文档依据的狭窄包装保持兼容，未来 FID 迁移必须联动 manifest 与后端发送协议。

Baseline Profile 插件/构建工具仍输出 Gradle 弃用与 JDK protobuf Unsafe 提示；测试工具中的 native 库无法剥离提示不属于交付 Release。后端全量仍有既有 workerd RPC 释放和模拟网络取消告警，测试通过但不表述为无告警。首次 AGP 性能配置导出因 Windows 长路径失败，改用直接 instrumentation 与短路径拉取成功；没有把“Gradle 成功但配置为空”当作验收。

**生产使用前必须部署配套原生授权接口及数据库迁移；本次没有部署，所以安装包不表示线上登录已经可用。** FCM 公共应用配置和服务端凭据未配置，真实推送、真实浏览器授权、真实语音/OCR/模型、四小时录制和厂商后台行为未验收。复杂标准/依赖/富文档结构编辑、创建澄清、AI 采纳等仍有专用交互缺口；高级表单可达不替代这些体验。完整范围见验收矩阵。
