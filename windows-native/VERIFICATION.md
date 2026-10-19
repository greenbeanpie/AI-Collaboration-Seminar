# Windows 原生客户端验证记录

本轮交付是可构建、可打包的 WinUI 原生迁移预览，**不是完整业务对等或正式发布验收**。专用界面已覆盖主要业务领域，但 [UI-COVERAGE.md](docs/UI-COVERAGE.md) 列出的缺口仍未完成。[MIGRATION_MATRIX.md](docs/MIGRATION_MATRIX.md) 是后续验收门槛。

以下安装产物与性能数字对应冻结的 **0.1.0 / 8225036c**。后续 **0.1.1 源码**增加了任务 Bridge 闭环、持久在线请求及原文离线准备，新增验证见 [Bridge 验证记录](docs/BRIDGE-VERIFICATION.md)和[离线准备验证](docs/OFFLINE-VERIFICATION.md)；当前源码比已生成的 0.1.0 安装包更新，不能把旧包的性能或窗口证据自动用于新源码。

## 改动范围

- `windows-native/App/`：原生工作区、分领域专用界面、结构文档编辑、MVVM 通知模型和 Windows 集成。
- `windows-native/Core/`：HTTP/会话、账户隔离 SQLite、离线队列、草稿、Office 读取及导出；同级六个测试项目、`scripts/` 与 `installer/` 提供本机验证、打包及采样。
- `backend/src/api/native-auth.ts`、`backend/src/services/native-auth.ts`、`backend/test/native-auth.test.ts` 与 `backend/migrations/0081_native_auth_client_type.sql`：可选 Windows 授权事务，保持 Android 缺省行为。
- `frontend/src/pages/NativeAuthorizePage.tsx` 及其测试、后端/前端 OpenAPI 与 Android `native-contracts.json`：固定回调与契约兼容更新。
- 同期其他任务合入 `main` 的 Android 功能修复完整保留，不作为本 Windows 迁移实现或测试成果计数。

## 环境与构建

- Windows x64；Visual Studio Community 2026 18.11；.NET SDK 10.0.402；MSVC 14.51；已安装完整 Windows SDK 28000，无需重复安装 26100。API 编译目标为 26100。
- Windows App SDK 2.5.1 对应锁定组件，.NET 自包含、共享 Windows App Runtime、ReadyToRun；未裁剪、未启用 Native AOT。
- `scripts/verify.ps1`：打包资源门禁 4 项、契约生成检查、契约 7 项、Core 23 项、回归 27 项、Office 17 项、导出 8 项通过；平台签名/哈希/断点传输/活动门禁及纯本机语音协议检查通过；`main` 上 Release 构建零警告、零错误。
- 后端 native-auth/auth/account-settings/account-roles 4 文件共 39 项通过；授权网页 14 项通过。前后端 typecheck、前端 lint/生产构建、81 个增量迁移检查通过。未连接生产数据库执行迁移。
- 路由清单记录 312 个 operation；动态路由保持 unresolved，数量不能当作业务覆盖率。

证据保存于交付目录的 `verification/`；可复现命令见 README。原始日志使用执行时本机时间，部分检查跨日执行；文件名不是生产发布标识。

## 原生窗口与设备

曾启动 Debug 独立合成账号/固定 loopback 服务，观察到原生窗口并收到本机 auth/session、projects 请求。这仅证明早期启动及这两次请求，不证明最终工作区或完整业务通过。

