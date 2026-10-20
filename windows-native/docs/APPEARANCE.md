# 原型视觉主题与设置

## 范围及使用

0.1.3 新增「澄蓝 · 舒展（界面原型）」，参考 `docs/ui-prototypes/buwei-dual-platform-prototype.html`（本轮依据 main `edf2d516` 的版本）。本次实现原生客户端视觉主题；业务页面和流程沿用当前 WinUI 工作区。

入口：窗口顶部「外观设置」（登录前可用），或「账户与安全 → 外观与主题设置」。原有主题命名为「经典 · 翠绿」并作为缺省；主题与「跟随 Windows / 浅色 / 深色」分别选择、即时应用，关闭设置框即结束调整。

## 视觉映射

| 项目 | 原型主题浅色 | 原型主题深色 |
| --- | --- | --- |
| 窗口背景 | `#F5F7FB` | `#161B26` |
| 导航分区 | `#ECF0F7` | `#10141D` |
| 卡片 | `#FFFFFF` | `#222A3B` |
| 正文 / 次要文字 | `#141824` / `#4E586E` | `#F1F5F9` / `#94A3B8` |
| 主按钮 / 悬浮 | `#2563EB` / `#1D4ED8` | `#2563EB` / `#1D4ED8` |
| AI 提示及导航图标 | `#6D28D9` | `#A78BFA` |

导航展开宽 236、卡片圆角 10、控件圆角 7、卡片内边距 24×20、正文区内边距 30×26、通用纵向间距 16（Windows 逻辑像素）。原型透明叠层转成不透明原生表面，使用共享画刷，未引入 WebView、网页运行时、额外图片/字体依赖、模糊层或持续动画。

深色填充按钮保留蓝 `#2563EB` 配白字，链接/提示用更亮的蓝；相较原型较亮的深色按钮，该调整使普通小字号对比度达到 4.5:1。经典浅色的提示文字使用较深绿 `#12704F`，保留原绿色主按钮。

## 实现与存储

- `Core/AppearancePreferences.cs`：两种主题、三种模式、配色及版本化设备偏好；不依赖服务端或登录账户。
- `%LOCALAPPDATA%/Buwei.Windows.Native/appearance.json`：小型本机配置。先写同目录唯一临时文件，再替换；保存失败不应用新主题，界面回到原选择。无效或未知版本配置回退默认并保留原文件，在设置内说明原因。测试/基准目录沿用各自独立配置。
- `App/AppearanceTheme.cs`：共享画刷原位更新、布局属性绑定、系统明暗与高对比度事件、原生标题栏和弹窗同步。资源键按固定 WinUI 版本的 `generic.xaml` 核对。`App/Platform/DesktopAppearance.cs` 使用 HWND 子类接收 `WM_SETTINGCHANGE`、`WM_SYSCOLORCHANGE`、`WM_THEMECHANGED`，通过 `SystemParametersInfo(SPI_GETHIGHCONTRAST)` 和 `GetSysColor` 读取桌面无障碍配色，不订阅导致 0.1.3 启动失败的 `AccessibilitySettings.HighContrastChanged`。
- 设置更新不会调用业务导航、重新拉取数据或重建工作区；编辑控件对象和草稿处理链保留。系统事件订阅在窗口关闭时释放。

## 已执行验证

`scripts/verify.ps1` 通过：Core **50/50**（原 23 项 + 外观 27 项）、业务回归 **68/68**、Office 17、导出 8、契约 7、平台/语音及资源门禁，Release x64 **0 警告、0 错误**。

外观检查覆盖六种选项组合重载、取消保存、无效选项、锁定目标模拟替换失败且保留原文件/清理临时文件、损坏/未知版本/过大配置回退、深浅正文/次要文字/按钮/提示的数值对比度、与指定 HTML 的双套主色映射，以及覆盖的资源键确实存在于锁定的 WinUI 控件模板。

整合工作区日志：`windows-native/artifacts/verification/appearance-full.log`；main 复验日志：主仓库 `output/windows-native/verification/appearance-main.log`。

## 待实机验收

本轮未操作 GUI 自动化、安装新版或切换真实 Windows 高对比度；此前停止 GUI 自动化的约束仍保留。尚未取得原生窗口截图，也未实测输入法、缩放、键盘焦点、屏幕阅读器、编辑中切换或实际系统色变化。代码层面的实时绑定和数值对比度检查不能代替以上实机验收。未重新测量 CPU/内存；旧包性能结果仅适用于其冻结版本。

## 0.1.4 启动修复与发布门禁

0.1.3 在本机实际启动时，主题构造函数订阅 WinRT 高对比度事件抛出 `COMException 0x80070490`，窗口未显示；编译和原有测试未发现这个运行时问题。0.1.4 改用桌面设置消息，保留高对比度支持；启动异常会记录并退出释放单实例句柄，避免后续启动持续等待失败实例。

`scripts/build.ps1 -Package` 现在必须先执行 `scripts/verify-startup.ps1`：实际启动同一份 Release 发布目录，检查 30 秒内创建原生窗口、持续 10 秒存活及响应、第二次启动转交后正常退出、没有新增启动诊断。检查仅使用隔离 benchmark 配置和本次创建的进程，不操作界面；结束后终止自有测试进程。已有 benchmark 实例时拒绝运行。主目录、账户数据与旧客户端不变。此门禁要求交互式 Windows 桌面，不能以构建成功代替启动验证。

本机对照：0.1.3 被该门禁拒绝，0.1.4 通过；可复现命令：

```powershell
./windows-native/scripts/verify-startup.ps1 -PublishDirectory ./output/windows-native/0.1.4/payload -ReportPath ./output/windows-native/0.1.4/startup-verification.json
```

高对比度实现依据：[Microsoft 桌面高对比度参数](https://learn.microsoft.com/en-us/windows/win32/winauto/high-contrast-parameter)。上述启动证据不代表登录、业务角色、主题切换视觉或真实系统高对比度验收通过。
