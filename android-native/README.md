# 补位原生 Android 预览客户端

独立 Kotlin / Jetpack Compose / Material 3 应用。业务界面、文档预览和导出均使用原生组件；仅登录授权使用系统浏览器。应用包名 `cn.buwei.mobile.nativepreview`（Debug 为 `.debug`），与现有 Tauri Android 版并存，不读取或覆盖旧版未同步数据。

**当前是可构建、可安装的迁移预览版，尚未达到全量功能对等和生产验收。** 专用界面覆盖项目、任务、资料、创建草稿、AI 对话等主要入口；复杂管理、评估和版本操作仍有契约表单。操作可达不等于完整业务体验。详见 [功能矩阵](FEATURES.md) 与 [验证报告](VERIFICATION.md)。

## 架构

- `app/.../MainActivity.kt`、`NativeViewModel.kt`：手机底部导航、平板侧栏、生命周期状态和绿色品牌主题；外观偏好使用 DataStore。
- `data/`：OkHttp 同源 Cookie 请求、AndroidKeyStore 加密会话、Room 账户隔离快照及离线操作队列。仅服务端明确支持幂等同步的写入可排队，AI/计费/权限操作不自动重放；冲突保留输入并阻断同项目后续提交。
- `features/`：原生业务界面、保留未知节点和引用的富文本文字编辑、OpenAPI 驱动的高级表单。契约保存在 assets，避免巨大 Kotlin 常量拖慢编译和 Lint。
- `media/`、`cn/buwei/mobile/`：SAF 私有副本、分片断点上传、原生录制前台服务、PDFRenderer/Media3 预览、PDF/Office 正文提取、JSON/Markdown/PDF 系统分享。扫描页图片准备不自动派发 OCR。
- `voice/`：显式开启的实时语音会话，原生 PCM 麦克风和 WebSocket；账户变化、中断或超时后释放资源，文字回答可继续。
- `push/`：FCM data 消息作为提示，通知点击后从授权收件箱解析。无 GMS/无配置时使用收件箱和 WorkManager 补拉；系统不保证精确 15 分钟执行。
- `baselineprofile/`：仅未登录启动路径的性能配置采集，不包含真实账号业务轨迹。

## 构建与检查

需要 JDK 17 或以上、Android SDK 37、Build Tools 37.0.0；项目使用 Gradle Wrapper。Windows 本机默认工具位置为 Android Studio JBR 与 `D:/Android/Sdk`，可通过参数覆盖。不要提交 `local.properties`、签名文件或 Firebase 服务账户私钥。

```powershell
node android-native/scripts/generate-contracts.mjs --check
node android-native/scripts/check-feature-routes.mjs
./android-native/scripts/build.ps1 -Debug

# 只使用已有签名，不自动生成或替换密钥
./android-native/scripts/build.ps1 -SigningDirectory 'C:/path/to/existing/signing'
```

构建结果写入仓库 `output/android-native/`，包含 APK、SHA-256 元数据及签名验证记录。Release 启用 R8 和资源压缩，禁止明文网络。Debug 允许本机 MockWebServer 测试；生产地址固定为现有服务源。

```powershell
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME='D:/Android/Sdk'
./android-native/gradlew.bat -p android-native :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest
# 安装 Debug 及 androidTest APK 后，在独立测试设备上运行：
adb -s emulator-5556 shell am instrument -w -r cn.buwei.mobile.nativepreview.debug.test/androidx.test.runner.AndroidJUnitRunner
./android-native/scripts/native-smoke.ps1
./android-native/scripts/measure-native.ps1 -Serial emulator-5556
```

性能脚本测量进程冷启动、PSS、可归属进程 CPU 和启动/空闲帧，保留每轮原始记录。只在同设备、相同认证状态和可比较构建类型下解释对比；无法归属 WebView 独立进程时不输出猜测的总量。模拟器结果不能证明真实手机耗电或长时间后台表现。

## 配套服务与配置

后端新增 `0079_native_auth.sql` 和 `0080_native_push.sql` 增量迁移，以及 PKCE 授权/设备通知接口；前端新增受保护的浏览器授权确认页。一次性授权码和 S256 verifier 换取独立会话，不从 WebView 导出 Cookie。生产使用前需要按项目正常发布流程备份、应用迁移并部署配套服务；本次没有执行生产迁移或部署，旧服务未提供新增接口时预览版登录会失败。

FCM 公共客户端参数可通过 Gradle 属性 `firebaseAppId`、`firebaseApiKey`、`firebaseProjectId`、`firebaseSenderId` 提供。服务端仅在配置 `FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY` 后发送；私钥属于服务端 secret，绝不放进 APK。缺少配置时显示降级状态，不声称即时推送可用。

生成契约前运行 `npm run export:openapi --prefix backend` 和 `npm run typegen --prefix frontend`，随后运行 `node android-native/scripts/generate-contracts.mjs`。服务端仍是生命周期、权限、版本和幂等判定的权威。

## 保留的边界

旧客户端和原有数据保持独立；用户未提交的仓库改动不属于本次迁移。未自动调用真实模型、创建付费任务、推送仓库或部署服务。真实账号浏览器授权、FCM 实收、4 小时录制/锁屏恢复、相机/蓝牙设备切换、手机和平板完整权限场景及性能目标须进一步验收。

PDFBox 的可选旧 JPEG2000 解码器未打包；图片渲染走系统 PDFRenderer。BouncyCastle 依赖中未使用的 EST 信任辅助类会触发一项依赖 Lint 告警，Release 使用 `-checkdiscard` 强制确认整个 EST 包被移除，未放宽应用 TLS 校验。Baseline Profile 插件仍有 Gradle 弃用提示，升级 Gradle 大版本前需要更新插件。