首次 Release 性能预热发现 `0xC000027B` 启动崩溃，诊断确认 unpackaged 发布遗漏应用 PRI/XBF；[Windows App SDK 官方问题记录](https://github.com/microsoft/WindowsAppSDK/issues/6720)说明了该发布路径的遗漏。已显式发布两个独立资源项，检查文件头，防止 XBF 覆盖 PRI。修复后发布目录以隔离 `--benchmark` 模式启动，15 秒仍存活且无新增未处理异常，再进入三轮采样。该检查为 CLI 进程存活证据，不是视觉或业务验收。失败轮次不计入有效性能结果。

用户按物理 Escape 停止 Computer Use 后，已停止所有 GUI 自动化。最终源码没有完整窗口截图验收；中文输入法、键盘路径、屏幕阅读器、深浅主题及 100%/150%/200% DPI 仍未验证。合成服务及 Debug 隔离入口不会打进 Release。未替用户关闭既有 Debug 窗口或其他工作进程。

真实摄像头/麦克风、付费转录/模型、真实语音、多小时录制、设备中断、生产通知均未验收。语音检查只覆盖协议路径、PCM 转换和帧大小，不代表真实服务连接通过。

## 数据、文档及文件

自动检查覆盖账户隔离、DPAPI、固定 Windows 回调及 PKCE 防重放、持久幂等键、offline-sync wrapper、冲突保留、撤权、迟到响应、账户切换、服务端确认后快照更新及本机任务 ID 重映射。低磁盘、进程崩溃时每一个 UI 草稿及所有业务撤权闭环仍未验收。

离线准备不覆盖所有首次深链接，详见矩阵。非白名单在线请求未知结果须人工核对，尚未实现全局持久化在线意图协议。富文档未知节点保留有源码与回归证据，完整编辑/粘贴与人工合并仍未验收。

Office 17 项使用合成 ZIP/XML 验证限额、正文及错误输入；真实服务 doc-import 批次、恢复和权限闭环未验证。导出 8 项包含中文、分页、引用、权限过滤、取消及已存在目标保护；生成的 14 页 PDF 经文本/页面边界检查并抽查第 1/7/14 页，不能当作每页人工审阅。文件断点传输使用本机 fixture，真实网络/大文件及存储空间故障未验收。

## 安装、更新与生产边界

本机安装包包含微软有效签名的 Windows App Runtime 2.5.1 x64 安装器和随应用部署的 .NET。打包拒绝 WebView2 文件；安装及数据标识独立于旧版。安装器本身未配置 Authenticode 发布者签名。本次未安装到用户正式目录，未执行两版本升级、卸载保留数据及升级失败恢复测试，不能宣称部署验收通过。

发布附带项目 GPLv3 与第三方许可/NOTICE、实际锁定版本、来源和摘要清单。许可清单包括仅构建的 NuGet 元信息，出现 WebView2 许可条目不表示部署其运行库。仅构建依赖 Windows SDK BuildTools 的完整许可原文不在 NuGet 缓存中，清单明确标缺失，未分发其构建二进制。

Minisign 使用既有公钥，实际生产签名 fixture、篡改、哈希、路径和忙碌重启门禁均通过本机检查；未访问私钥，未生成可公开发布的签名更新清单。新版本目录安装与旧数据保留仅经源码检查。

原客户端与未同步数据未迁移或删除。Windows 生产登录须配套部署增量迁移 `0081_native_auth_client_type.sql`、后端及授权网页；本轮没有推送、生产部署、生产迁移或付费调用。

## 性能

原始三轮匿名前台/托盘数据及限制见交付目录 `resources/` 和 [性能记录](docs/PERFORMANCE.md)。仅这些实际采样场景可比较；认证项目、文档、传输和媒体峰值未测。未证明固定资源降幅，也未进行系统冷启动实验。

| 三轮中位数，MiB | Tauri 基线 | WinUI 预览 |
| --- | ---: | ---: |
| 匿名登录前台，进程树私有字节 | 555.26 | 82.18 |
| 匿名登录前台，工作集相加 | 885.72 | 150.53 |
| 初始托盘，进程树私有字节 | 208.42 | 74.94 |
| 初始托盘，工作集相加 | 62.07 | 142.57 |

前台私有提交量明显下降，**托盘工作集反而增加**，不能宣称所有内存指标改善。私有提交量不等于实际物理 RAM，工作集相加包含共享页重复计数；VRAM 未测。各组 CPU 机器归一化中位数均为 0%，不是每一时刻都没有 CPU 活动。其他任务的后台负载未受控制；仅有输入空闲计时，没有视觉就绪或可交互耗时验收。
