# 补位原生 Android 预览客户端

独立 Kotlin / Jetpack Compose / Material 3 应用，当前源码版本为 `0.2.1-preview`（versionCode `3`）。业务界面、文档预览和导出使用原生组件，认证及账户恢复中的浏览器步骤使用系统浏览器。包名为 `cn.buwei.mobile.nativepreview`，Debug 为 `cn.buwei.mobile.nativepreview.debug`；与旧 Tauri Android 版并存，不读取或覆盖旧版私有草稿和未同步录制。

当前业务入口已接入专用原生工作区，`FeatureScreen` 不再提供通用 API 操作表单作为业务入口。项目概览、创建向导、任务与团队、资料与成果 AI、标准评分、答辩、账户、通知、工单和管理等界面复用现有后端的权限、版本及数据体系。**这些源码实现不等于已经完成全量真实业务与生产验收。** 当前覆盖见 [功能说明](FEATURES.md) 和 [迁移矩阵](docs/MIGRATION_MATRIX.md)，最新测试与构建结果见 [验证报告](VERIFICATION.md)。

## 架构

- `MainActivity.kt`、`NativeViewModel.kt`：手机底部导航、平板侧栏、项目分区和深链接；录制、暂停或上传期间的导航保护；绿色品牌主题和 DataStore 外观偏好。
- `data/`：OkHttp 同源 Cookie 请求、AndroidKeyStore 加密会话、Room 账户隔离快照和离线操作队列、账户私有原子草稿。只有服务端允许的幂等写入可以离线排队；AI、费用和权限操作不自动重放。材料冲突需人工核对新版本后再保存。
- `features/`：专用 Compose 业务工作区。富文档支持文字格式、内容块、列表、表格、草稿恢复与版本冲突处理，保存时保留引用、未知节点、marks、attrs 和附件。OpenAPI 契约作为 assets 用于校验与一致性检查，不作为通用业务表单导航。
- `media/`、`cn/buwei/mobile/`：SAF 私有原件、按用途与贡献者区分的分片续传、原生录制前台服务、PdfRenderer/Media3 预览、PDF/Office 正文读取，以及 JSON/Markdown/PDF 分享。页面图片准备与后续 OCR 分开确认。
- `voice/`：显式开启的实时语音、原生 PCM 麦克风与 WebSocket、字幕核对、本地朗读和文字回退。离开页面或账户变化时释放资源。
- `push/`：FCM data 消息仅作提示，点击后重新读取授权收件箱。无 GMS 或配置时使用站内收件箱与 WorkManager 补查；系统不保证按精确的 15 分钟间隔执行。
- `baselineprofile/`：未登录启动路径采集；不包含真实账号业务负载。

## 构建与检查

需要 JDK 17 或以上、Android SDK 37、Build Tools 37.0.0；最低运行版本为 Android 8（API 26），目标 API 为 37。项目使用 Gradle Wrapper。Windows 默认工具位置为 Android Studio JBR 与 `D:/Android/Sdk`，可通过参数覆盖。不要提交 `local.properties`、签名文件或 Firebase 服务账户私钥。

```powershell
node android-native/scripts/generate-contracts.mjs --check
node android-native/scripts/check-feature-routes.mjs
./android-native/scripts/build.ps1 -Debug

# 只使用已有签名，不自动生成或替换密钥
./android-native/scripts/build.ps1 -SigningDirectory 'C:/path/to/existing/signing'
```

构建脚本从 APK 的 `output-metadata.json` 读取实际版本，输出至 `output/android-native/`。当前版本的命名为 `buwei-native-0.2.5-preview-debug.apk` 或 `buwei-native-0.2.5-preview-release.apk`，同时写入签名验证记录及 `debug-artifact.json` / `release-artifact.json`。元数据包含版本、包名、字节数、SHA-256、`sourceCommit` 和 `sourceTreeDirty`；后者记录受跟踪文件是否有未提交改动，不能用提交号代替对该标志的核对。

Release 启用 R8 和资源压缩，禁止明文网络。Debug 允许本机 MockWebServer 测试；服务源固定为现有后端。

