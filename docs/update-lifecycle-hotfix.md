# 手动更新生命周期修复与验收

日期：2026-10-01

## 问题与证据

用户反馈：应用确认更新并重启后出现黑屏，需要再次刷新才能使用。

源码与实际生产构建检查发现，两项目的更新控制器都在以下任一事件到达时立即重新加载：等待中的 Service Worker 报告 activated，或者页面收到 controllerchange。此前生成的两项目 Service Worker 均未调用 clientsClaim。

Service Worker 完成激活和当前页面完成控制器切换是不同的条件。此前代码允许在页面仍受旧控制器管理时重载，也允许在新控制器尚处于 activating 时重载，存在外壳和资源版本切换的时序风险。

新增离线回归在修改前分别复现了三项失败：先 activated 后接管、先接管后完成激活、无关控制器事件触发过早刷新。此证据证明代码时序缺陷；尚未取得用户故障当时的浏览器日志，不能将其视为实际黑屏全部原因的唯一确认。

## 修复

- 保持手动确认更新；下载完成不会自动激活等待中的更新
- 生成的 Service Worker 明确设置 skipWaiting=false、clientsClaim=true；只有用户确认后的 SKIP_WAITING 消息才触发更新激活
- 等待目标 Service Worker 同时处于 activated 且已成为 navigator.serviceWorker.controller 后，才重新加载一次
- 取消确认、更新超时或激活失败时不强制重载；迟到事件不会绕过新的确认
- 其他标签页不会自动刷新；该标签页也需确认，且等待激活完成
- 保留项目办公室已有的旧静态 JS/CSS 兼容缓存和懒加载错误恢复，不缓存新的个人资料或 API 响应。

## 已完成检查

- 前端类型检查通过
- 前端 lint 通过
- 完整前端测试通过，共 171 项，包含手动更新、取消、超时、多标签页、首次安装、通知及 AI 配置相关回归
- 生产构建通过
- 实际生成 sw.js 已确认包含 clientsClaim，skipWaiting 仅在 SKIP_WAITING 消息条件下执行，静态兼容脚本及 HTML 预缓存存在
- git diff --check 通过

## 仍待实际浏览器验收

当前云端原生 Chromium 因 socket 权限错误无法启动；云浏览器访问本次启动的本地预览返回 502 / Connection refused。因此本轮没有完成真实浏览器 Service Worker 两版本更新，也不声称已验证用户黑屏消失。

发布并获得可用测试浏览器后，应在已有旧版本安装状态中完成：

1. 打开主页面和一个第二标签页，保留一处未保存的测试草稿
2. 检查更新，等待下载完成；取消更新，确认页面和草稿保留
3. 保存草稿后确认更新；核对页面只重载一次，首次重载就可进入主界面，不需第二次刷新
4. 打开个人资料、设置及 AI 配置页，确认静态资源正确加载，无 HTML 被当作 JS/CSS 的响应或旧构建资源缺失错误
5. 第二标签页不得自动刷新；确认更新后也应一次重载可用
6. 验证首次安装、离线、更新失败和重试，不清除账户缓存或待同步操作来掩盖问题

本轮只实施云端代码和本地提交；未推送、部署或操作本机。

## 生命周期参考

- [Workbox Service Worker lifecycle](https://developer.chrome.com/docs/workbox/service-worker-lifecycle/)
- [Workbox window](https://developer.chrome.com/docs/workbox/modules/workbox-window)
