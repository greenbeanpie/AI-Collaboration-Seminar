# 补位 Windows 客户端

客户端使用系统 Evergreen WebView2，连接既有线上服务。安装包为 Windows 10/11 x64 的当前用户 NSIS 安装，无开机启动。安装器在缺少 WebView2 时安装共享运行时。

## 可复现构建

Windows 上安装 Node.js 22+、稳定版 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。桌面工程使用 `npm ci` 和 Cargo.lock 固定依赖。

```powershell
./desktop/scripts/build.ps1 -SigningKeyPath C:/private/desktop-updater.key
# 仅用于本机调试、不生成可发布更新：
./desktop/scripts/build.ps1 -Unsigned
```

产物位于 `desktop/src-tauri/target/release/bundle/nsis/`。更新版本须同时更新 Tauri 配置和 Cargo 包版本。发布前运行 `cargo test --locked`、`cargo clippy -- -D warnings`、前端 typecheck/lint/test/build，以及 `node --test desktop/scripts/release-manifest.test.mjs`。

## 密钥与草稿发布

第一次生成：`npm run tauri -- signer generate -w C:/private/desktop-updater.key`。只把 `.pub` 公钥写入 updater 配置。私钥及密码存安全保管库；本机仓库内仅允许忽略的 `.local-secrets/`，用 `git check-ignore` 验证，永不输出或提交私钥。丢失密钥会导致既有安装无法接受后续更新。

```powershell
./desktop/scripts/publish-draft.ps1 -Installer ./desktop/src-tauri/target/release/bundle/nsis/补位_0.1.0_x64-setup.exe -NotesFile ./release-notes.md
```

脚本生成 `latest.json`，仅创建 `desktop-vVERSION` 草稿 Release。公开仓库 `greenbeanpie/AI-Colleboration-Seminar` 的正式 Release 发布后才会被 `releases/latest/download/latest.json` 发现。不要将其他产品 Release 设为 latest 而缺少该清单。

GitHub Actions 手动运行 `Windows desktop draft release`。配置受保护的 `desktop-release` environment，添加 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，限制可发布分支并设置审阅者。首次本机密钥的公钥必须与 CI 私钥匹配。CI 永远仅生成草稿；验收后再由维护者发布。

更新签名保证产物完整性；它与 Windows Authenticode 证书不同。未配置 Authenticode 时 Windows 可能显示未知发布者，本项目不得将更新签名称为 Windows 发布者签名。

## 更新行为与验收

原生启动和每 6 小时检查固定 GitHub HTTPS 地址；下载使用插件验签，验证后的安装包缓存于应用数据目录，等待期间释放下载缓冲。应用重启后重新检查版本和签名匹配的缓存；执行安装前再次验签。网页无 updater 插件直接权限。手动和自动安装均由桌面壳检查版本握手、保存确认与传输状态。自动重启偏好跨重启保留，默认启用。

两版本验收必须在可恢复的 Windows 测试用户或虚拟机中完成：安装版本 A，登录并保存离线编辑及待上传附件；构建版本 B（相同公钥）；用受控测试更新端点或发布候选版本检查 B；验证使用中不重启、托盘安全空闲 5 分钟才重启、关闭自动重启后仅手动重启。检查升级后 Cookie、IndexedDB、附件清单与文件完整保留。分别篡改签名、缓存安装包以及断网，确认失败不运行安装器、原版本仍可启动。更新下载后重启 A，重新检查后应复用完整缓存。未执行这些实机步骤时不得宣称升级验收通过。

## 资源测量

在相同测试用户、项目和 WebView2 版本下，分别测量启动耗时、安装包大小和前台空闲/项目页面/托盘/单文件传输。每个场景稳定 30 秒后采样 60 秒：

```powershell
./desktop/scripts/measure-resources.ps1 -RootProcessId 1234 -Scenario tray -Seconds 60 -OutputPath tray.csv
```

脚本每秒重新发现完整进程树，将宿主与所有 WebView2 子进程的工作集、私有内存及机器总 CPU 百分比累加。CPU 第一帧无基线，不参与汇总。Edge PWA 应在独立 Edge 会话中运行，用该会话浏览器根 PID 测量，避免遗漏兄弟进程或纳入日常浏览页面。工作集可能包含共享页，私有内存同时报告。报告记录硬件、系统/运行时版本、场景和观测值，不承诺固定内存上限。