```powershell
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME='D:/Android/Sdk'
./android-native/gradlew.bat -p android-native :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest
# 安装对应 Debug 和 androidTest APK 后，在独立测试设备上运行：
adb -s emulator-5556 shell am instrument -w -r cn.buwei.mobile.nativepreview.debug.test/androidx.test.runner.AndroidJUnitRunner
./android-native/scripts/native-smoke.ps1
./android-native/scripts/measure-native.ps1 -Serial emulator-5556
```

不要将旧版 `0.1` 的测试数量或安装包结果当作本轮证据。每轮实际通过、失败、未运行数量及设备信息以 [VERIFICATION.md](VERIFICATION.md) 为准。

性能脚本记录冷启动、PSS、可归属进程 CPU 和启动/空闲帧的逐轮数据。只有同设备、同认证状态和可比构建类型才适合比较；无法归属 WebView 独立进程时不推测总量。模拟器未登录页面不能证明真实项目工作负载的耗电与长期后台表现。

未登录启动的 Baseline Profile 已有历史采集。需要重新采集时运行 `./android-native/scripts/generate-baseline.ps1 -Serial emulator-5556`，随后重建并核对最终 Release。脚本使用短目标路径规避 Windows 长路径问题，只操作预览包，不卸载、清除旧应用数据或替换签名；正式签名预览包不能被测试签名覆盖，应使用独立测试设备。

## 配套服务与配置

后端包含 `0079_native_auth.sql`、`0080_native_push.sql` 增量迁移、PKCE 授权和设备通知接口，Web 端包含受保护的浏览器授权确认页。S256 verifier 与一次性授权码换取独立会话，不从 WebView 导出 Cookie。2026-10-19 经用户授权，生产已备份、应用 0078–0080 并部署配套服务；新增路由已上线。线上自动验收停在需人工完成的 Turnstile，尚未完成真实授权码交换与 Android 回调，详见验证报告。

FCM 公共客户端参数通过 Gradle 属性 `firebaseAppId`、`firebaseApiKey`、`firebaseProjectId`、`firebaseSenderId` 提供。服务端仅在配置 `FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY` 后发送；私钥只属于服务端 secret，绝不放入 APK。缺少配置时显示降级状态，不承诺即时推送。

更新契约时先运行 `npm run export:openapi --prefix backend` 和 `npm run typegen --prefix frontend`，再运行 `node android-native/scripts/generate-contracts.mjs`。当前资产包含 311 个操作；服务端始终负责权限、生命周期、版本和幂等判定。

## 验收边界

专用原生页面已接入现有后端接口，配套服务已部署；真实生产授权、FCM 投递、付费模型、实时语音、四小时物理设备录制与可比 Release 业务负载仍需独立验收。手机、平板、厂商后台限制、外设切换、无障碍及长文性能也应按 [验收清单](docs/ACCEPTANCE.md) 记录实际结果，不能用接口数量或模拟数据代替。

PDFBox 的可选旧 JPEG2000 解码器未打包，图片渲染使用系统 PdfRenderer。BouncyCastle 中未使用的 EST 辅助类会触发依赖 Lint 告警；Release 配置使用 `-checkdiscard` 要求移除整个 EST 包，未放宽应用 TLS 校验。Baseline Profile 插件仍有 Gradle 弃用提示。

媒体使用 ExoPlayer 解码、系统 SurfaceView 和 Compose 控制，没有引入 `media3-ui` 的备用 WebView 字幕组件。最终 APK 的 DEX 扫描结果以对应构建的验证报告为准；当前未提供内嵌字幕专用绘制。

## 外观主题

登录后进入「我的 → 外观 → 主题设计」，可选择「经典绿」或「舒展蓝」。舒展蓝提取自 `docs/ui-prototypes/buwei-dual-platform-prototype.html` 移动端的蓝色强调、冷灰底色、白色卡片和 15dp 圆角，提供深色藏蓝配色；明暗模式独立选择跟随系统、浅色或深色。选择即时应用并保存在设备本机，重启恢复，不影响账号、业务数据或 AI 引用偏好。保留安卓系统字体与字号缩放，不加载 HTML、字体包、模糊层或图片背景。
