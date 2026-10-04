# 远程固定包验收（等待发布就绪后运行）

固定 URL：`https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.0.tgz`

固定 SHA256：`D39B8C268DE3CB9CFC3E1504B91501D92DB3281AB09790B9F5C8C7C421D93F54`

发布就绪前只运行 `node test/smoke-remote-run.mjs`，输出准备元数据；不会联网或安装。收到明确发布就绪通知后运行：

```powershell
node test/smoke-remote-run.mjs --published --keep-server
```

脚本先校验公开包 SHA，再由官方 CLI 实际从该固定远程 URL 安装。使用新的隔离 DSH_HOME，检查 bundle 启用、插件兼容、客户端 boot graph、匿名 401、认证 200、跨 Origin 403。报告只输出安全元数据；认证 URL 单独写入被忽略隔离目录中的 `browser-url.private.txt`，不会写入 Git 或控制台。

保留服务器时，用独立浏览器测试会话打开该私有 URL（不要使用个人 DSH 浏览器会话）。进入“插件”，点击“补位桥接器”卡片，检查页面标题、尚未连接状态、连接按钮启用、无 JS 错误及五秒状态刷新。此次安装/配置卡片验收不点击连接生产网站、不创建授权、不运行模型；原生目录选择需要另行明确手工验收。截图和浏览器检查元数据另存报告，不能将服务端配置接口成功等同于已完成浏览器交互。

Ctrl+C 停止此脚本所属的隔离 DSH 进程。保留历史 smoke homes，不重复尝试清理。

## 已执行结果（2026-10-04）

发布后实际运行通过：公开包 SHA 与固定值一致；官方管理器从远程 URL 安装并自动启用，隔离 profile 仅有一个外部 dependency；RC2 web boot 成功、兼容门禁通过、匿名/认证/跨 Origin 分别为 401/200/403，客户端进入 boot graph。

独立 agent-browser 会话实际点击预览说明、跳过 API key、进入插件并打开“补位桥接器”卡片。标题、尚未连接状态和启用的连接按钮均可见；5.5 秒期间配置请求从 20 增至 24，状态刷新正常，page errors 为空。截图：`test/smoke-remote-card.png`；机器结果：`test/smoke-remote-result.json`。

已提交的精选截图与机器结果位于仓库 `docs/evidence/dsh-bridge-release/native-plugin-card.png` 和 `native-remote-install.json`；私有浏览器认证 URL 已从精选报告移除。

未创建生产配对、未提供个人密钥、未运行付费模型、未测试原生目录选择。独立浏览器与本次隔离 DSH 进程均已停止，历史 homes 保留。
