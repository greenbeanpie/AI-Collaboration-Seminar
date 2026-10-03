# 程序员接手手册发布记录

2026-10-03。技术手册入口：`https://greenbp-team-office.hddhp.workers.dev/app/help?doc=technical`；数据库字典：同页 `?doc=database`。登录后左侧「帮助文档」可切换使用说明、技术实现、数据库字典。

## 内容与文件

- `frontend/src/help/TECHNICAL-IMPLEMENTATION.md`：20章，约100KB；代码路线与完整路径索引、数据库关系及核心字典、状态/CAS/幂等、AI作业/API/执行器/协议/工具/检查点/预算/审计/发布链路、排查SQL、本地开发、迁移、发布和典型扩展。
- `frontend/src/help/DATABASE-SCHEMA.md`：78张业务表逐列字典，723列、主外键、NULL/default、唯一性、显式索引、完整DDL；附1个视图及5个触发器。每张表独立目录章节，支持按表名或字段名搜索与完整下载。
- `frontend/src/pages/HelpPage.tsx`、`HelpPage.css`、`HelpPage.test.tsx`：数据库阅读入口、安全围栏代码渲染、章节解析及转义/数据库路由回归；手机换行菜单和折叠目录保留。
- `README.md`：接手文档和只读验证命令索引。
- `scripts/verify-handover-docs.py`：源码路径、链路符号、SQL示例、迁移重放及发布字典DDL核对。
- `scripts/verify-help-ui.cjs`、`verify-help-production.mjs`：三份文档和对应线上深链接/资源核对。

普通用户使用说明未改写为开发者说明。技术手册以 `415b0e0` 加当前工作区源码为依据，明确区分六个未提交后端服务文件与生产业务版本。

## 结构与事实核对

36个结构迁移在空的SQLite内存库重放，跳过演示seed和破坏性的0033；发布字典全部SQL可在另一空库重建，并逐表匹配723列、FK、索引列及DDL、视图与触发器；完整性检查通过。没有修改现有本地或云端数据库。

额外只读查询生产sqlite_schema及迁移文件名，仅含结构，不读取业务行；排除平台和迁移记录系统表后，78表/723列、1视图、5触发器、51显式索引与兼容参考匹配。生产迁移记录37个文件包含seed、两个0025，不含0033。结构对比不证明业务数据内容、真实模型效果或未提交代码已上线。

`python scripts/verify-handover-docs.py` 验证76个源码路径、16个关键链路符号及7条只读SQL示例，详情见 `document-verification.json`。生产结构对比见 `production-schema-comparison.json`。

## 页面与发布验证

- 完整前端90测试文件、484项通过；TypeScript、lint、生产构建、Service Binding、production静态预检及diff检查通过，构建无警告。
- 真实Edge浏览器只读账户夹具：1440浅色、390深色、375/320/790浅色全部通过。验证全部菜单可见、三份文档、78字段表、代码块、搜索/空结果/目录跳转/深链刷新，以及三份下载逐字节与源文件一致；无页面横向溢出或运行时错误。
- 浏览器结果与截图见 `verification.json` 及本目录PNG。
- 线上帮助基础入口和两个文档深链接、入口JS/CSS、帮助JS/CSS状态200且SHA-256与本次构建一致；匿名会话401、health200。见 `production-verification.json`。
- 原前端版本：`13d9280b-51dd-41b9-8377-76b21d9134be`；新版本：`e51ae8e9-0548-4d24-bd9f-f5e821d6cb17`。仅部署既有前端Worker，API绑定保留。

当前无可用生产登录浏览器会话，登录后的线上交互未另行实测；本地浏览器提供普通成员阅读功能证据，线上检查提供发布资源证据。没有调用付费模型、迁移生产库或部署后端。原有后端与gitignore修改保留。
