# 原生 Android 迁移预览版验证报告

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
