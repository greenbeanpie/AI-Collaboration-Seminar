# 材料检查历史翻页

- 右侧历史每页 6 条，保持最新在前；上一页／下一页及页码取代连续展开。
- 翻页只改变显示范围，不切换正在查看的评分报告或 URL。沿用服务器 50 条游标批次，跨批次显示前补齐；失败留在原页，支持再次尝试。
- 共用评分工作区的答辩历史同步使用该分页。无后端、数据库、接口或评分规则改动。

修改文件：

- `frontend/src/pages/AssessmentHistoryPages.tsx`
- `frontend/src/pages/AssessmentHistoryPages.test.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.tsx`
- `frontend/src/pages/AssessmentWorkspacePage.test.tsx`
- `frontend/src/pages/ProjectWorkspace.css`

验证：23 项组件测试；前端类型检查、lint、发布构建。内置浏览器使用同一组件与项目样式的本地模拟数据，确认桌面右栏每页六条、末页禁用按钮及翻页保留当前报告；生产浏览器无登录会话，未进行登录后验收。截图保存在 `output/history-pages-desktop.jpg`。HTTP 健康与静态资源哈希、最终提交／部署版本另存 `output/history-pages-release.json`。
