# 全平台导航整合

主导航统一为“我的项目、支持与帮助、个人资料、搜索用户”。手机底部仍固定显示全部入口；平板和桌面沿用各自的布局。

“我的项目”现有邀请卡片承担加入入口，新建与归档只保留页内按钮。“支持与帮助”提供并列工单/文档分区。“个人资料”末尾显示按账户权限过滤的全部设置入口；设置位于 `/app/profile/settings/*`。顶栏头像在所有平台打开同一账户下拉栏，两个退出操作只在此栏中显示。下拉栏高于通知浮层，避免更新提示阻挡点击。

旧 `/app/settings/*` 与 `/app/help` 链接仍可使用，跳转时保留查询和锚点；旧管理员入口转入相应个人资料设置页面。原有管理员权限限制、未保存草稿拦截和离线退出/清理逻辑保留。

## 修改文件

- `frontend/src/App.tsx`：支持/帮助路由分区与设置旧链接兼容。
- `frontend/src/components/AppShell.tsx`、`frontend/src/styles/readability.css`：四项主导航、账户下拉栏、移除顶栏/侧栏新建与归档按钮。
- `frontend/src/pages/DashboardPage.tsx`：归档按钮移入项目页，复用现有加入、新建入口。
- `frontend/src/pages/PersonalProfiles.tsx` / `.css`、`SettingsLayout.tsx` / `.css`：资料底部设置、设置分类与返回入口。
- `frontend/src/pages/SupportHelpLayout.tsx` / `.css`、`WorkspaceLegacyRedirect.tsx`、`HelpPage.tsx`：工单/文档共用分区，兼容旧路径。
- 导航、账户隐私、角色边界、帮助切换、页面加载相关测试，以及三个验证脚本。

## 验证

- 前端 159 个测试文件、973 项测试通过；类型检查、lint、构建与 diff 检查通过。
- [浏览器结果](browser/verification.json)：320/390/768/1024/1440 px，250 项路由、菜单、项目入口、资料底部设置、账户下拉栏及权限入口检查通过；业务写入为零。
- [Android 结果](android/report.json)：BlueStacks 实际 Android WebView，手机 320/390 px、平板 768/1024 px，24 项页面布局及底部导航触摸/留白、账户下拉栏触摸共 26 项检查通过；业务写入为零。
- 生产服务/D1/R2 发布前正常，旧发布版本信息保存在 `output/navigation-release/deployments-before.json`；部署配置预检查及 Wrangler dry-run 通过。

截图：[手机首页](android/phone-320-home.png)、[手机账户下拉栏](android/phone-account-menu.png)、[手机资料底部设置](browser/320-profile-footer.png)、[桌面资料底部设置](browser/1440-profile-footer.png)、[平板个人资料](android/tablet-1024-profile.png)。

## 发布与复现

前端通过主分支 Git SHA 构建，再以 `wrangler deploy --config frontend/wrangler.jsonc --env production --keep-vars` 发布。此导航改动无需数据库迁移或后端修改。线上资产哈希、健康状态和浏览器结果以 `output/navigation-release/production-report.json` 为准；若生产 Turnstile 未允许自动登录，报告会明确区分真实账户与合成 GET 数据的验证。

```powershell
$env:VITE_BUILD_VERSION = (git rev-parse HEAD).Trim()
npm run typecheck --prefix frontend
npm run lint --prefix frontend
npm test --prefix frontend
npm run build --prefix frontend
node scripts/verify-navigation-production.cjs --production
```

浏览器与模拟器验证沿用 `verify-mobile-entries.cjs` 和 `verify-android-layout.mjs`，需配置可用 Playwright/Chromium 和已安装的 Android loopback 调试 APK。未进行真机/iOS 原生安装验收；本轮共用前端布局适用于这些平台的页面。没有调用付费模型、业务写入或修改密码/密钥。
