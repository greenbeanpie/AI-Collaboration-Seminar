# 原生 Android 迁移预览版验证报告

## 当前交付：0.2.1-preview（2026-10-19）

以下为当前结果；下方 `0.1.0` 记录仅保留为历史，不能用于判断当前部署状态或功能缺口。专用 Compose / Material 3 工作区已覆盖项目、创建、任务协作、资料、富文档、评分与演练、AI 协作、人员、帮助和管理入口，继续使用现有后端。实际生产授权及外部服务验收仍未闭环，不声明全量迁移目标完成。

- 签名安装包：[buwei-native-0.2.1-preview-release.apk](../output/android-native/buwei-native-0.2.1-preview-release.apk)，5,504,213 bytes；versionCode 3；独立包名 `cn.buwei.mobile.nativepreview`。
- SHA-256：`6f25a937e738dbc162746e146a22593be5e0049863800d57010c490fedbe25ba`。
- APK 源提交 `c65ee43a2745663ac76abfe51bc02be09cce0b8f`，`sourceTreeDirty=false`；后续提交仅增加验收脚本与文档。复用原有签名，v2/v3 校验通过。
- 主分支构建通过：112 项 JVM 测试、Android Lint、R8/资源压缩、Release 签名与校验。Lint 为 0 errors、1 项既有 BouncyCastle EST 依赖告警；未保留的 EST 包由 `-checkdiscard` 验证。仍有 Gradle/JDK 工具弃用提示。
- 最终完整 instrumentation：API 33 平板 `OK (71 tests)`，137.506 秒；API 37 手机 `OK (71 tests)`，114.795 秒。覆盖模拟服务下的专用业务界面、修订冲突、账户隔离、固定引用、持久草稿、导航与原生 Markdown 等；不等于生产账户验收。
- 路由检查 11 项通过；183 个静态请求绑定对应 134 个 OpenAPI 操作，错误 0；178 个动态绑定仍未由静态检查验证。生成的 311 个契约一致，数量不代表全部业务验收。
- 原生授权生产验证脚本离线 6 组自检通过；后端原生相关 21 项及 readiness 30 项通过。网页授权页构建、发布预检及两端部署 dry-run 通过。
- 最终 Release 已覆盖安装到两台模拟器，初始登录页冒烟通过。对应 APK 全部 DEX 未观察到 WebView 引用；UI 层级 WebView 数量均为 0。原有客户端和私有数据保留。

证据：[构建元数据](../output/android-native/release-artifact.json)、[冒烟与 DEX 报告](../output/android-native/smoke-20261019-225028/report.json)、[静态路由结果](../output/android-native/final-routes.json)。完整套件日志位于集成工作区 `output-native-markdown-phone-device.log` 与 `output-native-markdown-tablet-device.log`，主分支构建日志为 `output-native-main-0.2.1-release.log`；这些本机产物不入库。

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
- [构建与哈希元数据](../output/android-native/release-artifact.json)、[签名验证](../output/android-native/buwei-native-preview-0.1.0-release.apk.signature.txt)、[主分支构建日志](../output/android-native/main-release-build.log)。复用已有签名，APK v2/v3 验证通过；没有创建或重置密钥。
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
