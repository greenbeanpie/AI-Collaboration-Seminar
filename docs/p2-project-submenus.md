# P2 项目子菜单样式与位置

项目子菜单现在直接位于五个主标签下方，使用相同的 `project-tab` 样式：13px 字体、600 字重、44px 最小高度、相同间距、主题色与 2px 选中下划线。移除原子菜单独立按钮的边框、圆角和填充背景。主行和子行的导航容器在 DOM 与画面中紧邻，桌面两行之间没有组标题或内容区留白。

790px 以下保留现有主菜单选择框，并提供相同样式的子菜单选择框。上下两级各有独立的导航名称和选择框名称。链接保持原 URL、`aria-current` 和 React Router 导航；选择框使用相同 router，仍受草稿离开保护约束。团队设置仍只在负责人导航中提供。

此次只将子菜单从 `ProjectSectionLayout` 移到 `ProjectShell` 的主菜单之后。组标题、说明文字和子页面大标题全部保留原文；没有移植此前的标题补丁 `9119314`。业务页面、后台、项目记录、模型设置和通知实现未更改。

## 验证

- 基于已发布通知提交 `21ed758d20675f4b7bf5871e503acc993b029f81` 的独立分支 `codex/p2-project-submenus`。完成验收后重新 fetch `origin/main`，仍是该提交，无组合代码变化。
- Node 26，`NODE_OPTIONS=--no-experimental-webstorage npm test`：61 个文件、339 项测试通过。现有导航测试扩展核验新子菜单选择框、别名和深链接选中状态、草稿取消保留；原 Back/Forward 和成员权限覆盖通过。
- ESLint、包含 TypeScript 检查的生产构建、`scripts/verify-worker.mjs`、`scripts/preflight-deploy.mjs production`、`git diff --check` 通过。
- Chrome/CUA 打开最终生产构建的 GET-only 本地 fixture。全部 12 个导航子页面分别在 1440×1000 / 390×844、浅色 / 深色下验收，合计 48 个完整组合。
- 所有组合 `scrollWidth === innerWidth`，导航容器紧邻且间距为 0，无页面错误或框架错误覆盖层；桌面主、子选中标签的字体、字重、padding、背景、边框、圆角、颜色和下划线 computed style 完全相同；手机均显示上下两个选择框且当前分区正确。
- 浏览器实际选择主组、切换子页面及 Back/Forward 正常；Tab 从主菜单选择框进入子菜单选择框，焦点样式可见（3px outline）。实际 Chrome 错误日志为空。
- 本地 fixture 审计：599 次 API GET，0 次 API 写请求；fixture AI 能力关闭，未产生真实 AI 调用或线上数据修改。
- 临时 Chrome tab 已关闭，viewport override 已重置。`agent-browser-verify` 技能已阅读；当前没有 `agent-browser` CLI，因此浏览器检查通过现有 Chrome/CUA 完成。

检查的子页面：项目概览、活动历史、任务看板、要求与评分、资料总览、导入资料、成果材料、团队成员、团队设置、导出、成果检查、答辩演练。`tasks` / `ai` 别名、材料深链接、查询与 hash 保留由导航与路由回归覆盖。

证据位于 `/tmp/p2-submenu-qa-20261002/`：`metrics.json`、`fixture-requests.json`、`desktop-light-overview.jpg`、`desktop-light-data.jpg`、`desktop-light-checks.jpg`、`desktop-dark-checks.jpg`、`mobile-light-data.jpg`、`mobile-light-checks.jpg`、`mobile-dark-checks.jpg`。测试与构建日志：`/tmp/p2-submenu-tests.log`、`/tmp/p2-submenu-build.log`。

此验收使用合成资料与 Chrome viewport，未声称实机 iOS / Android 或真实屏幕阅读器体验；屏幕阅读器语义由独立命名的 nav/select、原生 link 和 `aria-current` 保持。

## 发布交接

本分支完成后向父任务申请唯一串行 frontend 发布窗口。此交付阶段未快进 main、未推送 main、未执行生产部署。获得窗口后核对最新 main，必要时重基和回归，再正常 FF main 并部署既有 `greenbp-team-office --env production --keep-vars`；不强推，不创建新服务，不调整配置或密钥。保留通知提交，排除标题补丁 `9119314`。
