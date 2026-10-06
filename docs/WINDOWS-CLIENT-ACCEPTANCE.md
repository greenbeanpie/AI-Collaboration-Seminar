# 补位 Windows 客户端验收记录

日期：2026-10-06（Asia/Singapore）。客户端版本：0.1.0。支持目标：Windows 10/11 x64；本次实机为 Windows 11 企业版 LTSC 26100，Core Ultra 9 275HX、24 逻辑处理器、31.4 GiB 可见内存。

## 交付与代码边界

- 正式当前用户 NSIS 安装包：`output/windows-client/补位_0.1.0_x64-setup.exe`，2,311,852 字节（2.2 MiB）。
- SHA-256：`F78ADACDF5F187581B619CB3BBF4D96D8D317D25C1DE91FA3320E20398FF1B4A`。
- 同目录包含更新签名 `.exe.sig`、`latest.json`、测试日志及资源采样 CSV。二进制和本机证据由 GitHub 草稿 Release 与本机输出目录保存，不纳入源码 Git。
- 安装包使用更新签名；未配置 Windows Authenticode 发布者证书，系统签名检查结果为 `NotSigned`。两者不能混同。
- 源码位于独立 `codex/windows-client` 工作区。原工作区 Office 修改先备份，再复制为隔离基线；本任务未改动原工作区的分支、源码和业务数据；其 Office 修改随后在主分支独立提交，内容与隔离基线完全一致。
- 更新私钥位于忽略目录，并另存原工作区 `.local-secrets/desktop-updater/`，目录 ACL 仅当前 Windows 用户可访问。没有把私钥或账号凭据写入 Git、安装包或发布附件。

## 实现

使用 Tauri 2 / Rust 与共享 Evergreen WebView2；一个主窗口、一个实例，不捆绑 Node、浏览器副本或本地服务器。安装器在缺少 WebView2 时安装共享运行时。固定线上同源入口复用 React 页面、登录、API、IndexedDB 快照、离线队列和冲突处理。

关闭窗口进入托盘。保存、文件选择、导出、网络请求和传输未结束时禁止挂起与更新重启。休眠明确设置 WebView2 控制器不可见，随后 `TrySuspend`；恢复先恢复控制器。后台通知由 Rust 每分钟查询，凭据仅原生内存读取，校验当前账户、偏好、已读与收起状态；无会话停止，网络失败退避。通知内容为摘要，点击路径限定为应用内地址。

附件磁盘缓存按账户、项目隔离；原生文件选择后暂存并落盘。上传使用 64 KiB 流、已有分片接口和持久会话，每次恢复先核对服务器分片；下载支持严格 Range 核对。整个项目下载先准备完整文本快照，再按用户选择保存文件，提供预估、暂停、恢复、显式放弃和导出。待上传文件不允许作为普通缓存清理。任务提交等待附件上传与登记完成，固定最终附件版本后才发送已有幂等同步请求。

原生命令同时受 capability / AppManifest 命令权限和窗口、来源校验限制；网页没有任意路径读写、Shell、任意网络、创建额外 WebView 或直接执行更新器的权限。桌面/网页协议不兼容、启动握手未完成及存储失败均阻止安全重启。

更新器启动和每 6 小时检查固定 GitHub 清单。自动下载验签并持久缓存，等待重启时释放安装包缓冲，安装前再次验签。默认安全托盘空闲 5 分钟后安装，使用中提供手动重启，可关闭自动重启。发布脚本与 CI 只创建草稿 Release；正式公开后 `latest.json` 才能成为自动更新入口。

## 验证证据

| 验证 | 结果 |
| --- | --- |
| 前端类型检查、ESLint、构建与 PWA 生成 | 通过 |
| 前端全量测试 | 135 文件 / 836 项通过 |
| Rust 单元测试 | 10 项通过 |
| Rust Clippy `-D warnings`、Rustfmt | 通过，无告警 |
| 发布清单、受限更新路由测试 | 3 项通过 |
| Release x64 NSIS 构建与更新签名生成 | 通过 |
| 真实 WebView2 + Rust 下载 / 账户 / 权限边界脚本 | 17 项通过 |
| 真实签名 A 0.1.0 → B 0.1.1 安装升级脚本 | 9 项通过 |

原生下载脚本走实际 Tauri IPC、HttpOnly 测试 Cookie 和 Rust HTTP：TCP 中断后 Range 续传、磁盘字节比对、页面重载保留、切换账户隔离、路径穿越和越权命令拒绝。证据：`output/desktop-smoke/native-download-report.json`。

升级脚本全程使用 CLI 与 raw CDP API，无 Computer Use 或界面自动化。实际验证签名缓存篡改不运行安装器、脏编辑拒绝重启、真实 NSIS 安装后自动启动 B，以及账号 B 的 HttpOnly Cookie、额外 Cookie、localStorage、IndexedDB 标记、原生附件清单/文件 SHA-256 和更新偏好保留。证据：`output/desktop-smoke/update-smoke-report.json`。

线上前端桥接已部署，最终 Worker 版本：`46a65ce0-b735-4808-842f-6edfb78eb95c`。既有后端 Service Binding、数据库、R2 与配置保留；本任务没有执行后端迁移或真实付费模型调用。

## 资源测量

CLI 启动正式 Release 进程，按宿主和全部 WebView2 子进程汇总，每秒发现完整进程树，采样 30 帧，以下取末 20 帧平均。网页登录页，无账户登录，不代表真实项目、文档解析或上传峰值。

| 场景 | 总工作集 | 总私有内存 | 机器 CPU 百分比 | 进程数 |
| --- | --- | --- | --- | --- |
| 前台登录页空闲 | 536.57 MiB | 273.29 MiB | 0.00%（按采样精度） | 7 |
| `--tray` 登录页后台挂起 | 254.46 MiB | 167.03 MiB | 0.00%（按采样精度） | 7 |

本机诊断确认挂起返回 `status=Ok(()); accepted=true`。工作集汇总可能重复计入共享页，因此同时报告私有内存；安装包大小不能替代运行内存。两种场景分次运行，缓存热度有所不同，不能将差值解释为严格配对性能结论。原始文件：`output/windows-client/foreground-idle.csv`、`tray.csv`，诊断日志位于应用数据目录。

## 明确未验证与限制

- 用户要求停止 Computer Use 后未再调用该工具；未使用其他界面自动化替代。原生文件选择器上传测试已取消，实际上传、Toast 显示/点击、手动托盘菜单操作仍待人工验收。
- A/B 升级是本机签名 Debug 测试包，通过隔离产品名与数据目录保护正式客户端；未验证公开 GitHub 更新通道或正式生产业务离线队列升级迁移。
- 五分钟托盘自动安装触发未等待实测；已验证同一保存握手的手动安装路径和偏好持久化。
- 未实测 Windows 10、ARM64、大文件传输内存峰值或真实项目页面资源占用。
- Edge/PWA 基线启动被自动审批拒绝，工具只返回 `blocked by policy`；没有绕过限制，因此对照测量未执行。
- 原有 Office 基线依赖存在 3 个 moderate 审计项，关联 Mammoth / argparse / sprintf-js；没有通过降级 Office 解析器掩盖或扩大本任务修改。

构建、签名、草稿发布和复现步骤见 [客户端说明](../desktop/README.md)、[原生脚本验收](../desktop/scripts/NATIVE-SMOKE.md)。
