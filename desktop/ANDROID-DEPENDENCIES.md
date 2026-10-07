# Android 构建依赖（2026-10-06）

复用 `D:\Android\Sdk` 的 Command-line Tools 23、Platform 37.0 revision 2、Build Tools 37.0.0、NDK r30 `30.0.16248370`，以及 Android Studio JBR 25.0.3。所有脚本只设置进程环境，结束后恢复；不改变全局默认值。

稳定版固定：Tauri CLI / Rust 2.12.1（Cargo.lock）、AGP 9.4.1、Gradle 9.8.0（wrapper 下载 SHA256 校验）、Kotlin 2.4.20。AndroidX WebKit 1.17.1、Activity 1.13.0、AppCompat 1.7.1、Lifecycle 2.10.0、Material 1.14.0。版本来源：Google Maven metadata、Kotlin 官方版本记录、Gradle 官方 current API；排除预发布版本。

- [AGP 9.4 官方兼容表](https://developer.android.com/build/releases/agp-9-4-0-release-notes)：SDK37、Gradle 最低9.6。
- [Gradle 官方稳定版信息](https://services.gradle.org/versions/current)：9.8.0，Java25 可运行。
- [Kotlin 官方版本记录](https://kotlinlang.org/docs/releases.html)：2.4.20 稳定版。

Tauri 2.12.1 Android 模板仍依赖旧 DSL 和独立 Kotlin 插件，所以保留其 `android.newDsl=false` 与 `android.builtInKotlin=false` 兼容配置。它们是框架兼容要求，不是忽略编译告警；AGP10 移除旧 DSL 后需重新适配。

`tauri android init --ci` 自动安装了 ARM64、ARMv7、x86、x86_64 四个 Rust 目标；交付只构建 ARM64 与 x86_64。生成工程中可复现源码提交，机器相关 `.tauri`、local.properties、JniLibs、assets、tauri.settings.gradle、tauri.build.gradle.kts 不提交，由 CLI 重建。

执行：`pwsh -File desktop/scripts/check-android.ps1`，随后 `pwsh -File desktop/scripts/build-android.ps1`。输出为 `output/android-client/` 的 APK、签名校验文本和 SHA256 清单。Windows 的 updater 和 tray 依赖限定 Windows；Android 不包含它们。

签名密钥与随机密码在 `.local-secrets/android-signing/` 自动生成，并应用当前用户专有 NTFS ACL。必须备份该目录；后续覆盖升级用同一密钥。可传 `-SigningDirectory` 指向受保护的现有目录。不将签名密码打印、提交或包含在交付包中。APK 最低 Android8，使用 zipalign 16KiB native library 页对齐。

构建在没有 Windows Developer Mode 的系统采用 portable 流程：同样的 Cargo/NDK 参数编译，普通文件复制 JNI .so，Gradle 排除已执行的 Rust 子任务。无需符号链接权限或系统设置修改；Tauri build.rs 仍生成插件依赖。

仅在自动验收时使用 `build-android.ps1 -Debug -Smoke -Targets x86_64`；脚本在当前进程生成 loopback 权限和测试入口配置，结束恢复环境，不修改生产能力。`-Smoke` 与 Release 不兼容。
