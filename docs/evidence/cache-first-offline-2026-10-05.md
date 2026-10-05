# 缓存优先与 AI URL 修复验收（2026-10-05）

## 修复内容

- 将当前账户可缓存的 GET 改为先返回 IndexedDB 快照及本机待同步操作，再后台静默更新。同一账户/URL 的后台请求合并，15 秒限时；失败保留可见内容，快照变化后刷新活动查询，不重新加载页面。
- 补齐任务页澄清列表、AI 建议历史和质询未读列表的缓存。项目准备优先缓存任务与材料，独立页面分批读取，单项失败不阻止其他数据保存；只有完整成功才写入离线就绪标记。无权访问的负责人专属接口不阻止成员准备核心数据。
- 工作台导航直接读取 Service Worker 的构建预缓存入口，不等待断网请求超时；游客静态入口仍走原来的网络路径。API 数据继续按账户保存，不进入公共 Service Worker 缓存。
- 修改 AI API URL 保留供应商预设、协议及 Go 配置，支持保存代理 URL。仍检查公开 HTTPS URL、协议兼容性，以及地址变化后重新填写或清除密钥。

## 修改文件

- `frontend/src/api/client.ts`、`frontend/src/main.tsx`：缓存读取与后台刷新。
- `frontend/src/offline/queue.ts`、`frontend/src/offline/sync.ts`：缓存范围及项目准备。
- `frontend/public/navigation-worker.js`：工作台入口缓存优先。
- `frontend/src/pages/AiSettings.tsx`、`shared/ai-providers.ts`：API URL 编辑与供应商校验。
- 回归测试：`frontend/src/api/client.offline.test.ts`、`frontend/src/offline/prepare.test.ts`、`frontend/src/navigation-worker.test.js`、`frontend/src/pages/AiSettings.test.tsx`、`backend/test/21-provider-adapters.test.ts`、`frontend/e2e/offline-workspace.mjs`。
- `frontend/src/help/TECHNICAL-IMPLEMENTATION.md`：更新实现说明。

## 浏览器验收

使用真实 Edge 浏览器与生产构建、真实 IndexedDB 和 Service Worker；API 返回本地固定夹具，不调用生产服务或付费模型。

运行方式（PowerShell，在 frontend 目录）：

```powershell
npm run build
npm run preview -- --port 5175
# 另一终端：PLAYWRIGHT_CORE 指向已安装的 playwright-core 模块。
$env:PLAYWRIGHT_CORE = '<playwright-core 的绝对路径>'
node e2e/offline-workspace.mjs
```

实测 10 项通过：

1. 生产 Service Worker 安装。
2. API 请求悬挂时，缓存任务在 2.5 秒测试期限内显示。
3. 后台任务更新后自动显示新标题，保留筛选状态。
4. 断网刷新。
5. 断网直达任务页，没有 OFFLINE_NOT_CACHED 提示。
6. 离线新增任务。
7. 打开缓存材料编辑器。
8. 离线保存并刷新恢复。
9. 重启浏览器后仍可恢复离线内容。
10. 重新联网自动同步，任务与材料写入各一次。

页面运行错误为零。结果及截图位于 `output/offline-verification/result.json`、`background-refreshed-tasks.png`、`offline-material.png`、`reconnected-material.png`。

## 自动验证

- 前端全量：128 个测试文件、772 项测试全部通过。
- 后端全量：`npm test --prefix backend -- --maxWorkers=4`，129 个测试文件、1174 项测试全部通过。
- 首次默认并发后端全量有一项 `82-agents.test.ts` 超过 5 秒超时（其余 1173 项通过）；该文件单独重跑 12 项通过，随后降低并发的全量复验通过。未放宽测试超时或改变测试断言。
- 前后端类型检查、前端 lint、生产构建及 `git diff --check` 全部通过。
- Workers 测试运行时仍输出 RPC dispose、Workflow dispose、请求取消及客户端断连诊断；降低并发复验退出码 0，断言全部通过。此次未修改这些既有运行时清理路径，也未屏蔽诊断。

## 边界

此验收针对本地构建和受控 API，尚未部署到生产。此前从未缓存过的数据无法凭空离线读取；旧版本漏掉的缓存需在修复版联网访问或自动准备后补齐。构建更新继续沿用应用既有的 Service Worker 更新确认流程。
