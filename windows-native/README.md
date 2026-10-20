# 补位 Windows 原生客户端

独立的 C# / .NET 10 / WinUI 3 客户端。业务界面由 XAML 控件原生绘制，不使用 WebView、本地网页服务器或浏览器业务界面。系统浏览器仅用于既有账号的 PKCE 授权。

本工程提供专用原生工作区和安装产物；当前不宣称全部业务对等或真实生产验收完成。能力与差距见 [迁移矩阵](docs/MIGRATION_MATRIX.md)、[界面覆盖说明](docs/UI-COVERAGE.md)、[验证记录](VERIFICATION.md)。API 清单不是业务覆盖率。

## 外观设置

窗口顶部 **外观设置**，或 **账户与安全 → 外观与主题设置**，可选择：

- **经典 · 翠绿**：默认沿用现有绿色强调色。
- **澄蓝 · 舒展（界面原型）**：依据 `docs/ui-prototypes/buwei-dual-platform-prototype.html` 的蓝色、冷灰导航、圆角卡片与宽松留白，提供深浅两套配色。
- 明暗模式独立选择 **跟随 Windows / 浅色 / 深色**，配置保存到本机 `appearance.json`，登录前亦可调整。高对比度使用系统对比色。

切换使用共享画刷和布局属性绑定，保留业务页面对象与编辑控件。详细映射、自动检查和实机验收边界见 [外观验证](docs/APPEARANCE.md)。

## 架构与兼容

- App：Fluent 工作区、MVVM 通知模型、原生文件/媒体/语音/托盘/通知/签名更新。
- Core：固定服务源 HTTP、DPAPI 会话、账户隔离 SQLite 快照/草稿/有序同步队列、Office 读取及语义导出。
- Windows App SDK 使用 **2.5.1 稳定版对应的锁定组件集**：WinUI 2.3.9、Foundation 2.3.12、InteractiveExperiences 2.1.9、Runtime 2.5.1。按组件引用避免部署未使用的 AI/ML/Widgets；显式排除 WebView2 资产。
- .NET SDK 固定 10.0.402；Windows API 编译目标 26100，最低声明版本 17763。系统可使用已安装的完整 Windows SDK 28000；具体旧系统与硬件需单独验收。
- 普通 Release/ReadyToRun，未启用 Native AOT 或裁剪。尚无证据证明全部 Windows 互操作和动态绑定能在 AOT 下保持行为一致。

## 本机构建

在仓库根目录运行：

    ./windows-native/scripts/verify.ps1
    ./windows-native/scripts/build.ps1
    ./windows-native/scripts/build.ps1 -Debug

需要 Visual Studio 的 C# Windows App SDK 支持、.NET 10 SDK、MSVC 和完整 Windows SDK。NuGet 使用项目 lockfile 还原；不要忽略依赖漏洞或裁剪告警。

默认发布目录为 windows-native/artifacts/final/。首次恢复依赖需要网络；客户端依赖共享 Windows App Runtime，.NET 随客户端部署。

    ./windows-native/scripts/build.ps1 -Package -RuntimeInstaller 'C:/path/WindowsAppRuntimeInstall-x64.exe'

打包脚本验证 Runtime 安装器具有有效微软签名，并拒绝发布目录里的 WebView2 文件。当前用户 NSIS 安装器随附共享运行时安装器，应用使用独立版本目录。便携 ZIP 仍需要预装兼容的 Windows App Runtime。

运行时安装器使用[微软固定 2.5.1 x64 下载地址](https://aka.ms/windowsappsdk/2.5/2.5.1/windowsappruntimeinstall-x64.exe)。打包同时检查应用 PRI/XBF 的存在和文件头；资源发布缺失会导致构建产物无法启动，不能只验证编译返回码。

## 数据与授权

新版数据目录为 %LOCALAPPDATA%/Buwei.Windows.Native/；不会读取旧版的 Cookie、IndexedDB、附件或录制目录。卸载保留该目录；重新授权相同账号后可继续使用本机数据。

后端增量迁移 0081_native_auth_client_type.sql 支持固定 Windows 回调 buwei-windows-native://auth/callback，省略类型的旧请求仍使用 Android。必须配套发布后端及授权网页后，生产浏览器登录才可使用；本次未部署或应用生产迁移。

离线编辑只允许既有白名单，通过 offline-sync wrapper 与持久幂等键发送。冲突保留本机和服务端内容，由用户核对后处理。AI、付费及结果不明的非白名单写入不自动重试。服务端始终负责权限、版本及生命周期判定。

## 媒体与文件

录制先保存在账号目录，支持暂停恢复和五分钟分段，无业务总时长限制；分段切换存在短暂间隙，不宣称无缝录制。原文件与恢复日志保留，上传需明确确认。

实时语音沿用服务端现有协议：原生 PCM 输入、文字转录、字幕核对及手动提交，问题由本地中文 TTS 朗读；不宣称服务端返回双向合成音频。未执行真实麦克风或付费语音验收。

DOCX/XLSX/PPTX 使用原生 ZIP/XML 有界提取，保留原文件，正文可导入现有版本绑定接口。它不模拟 Office 排版、计算公式或执行宏。PDF、图片、媒体使用原生预览。

## 更新与测试隔离

更新入口为独立 windows-native.json 及其签名，复用原有 Minisign 公钥；不复用旧 Tauri 清单。下载及安装前验签，未保存、录制、传输和忙碌时拒绝重启。未配置 Authenticode 的安装器不能称为已通过 Windows 发布者签名。

Debug 下 BUWEI_WINDOWS_SMOKE=1 才使用固定 127.0.0.1:5188 和合成账号/独立临时目录，Release 无此入口。--benchmark 使用独立空临时目录和实例，仅用于匿名资源测试，不读取正式会话。

依赖许可：项目延续 GPL-3.0；PDFsharp 固定 6.2.4 MIT 版本，不使用 6.5 的 AGPL 激活方式。字体来自运行设备，不随安装包再分发；导出器检查嵌入限制。Minisign 使用 Sodium.Core，安装包须随附对应第三方许可。
