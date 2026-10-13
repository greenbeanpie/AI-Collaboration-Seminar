# PWA 与原生客户端加载、缓存和数据保存检查

检查日期：2026-10-13。对象为当前 PWA、Windows WebView2 客户端和 Android WebView 客户端。生产页面只读检查；编辑、断网和同步验收使用本机固定数据，不调用真实模型、不写入生产项目。

## 对照依据

- [Google Drive 离线文件](https://support.google.com/drive/answer/2375012?hl=en)：用户明确选择本机离线文件、可查看准备状态，离线编辑恢复连接后写回；原文件下载与在线文档离线准备有不同范围。
- [Notion 离线页面](https://www.notion.com/help/use-pages-offline)：桌面/移动应用下载指定页面，显示准备进度，离线修改在本机保存并在联网后同步；浏览器版本不提供同样的离线功能，子页面和部分高级功能有范围限制。
- [web.dev PWA 缓存](https://web.dev/learn/pwa/caching)：缓存最低限度应用壳，避免浏览器默认网络错误页，并明确下载范围与空间消耗。
- [web.dev PWA 更新](https://web.dev/learn/pwa/update)：静态资源与页面控制器需一致；更新不能破坏打开的工作区。
- [MDN 持久存储](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)：普通浏览器存储可能被回收；持久存储是否授予由浏览器决定，不能当作永久备份。
- [MDN 网络状态](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/onLine)：设备显示联网不等于服务可达，因此请求自身必须处理断网、弱网和等待上限。

以上是公开能力与官方实现建议的对照，不是对这些第三方产品进行相同设备/账号下的性能实测，也不能据此声称加载速度胜过某个产品。

## 发现与修复

| 场景 | 检查前 | 本轮处理 |
| --- | --- | --- |
| 网页首次加载主脚本失败 | React 挂载前根节点为空，缺少可操作恢复状态 | HTML 自带启动提示；主资源失败或 15 秒未挂载时显示重试；React 挂载后移除监听，不覆盖编辑器 |
| 已缓存的工作台打开 | 已有 Service Worker 静态壳缓存优先、IndexedDB 快照优先和后台条件刷新 | 保留；不把账户 API、项目正文放进公共 Service Worker 缓存 |
| 无快照、伪联网或慢响应 | 普通 GET 可无限等待 | GET 默认 15 秒截止，覆盖响应正文读取；调用方取消仍保留；离线同步 POST 90 秒截止，未知结果保留同一幂等操作 |
| 账户切换时旧响应晚到 | 旧请求可能影响新账户登录/页面 | 响应头、正文、缓存写入和覆盖完成后核对账号/清除代次；登录成功取消旧查询并清理旧内存查询 |
| 缓存后台刷新 | 缺少 ETag 时即使相同内容也发刷新事件 | 缺 ETag 时比较实际内容，仅变化才通知；正常 ETag 条件请求保持原样 |
| 返回窗口或项目 | 重复完整下载项目并全局刷新 | 自动准备复用 10 分钟内完整快照，合并并发；用户明确保存/刷新仍强制重新准备 |
| 离线准备范围 | 准备状态不可见；未打开提交页时文件信息和完整提交分页不足 | 展示项目文本与文件信息的准备时间；补全任务文件信息和提交记录分页；失败不写成功标记；原附件另行下载 |
| 浏览器本机数据 | 未检查保护状态与空间，无法判断缓存是否易被回收 | 静默检查存储保护/空间；明确保存或下载时申请保护；拒绝、不支持和写入失败均展示实际状态，不删除草稿/队列 |
| 任务成果说明 | 未点击提交前只在内存，刷新丢失 | 输入即时保存账号/项目/任务隔离草稿；恢复正文和版本基线/409 锁；确认标准后继续；持久队列或服务端成功后才清理 |
| 未发送评论 | 输入只在内存，刷新或切换目标后丢失 | 按账号、项目、评论目标即时保存；发送成功后才条件清理；存储失败有关闭保护 |
| 离线材料保存提示 | 排队后仍显示“服务端当前版本”“内容与服务端版本一致” | 分开显示本机缓存、本机待同步和已确认服务端版本，打印也采用真实状态 |
| 原生壳首次离线或应用壳缺失 | 直接打开远程页面，可能停留系统错误页 | 使用打包启动页，继续尝试原有业务 Origin 的离线缓存；20 秒未完成桥接则进入恢复页，提供固定地址重试 |
| 附件会话检查阶段断网 | 英文网络错误不能被现有自动重试判断识别 | 统一传输错误分类，联网恢复后可以继续原有附件队列 |
| Windows 更新获取 | 只有预发布 Release，`latest/download/latest.json` 实测 404 | 发布新版常规 Release；保留旧下载路径兼容旧安装包，同时新版识别仓库规范路径 |

## 仍然存在的能力边界

- PWA 第一次使用、未缓存过的账户/正文，以及登录/权限确认仍需联网。原生安装包现在包含恢复界面，业务界面仍沿用远程应用壳，不能声称首次安装无网络即可进入完整工作台。
- PWA 项目快照保存文本、任务、提交记录与文件信息；附件原文件不会被隐式批量下载。原生文件面板继续使用用户选择的项目下载及账号隔离磁盘缓存。
- 历史材料的版本正文按已打开内容缓存；本轮不承诺每个历史正文都预下载。没有将整站改成完整离线数据库镜像，也没有引入新的权限/认证系统。
- 冲突保留两份内容并要求用户核对，未引入多人富文本 CRDT 自动合并。AI、审批、权限变更等服务端操作需要联网。
- 浏览器授予存储保护也不能抵御用户主动清除网站数据、卸载或设备故障。本机草稿不是云端备份。
- Android 后台传输继续服从生命周期暂停；此次不声称长期后台、ARM64 真机、生产账号跨版本 Cookie 保留或电池测试已验收。
- Windows 缺少 WebView2 时，现有轻量安装包仍需联网下载运行时；Android 更新继续采用手动安装 APK。

## 可复现验证

本机生产构建夹具：设置 `VITE_BUILD_VERSION` 为 Git SHA，运行 `npm run build --prefix frontend`，然后 `node frontend/e2e/pwa-audit-server.mjs`。它只监听 `127.0.0.1:5186`，项目为 `22222222-2222-4222-8222-222222222222`，提供真实 Service Worker/IndexedDB 可使用的合成 API。

浏览器步骤：打开任务页完成准备；切断该测试页网络并刷新；编辑成果说明后再次刷新并打开相同任务；在资料页离线保存材料并刷新；恢复网络，通过夹具 `/__fixture/state` 检查写回次数。主脚本加载失败用独立测试页面拦截 `/assets/index-*.js` 验证，结束后恢复网络设置。

## 本轮浏览器与原生界面证据

全部来自当前检查运行。UI 操作使用 Codex in-app Browser 的开发能力；本机 API 为合成数据，网络模拟结束后恢复。

1. 生产匿名登录入口：正常显示，未使用真实账号登录或提交生产数据。截图 `output/pwa-audit/01-production-login.png`。
2. 主脚本无法加载：显示中文启动恢复提示及“重新加载”操作；不覆盖已挂载编辑器。截图 `02-startup-recovery.png`，另有 watchdog/挂载清理单元测试。
3. 只打开任务页后准备项目：完成标记写入；准备流程覆盖版本 3，避免旧成功标记跳过新增资料接口。
4. 离线刷新和成果草稿：任务列表可打开，未提交成果说明刷新后恢复。截图 `04-offline-task-draft.png`。
5. 断网后首次直达资料页：材料正文可编辑，无缺缓存错误阻止编辑。首次审计发现的 `archived=false` 与详情接口漏项已修复；实际 IndexedDB 回归确认 16 个资料页读取接口离线命中。
6. 离线保存与恢复网络：正文写入本机队列，刷新后保留；恢复网络自动同步，夹具记录服务端写入一次、材料版本升为 2。
7. 未发送评论：输入后刷新，再次打开讨论时恢复本机草稿；没有发送评论。截图 `08-comment-draft-restored.png`。
8. 响应式布局：360px 与 768px 页面宽度分别为 345px、753px，无横向溢出；主要项目导航可见。截图 `06-offline-material-360.png`、`07-offline-material-768.png`。这是浏览器宽度验证，未替代 Android 真机验收。
9. 原生 Windows 恢复：独立 Debug WebView2 测试 5/5，包括首次断网回到打包恢复页、固定业务 Origin 重试、已有缓存离线启动，以及本机页不能读取业务附件。`windows-startup-report.json`、`windows-recovery.png`。
10. PWA 更新确认：本机更新经过人工确认后正常激活、刷新，材料正文及未发送评论草稿仍保留；新版离线提示明确显示“本机缓存版本”。

## main 验证与发布

- 全部有效改动已合并 `main`，代码提交 `698f27392628663ed7b24f06d98a868e1022899a` 已推送。
- `npm test --prefix frontend -- --maxWorkers=4`：167 个测试文件、1033 项通过。
- `npm run typecheck`：前后端通过；`npm run lint`：通过；`VITE_BUILD_VERSION=<Git SHA> npm run build`：通过，Service Worker 预缓存 120 个文件，约 5.15 MiB。
- `cargo test --locked` 在 main：19 项通过、1 项依赖录制硬件的测试按既有规则忽略。Clippy `--all-targets -D warnings` 通过。原生 bootstrap/更新清单 JS 测试 6 项通过。
- 全量验证曾暴露创建向导测试的旧 resolver 竞态：第二次预览尚未发起请求时测试提前回调前一次 resolver。测试改为等待新请求，无修改产品行为或放宽超时；随后全量通过。
- Windows NSIS 与 Android ARM64/x86_64 签名构建成功。Windows 安装器实际密码学验签通过；APK v2/v3 验签、16KiB 对齐检查通过，沿用既有证书，包名 `cn.buwei.mobile`、版本 `0.1.1`、versionCode `11000`、minSdk `26`。
- Android 构建仍输出现有 Tauri/Gradle 生成模板的弃用告警；构建、签名与检查通过，未隐藏告警或扩大到工具链重构。
- Cloudflare 前端 Worker 已部署：版本 `73a7d1f2-45fb-48ad-aa1b-afdbd4425338`。线上入口 JS、Service Worker、启动脚本与本机构建内容一致，D1/R2 检查均为 `ok`，匿名会话仍为 401。发布报告 `output/pwa-audit/production-release.json`。未修改后端、生产数据库、凭据或资源配置。
- [客户端 0.1.1 常规 Release](https://github.com/greenbeanpie/AI-Collaboration-Seminar/releases/tag/desktop-v0.1.1) 已公开发布；安装器/APK/更新清单上传摘要已与本机 SHA256 核对。
- [公开更新清单](https://github.com/greenbeanpie/AI-Collaboration-Seminar/releases/latest/download/latest.json) 返回 200、版本 0.1.1；签名与本机 `.sig` 一致，旧仓库下载路径重定向后的安装器返回 200。报告 `output/pwa-audit/updater-release.json`。这证明更新获取路径可用，不替代真实生产安装升级验收。

## 主要修改文件

- 启动与账户：`frontend/index.html`、`frontend/public/startup.js`、`startup.css`、`frontend/src/App.tsx`、`auth.ts`、`pages/LoginPage.tsx`。
- 请求、持久存储与离线准备：`frontend/src/api/client.ts`、`frontend/src/offline/{store,queue,sync,storage-protection}.ts`、`OfflineWorkspaceStatus.tsx`、`offline.css`。
- 草稿及状态：`frontend/src/features/collaboration/TaskLifecycleDetail.tsx`、`task-submission-draft.ts`、`frontend/src/pages/TasksMaterialsShared.tsx`、`comment-draft.ts`、`MaterialsPage.tsx`、`frontend/src/features/recordings/RecordingDetail.tsx`。
- 原生启动、传输和更新：`desktop/static/`、`desktop/src-tauri/src/{bootstrap,runtime,cache,lib,mobile,updater}.rs`、启动 capability/permission、版本配置、构建与发布脚本。
- 验证：新增/更新对应回归测试、`frontend/e2e/pwa-audit-server.mjs`、`desktop/scripts/{bootstrap.test,startup-smoke,release-manifest.test}.mjs`。完整修改清单位于 `output/pwa-audit/modified-files.txt`。

三平台安装包及校验文件保留在 `output/client-release-0.1.1/`。旧 PWA 页面保存编辑后确认更新；Windows 可检查更新，Android 使用新版 APK。原生设备安装、跨版本真实会话与长期后台验收仍未执行。

机器可读的验证与发布摘要：[pwa-offline-release-20261013.json](pwa-offline-release-20261013.json)。
