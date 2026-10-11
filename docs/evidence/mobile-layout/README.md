# 手机与平板布局验证

手机使用固定底部主导航，七个入口始终并列可见；项目内五个主分区、子分区和模板预览分区均使用直接可见的链接或按钮。手机正文与操作区优先纵向排列，平板保留完整菜单文字及适合宽屏的布局。

手机断点为宽度不超过 600 CSS px；触摸设备横屏且高度不超过 500 CSS px 也使用手机导航。平板 768/1024 CSS px 单独验证。Android 原生容器依据系统栏与刘海实际 Insets 留白，转发时保留输入法 Insets。

## 交付文件

- `frontend/src/components/AppShell.tsx`：手机菜单短标签、顶栏品牌、归档入口。
- `frontend/src/components/ProjectNavigation.tsx` / `.css` / `.test.tsx`：移除主分区和子分区导航下拉框；保留路由、历史与草稿离开保护。
- `frontend/src/styles/readability.css`：手机底部导航、正文留白、标题/工具栏排版；避免背景模糊改变 fixed 定位的包含块。
- `frontend/src/pages/TemplateDraftWorkspace.tsx` / `.css`：模板五个分区直接展示。
- `frontend/src/pages/DashboardPage.css`：指标标题与 AI 标记按整项换行，标题行随内容增高。
- `frontend/src/pages/CollaborationWorkspace.css`：任务设置字段、操作按钮和成员名称的窄屏排版。
- `frontend/src/pages/SourcesPage.css`：处理状态和操作分行；文件库标题使用单列 Grid，解决 Flex 换列溢出。
- `frontend/src/pages/TasksMaterials.css`：评论作者/时间及版本标题/时间分行。
- `desktop/src-tauri/gen/android/app/src/main/java/cn/buwei/mobile/MainActivity.kt`：Android 系统栏与刘海安全区域。
- `scripts/mobile-entry-fixtures.cjs` / `scripts/verify-mobile-entries.cjs`：当前任务统计夹具与可见导航入口检查。
- `scripts/verify-android-layout.mjs`：实际 Android WebView 尺寸、文字行、导航、截图与触摸验证。

## 验证结果

- 前端 159 个测试文件、968 项测试通过，类型检查、lint、生产构建通过。
- 桌面浏览器 320/390/768/1024 px 共 180 项页面、导航与权限入口检查通过；业务写入为零。
- BlueStacks Android 调试 APK：手机 320/390 px、手机横屏 844×390、平板 768×1024 和 1024×768；13 个页面 × 5 个尺寸，以及底部导航滚动留白与实际触摸，共 66 项检查通过。
- 模拟器按实际 `wm size` / `wm density` 调整，CDP 每次重新连接可见 WebView；截图由 ADB `screencap` 取得。检查后恢复模拟器尺寸、密度与旋转配置。
- Kotlin 编译及 x86_64 调试 APK 打包、签名校验、同签名覆盖安装成功；没有清除应用数据。安全区域检查要求 WebView 的原生 `screenY > 0`。

原版本 320 px 的“待响应任务”标题被挤成逐字换行，见 [修改前截图](before/phone-320-home.png)。新布局见 [手机首页](after/phone-320-home.png)、[手机任务](after/phone-390-tasks.png)、[平板首页](after/tablet-768-home.png) 和 [平板横屏任务](after/tablet-1024-tasks.png)。

机器可读证据：[Android 布局结果](after/report.json)、[浏览器入口结果](browser-entries/verification.json)、[调试 APK 原生库与文件哈希](android-artifact-report.json)、[签名检查](android-signature.txt)。

## 复现

先安装并打开允许 `http://127.0.0.1:5173` 的 x86_64 Android 调试 APK，开启 BlueStacks ADB（此处为 `127.0.0.1:5555`），再运行：

```powershell
$env:VITE_BUILD_VERSION = (git rev-parse HEAD).Trim()
npm run build --prefix frontend
$env:UI_ANDROID_NATIVE_INSETS = '1'
node scripts/verify-android-layout.mjs
```

脚本使用编译后的真实 React 页面与本地 GET 假数据，阻止外站请求和业务写入。首次运行需在现有调试 WebView 中已经打开 loopback 地址。可通过 `BUWEI_ADB_PATH`、`BUWEI_ADB_SERIAL`、`UI_ANDROID_DIST`、`UI_ANDROID_PROFILES`、`UI_ANDROID_ROUTES` 调整工具路径、设备和验证范围。

浏览器入口检查在 `npm run preview --prefix frontend -- --port 5237` 下运行，配置现有 Playwright/Chromium 路径，并设置：

```powershell
$env:UI_WIDTHS = '320,390,768,1024'
$env:UI_ENTRY_FILTER = 'route:|global-menu-clicks|project-groups-and-subsections|template-all-five-sections|settings-tabs-clicks|no-browser-runtime-errors'
node scripts/verify-mobile-entries.cjs
```

## 验证边界

调试 APK 复用模拟器原已安装调试版的 x86_64 Rust 原生库，库 SHA-256 完全一致；本次重编译 Kotlin 宿主以验证 Insets 改动。这是布局验证夹具，不是新的正式发布包，未进行 ARM64/Rust 完整发布构建。

只使用本地合成数据；未部署、未推送、未调用付费模型。真机、刘海实体设备、iOS 及输入法弹出行为未验收。代码编辑器和文档表格允许必要的局部横向滚动。

现有 Tauri/Gradle 自动生成代码有弃用提示；CDP 导航的 Tauri 注入重复属性提示在原版本也出现，记录在原始报告中。没有新增项目源码编译警告，未压制依赖提示；布局验收不替代原生全功能验收。
