# 补位 Android 客户端验收

本次交付 Android 8（API 26）以上的 ARM64、x86_64 签名 Release APK，输出位于 `output/android-client/`。ABI、体积和 SHA256 以 `release-artifacts.json` 为准；每份 APK 附有签名校验文本。Debug 和 fixture-test APK 仅供验收，不作为安装包交付。

## 实现与修改范围

- `desktop/src-tauri/`：Android 生命周期、平台能力握手、共享附件清单和传输、来源/命令权限；Windows 托盘、WebView2 和 updater 依赖保持 Windows 专用。
- `desktop/android-plugin/`：SAF 文件选择、64 KiB 流式导入、私有缓存、系统文档导出、原生 CookieManager；会话与内部路径不对网页开放。切换账户或重新加载页面使旧导出失效。
- `frontend/src/`：Android 设置、后台停止文件面板定时器、恢复传输；保留现有离线快照、队列、幂等提交和冲突界面。任务显示与文件列表保留网络优先，在传输失败且账户未变化时允许本机快照回退；401、取消、严格同步请求和写入不使用该回退。
- `desktop/scripts/`、`desktop/src-tauri/gen/android/`：稳定版本构建、签名、环境预检、无符号链接的 Windows 构建流程、ADB/CDP API 验收和进程测量。测试 APK 的辅助代码仅访问固定模拟账号、项目和任务，不进入 Release APK。

进入后台暂停网络传输，返回前台认证后恢复；没有常驻服务或原生通知轮询。未提交的表单仍应主动保存；已提交到本机的离线操作及附件任务会持久保存。普通清理保护未上传附件，用户可明确放弃；退出登录会提示未同步工作。

## 环境与构建

复用 SDK37、Build Tools37、NDK r30、Android Studio JBR25.0.3、BlueStacks5 Android13 / WebView153；新增 Rust Android 目标和 Gradle/Maven/Cargo 构建缓存，没有安装旧 JDK/NDK/SDK，也没有改全局默认环境。完整版本和来源见 `desktop/ANDROID-DEPENDENCIES.md`。

```powershell
pwsh -File desktop/scripts/check-android.ps1
pwsh -File desktop/scripts/build-android.ps1
```

Gradle9.8.0、AGP9.4.1、Kotlin2.4.20 固定稳定版本；Gradle Wrapper 下载有 SHA256 校验。签名私钥和随机密码位于受保护、Git 忽略的 `.local-secrets/android-signing/`，并已备份到原工作区同名私有目录。证书 SHA256：`51a9f2e6ece5534d70f40779b6bdb9a535b264ba7e08f0f29af0c07402abc3f2`。后续覆盖安装须使用同一密钥，避免卸载造成应用私有数据删除。

当前 Windows 系统没有文件符号链接权限，脚本直接复制 `.so` 并跳过已执行的 Gradle Rust 子任务；无需开启开发者模式。Android 编译仍有 Tauri/wry 生成代码及框架旧 DSL 的弃用提示，已记录且未压制；本项目自身 Java8 和源码目录弃用告警已修复。

## 自动验证证据

全程没有使用 Computer Use、鼠标键盘输入、可访问性操作或截图。ADB 负责安装、启动、进程和测试 APK；CDP 仅直接调用 JS/桥接与存储 API。

| 检查 | 结果与证据 |
|---|---|
| 前端 | 137 文件、840 项测试通过；类型检查、lint、Vite/PWA 构建通过。`output/android/frontend-*.log` |
| Rust / Windows 回归 | 10 项测试、Clippy `-D warnings`、Rustfmt 通过；Windows x64 Release NSIS 再构建成功，约 2.20 MiB。`output/android/rust-windows-*.log`、`windows-release-build.log` |
| Android 构建 | 两个 Release ABI 均编译、R8、lint、打包、16 KiB 对齐和 v2/v3 签名验证通过。Debug 与测试辅助 APK 分别构建通过。 |
| 原生附件 | 28 项通过：HttpOnly 会话、内部插件 ACL、路径限制、下载中断与 Range 恢复、精确磁盘 SHA256、账户隔离、进程重启、真实 Activity 后台暂停，以及分片中断后的已接受分片对账、关联冲突和提交保护。`output/android-smoke/android-smoke-report.json` |
| 实际网页离线 | 12 项通过：真实编译 React/PWA、准备项目、Service Worker 缓存、彻底停止 HTTP 服务、冷启动、快照与未同步编辑保留、任务标题的本机修改显示；测试没有伪造 `navigator.onLine`。`output/android-web-smoke/android-web-smoke-report.json` |
| 覆盖安装 | APK 替换和启动、已持久化 localStorage 与 IndexedDB 检查通过；新增 Cookie 标记未确认保留，整体报告仍为未通过。按用户要求停止追加测试，登录 Cookie 持久性留待人工确认。见 `output/android-smoke/android-replacement-report.json`；测试是同签名、同版本号替换，不代表版本号递增或 Play 商店升级验收。 |
| 线上网页 | 共享 Android 适配已部署；构建匹配、匿名会话401及现有生产密码登录能力检查通过。没有后端部署、数据库迁移或付费模型调用。 |

BlueStacks 不允许 `run-as` 设置包信息组；精确字节与模拟上传通过独立、同签名、仅 Debug 目标可用的测试 APK 完成。它按 64 KiB 块生成固定 9 MiB + 128 字节文件，绕过系统选择器；实际 Rust 分片上传、关联与恢复完整执行，因此这些测试不被表述为文件选择器测试。

## 资源数据与边界

首次安装 x86_64 Release，ADB Activity 冷启动 `TotalTime=2188ms`；该数值不代表网页和远端业务已全部就绪。初始前台应用宿主进程 PSS 为45959 KiB，RSS为109516 KiB。按用户要求未继续前后台 CPU 及内存采样；测量脚本已提供。这些数据不包含独立 WebView 渲染进程或 BlueStacks 宿主，也不代表真实手机性能。

已通过 x86_64 BlueStacks 验收；ARM64 仅完成构建和签名校验，尚未在物理手机运行。系统 SAF 选择/导出、真实生产账户登录、其他 Android 版本、版本号递增更新、大文件传输峰值和长期电池表现仍需人工/实机验收。离线首次使用需要联网登录、准备项目并完成网页缓存；账号管理、AI 和现有在线操作继续要求联网。

自动审批曾拒绝重启 ADB，理由仅为 `blocked by policy`。没有执行该动作；后续只读重查恢复连接并继续完成 API 验证。

用户要求停止追加测试后，已停止测试进程。最终 APK 哈希重新确认一致；结束时模拟器 ADB 显示 device offline，最后一次恢复 Release 安装未成功，未继续修复模拟器。可直接使用交付的 x86_64 Release APK 手动覆盖安装。
