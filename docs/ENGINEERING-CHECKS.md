# 工程检查与发布约束

CI 在 PR、main 推送与手动触发时执行锁定安装、前后端类型/测试、前端 lint、生成契约一致性、迁移不变性、常见秘密检测、两次发布构建哈希比较、生产配置预检与两个 Worker dry-run。CI 不部署，不携带生产秘密，不依赖 staging 占位配置。

开发版本固定为 `dev`。所有发布构建和部署预检必须显式设置 `VITE_BUILD_VERSION` 为 Git SHA，例如 `VITE_BUILD_VERSION=$(git rev-parse HEAD) npm run verify:reproducible-build`。哈希比较覆盖构建产物相对路径及每个文件 SHA-256，确保同环境、同提交两次清洁构建一致；不声称跨平台一致。

`npm run check:migrations` 固定校验 main@81873a4 的全部 60 个历史迁移，包括两个 0025。已有迁移不得改名、删除或修改。新迁移编号必须大于历史最大编号且不能重复。CI 额外以 PR 基线/推送前提交校验后续发布迁移，不允许修改初始基线清单。新增迁移必须向后兼容；检查编号不能替代 D1 迁移演练。

Dependabot 更新 backend/frontend 的 npm 依赖及 GitHub Actions。CodeQL 使用官方 action 扫描 JavaScript/TypeScript，每周及每次 PR/main 更新运行。仓库级 Secret scanning 与 Push protection 是 GitHub 服务设置，不能仅靠 workflow 开启；需具备管理员权限，私有仓库还需可用的 GitHub Secret Protection/Code Security 产品。使用 GitHub API 读取/设置后的实际结果应记录在发布报告；无权限或套餐不支持不能写成“已开启”。本地与 CI `check:secrets` 为不打印秘密的窄模式检测，覆盖私钥、常见 GitHub/OpenAI/Anthropic/AWS token；不替代 GitHub 的供应商验证与历史扫描。

运行 CodeQL 时须避免与 GitHub 默认设置重复启用。服务不可用或权限不足应记录为云端限制，不能通过把检查忽略失败来宣称通过。

官方说明：[CodeQL workflow](https://docs.github.com/en/code-security/code-scanning/creating-an-advanced-setup-for-code-scanning/creating-codeql-code-scanning-workflows)、[secret scanning](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning)。

## 本轮本地验证（2026-10-06）

- `node --test scripts/test/*.test.mjs`：4 项通过，覆盖历史迁移不变性、重复新编号、凭据模式检测和 CI 无部署约束。
- `node scripts/check-migrations.mjs 81873a4`：60 个历史迁移全部通过（保留两个 0025）。
- `node scripts/check-secrets.mjs`：当前已跟踪源码通过；该结果不代表完整历史扫描。
- 三份 GitHub workflow/Dependabot YAML 经锁定 frontend 安装中现有 `js-yaml` 解析通过；GitHub 托管运行待推送后验收。
- `VITE_BUILD_VERSION=81873a4 npm run verify:reproducible-build`：两次清洁发布构建成功，96 个文件 SHA-256 与路径完全一致。
- 删除 VITE_BUILD_VERSION 后运行 Vite build：按预期拒绝，未生成新的发布产物。
- `VITE_BUILD_VERSION=81873a4 npm run preflight:deploy -- production` 与 frontend typecheck：通过。
- `node scripts/archive-evidence.mjs --verify`：189 份归档全部通过文件大小与 SHA-256；随后移除 106 份冗余二进制历史证据。

本工作流没有运行本地浏览器；仓库级完整应用测试、集成部署验收和云端安全功能设置由合并后的发布报告记录。
