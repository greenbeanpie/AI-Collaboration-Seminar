# 补位 · AI 项目办公室

本仓库包含同源 Web/PWA、Cloudflare Workers 后端、现有 Tauri 客户端、Android 原生客户端、WinUI 3 Windows 原生客户端及 DSH Bridge。源码、测试、CI、构建/部署配置、迁移和许可证保留；本文件是唯一维护手册。`AGENTS.md` 属于工程执行配置，许可证属于分发必需声明。

## 入口

- [本地开发与验证](#operations)
- [使用说明](#help-user)
- [技术实现](#help-technical)
- [数据库字典](#help-database)
- [部署与恢复](#ops-backend-docs-deploy-md)
- [Android 原生客户端](#ops-android-native-readme-md)
- [Android 单设备回归与弃用边界](#android-validation-20261024)
- [Windows 原生客户端](#ops-windows-native-readme-md)
- [DSH Bridge](#ops-packages-dsh-team-office-bridge-readme-md)

<a id="android-validation-20261024"></a>
## Android 单设备回归与弃用边界（2026-10-24）

先构建、等待 Gradle 退出，再启动一台模拟器进行测试；不要并行启动第二台模拟器或在仪器测试期间构建。低内存机器可按以下方式限制构建资源：

```powershell
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME = 'D:/Android/Sdk'
./android-native/gradlew.bat -p android-native :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug --no-daemon --max-workers=1 --warning-mode all '-Dorg.gradle.jvmargs=-Xmx1536m -Dfile.encoding=UTF-8'
# 构建结束后，启动或复用唯一一台模拟器：
./android-native/scripts/test-device.ps1
# 只复验某个测试类时：
./android-native/scripts/test-device.ps1 -TestClass cn.buwei.nativeapp.PrototypeThemeInstrumentedTest
```

`test-device.ps1` 只安装预览 Debug APK 并串行运行仪器测试，不启动模拟器或 Gradle，不清空应用数据。发现多台模拟器（包含 offline）时直接拒绝，即使指定了 `-Serial`；无唯一可用设备时也拒绝。它保存原始仪器测试结果到被 Git 忽略的 `output/verification/android-device/instrumentation.txt`，并检查 AndroidJUnitRunner 的完成结果，不把 ADB 退出码 0 当作测试通过。`-ValidateOnly` 可离线验证设备选择保护逻辑。

本轮修复经典绿主题遗漏前景色而出现默认紫色文字的问题，并为浅深色的文字/容器组合增加最低 4.5:1 对比度回归。依赖版本固定为 Gradle 9.8.2（校验官方 SHA-256）、DataStore 1.3.0、kotlinx.serialization 1.12.0、OkHttp/MockWebServer 5.5.1、Firebase Messaging 26.0.1，以消除相应旧版本提醒。版本依据：[Gradle](https://docs.gradle.org/9.8.2/release-notes.html)、[DataStore](https://developer.android.com/jetpack/androidx/releases/datastore)、[serialization](https://github.com/Kotlin/kotlinx.serialization/releases/tag/v1.12.0)、[Firebase](https://firebase.google.com/support/release-notes/android)。

AI 对话仪器测试增加响应正文延迟，并等待答案真正进入 Compose 界面；模拟服务器设置“已派发”标志只证明请求已处理，不能作为界面刷新完成的条件。最终仍断言答案正文可见、原生响应可达，且只发送一次问题。

本轮 Android 验证：166 项 JVM 单元测试通过，修复等待竞态后重新全量运行的 169 项手机仪器测试通过，同一模拟器切换为 1600×2560 / 240 dpi 后的 14 项外观、引用设置、帮助和项目概览测试通过。手机及平板尺寸的实际启动检查通过，浅深色主题和大字体截图已抽查。Debug 和 Release/R8 构建通过；lint 为 0 错误、1 项既有 EST 依赖告警，Release `-checkdiscard` 通过且映射不含 EST 类。中途失败的全量结果及后续通过结果均保留在 `output/verification`，不能把先前失败轮次计为通过。平板尺寸测试使用同一 AVD，不代表独立平板硬件验收；全程最多一台模拟器在线。

以下上游警告仍须明确保留，不能称为“弃用警告已全部解决”：

| 来源 | 已验证的原因 | 后续处理与通过条件 |
| --- | --- | --- |
| AGP 9.4.1 / `Configuration.setVisible(boolean)` | `--warning-mode all -Dorg.gradle.deprecation.trace=true` 定位到 AGP `BasePlugin.createAndroidJdkImageConfiguration`，不是项目 SourceSet 或 baseline profile 配置。Google Maven 当前没有更新的稳定 AGP；9.5 尚为 RC。 | 待稳定 AGP 移除此内部调用后升级，再以同样的完整构建和仪器测试验收；最后用 `--warning-mode fail` 确认无 Gradle 弃用。不要降级 Gradle、关闭警告或修改缓存 JAR 来伪装修复。 |
| DataStore 内嵌 protobuf / `sun.misc.Unsafe.arrayBaseOffset` | Android Studio JBR 25.0.3 运行本地 JVM 单元测试时触发；1.2.1 和最新稳定 1.3.0 均复现。升级 DataStore 本身没有解决它。 | 需要 AndroidX 更新其 shaded protobuf 的 JVM 内存访问实现；普通 `com.google.protobuf` 版本覆盖不到此私有命名空间。上游修复后用 JDK 25+ 重跑 DataStore 恢复、账户隔离及全部单元测试，确认日志无 Unsafe 弃用；继续保留 Android ART 上的仪器回归。不要设置 Unsafe `allow` 或过滤日志。 |

真实登录、生产写入、付费模型、真实麦克风/摄像头和长时间设备稳定性不属于本轮本地 fixture 验收。

<a id="operations"></a>
## 本地开发与验证

前端使用 React/TypeScript/Vite，后端使用 Hono、D1、私有 R2 与 Workflows。同源 `/api/v1` 返回真实业务数据，API 失败不会回退演示成功。运行依赖以锁文件为准；构建需要支持当前 Vite 的 Node.js、.NET 10/Windows SDK，以及 Android 项目的 JDK/SDK。

```powershell
npm run install:all
# backend/.dev.vars 从 .dev.vars.example 创建；已有文件和本机凭据应保留。
# 按当前配置初始化本地 D1（只操作本地数据库）：
# cd backend; npx wrangler d1 migrations apply DB --local; cd ..
npm run dev:backend
# 在另一个终端运行：
npm run dev:frontend
```

```powershell
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend
npm run test:engineering
npm run check:migrations
npm run check:secrets
python scripts/verify-handover-docs.py
$env:VITE_BUILD_VERSION = (git rev-parse HEAD).Trim()
npm run build
```

部署、生产迁移和远端写入需要单独授权；本次整理不会执行。保留既有资源 ID、密钥、用户数据与迁移历史。构建产物、部署 dry-run 输出、截图和验证报告写入被忽略的 `output/` 或平台 build/artifacts 目录，不进入源码。原型/历史截图、发布流水账及旧临时文档已清理，Git 历史可追溯。

## 客户端边界与文档维护

Windows 与 Android 使用原生业务界面，复用现有账号/权限/服务端协议；旧客户端及未同步数据不自动迁移。真实账号、付费模型、语音设备、生产 Windows 授权与长时间验收不能由源码或本地测试代替。后文保留的历史验证数字只针对原冻结版本，不代表本次重新验收。

网页帮助和 Android 打包帮助均从下列 `help:*` 标记区段提取；下载文件名维持原有名称。修改帮助时必须保留唯一成对标记。Android 的帮助 assets 在构建目录生成，校验摘要需同步到 `HelpWorkspaceDocuments.kt`；不维护多份 Markdown。数据库字典通过内存 SQLite 与迁移逐项比对；变更迁移后运行 `python scripts/update-handbook-schema.py` 更新本文件和 Android 帮助摘要，再运行 `python scripts/verify-handover-docs.py`。

<a id="help-user"></a>
<!-- help:user:start -->
# 用户使用说明

文档核对日期：2026-10-03。

本说明面向使用「补位 · AI 项目办公室」开展团队项目的成员与项目负责人。你可以在这里整理要求、分配任务、协作编写材料、练习答辩并保留过程证据。系统中的 AI 草稿、辅助分数和检查结果用于团队改进，最终申报格式、截止时间和提交状态仍须以官方平台为准。

常用入口：[我的项目](/app)、[新建项目](/app/projects/new)、[加入项目](/app/join)、[个人资料](/app/profile)、[支持工单](/app/support)。

## 1. 登录与个人设置

### 注册、登录与密码

首次使用时，在登录页切换到“注册”，填写用户名、密码与 16 位注册邀请码，邮箱选填。用户名为 3–32 位字母、数字、下划线或连字符；密码长度以页面提示为准。注册邀请码由网站方提供，成功使用后失效，它与加入某个项目的邀请码不同。

已有账户可用用户名或已绑定邮箱登录。“游客演示”用于了解界面，不能代替真实账户的项目记录。登录后，左侧“我的项目”是工作入口；进入项目后，通过“概览、任务、资料、评分、团队”切换功能。

在“设置 → 账户信息”修改昵称，点击“保存昵称”后会同步显示在项目成员中，登录用户名不变。在“账户安全”填写原密码与两次新密码，确认修改后所有设备都会退出，请用新密码重新登录。忘记密码或账户受限时，通过网站提供的联系渠道求助；能登录时可使用“支持工单”。

### 个人资料与隐私

点击左侧“个人资料 → 编辑资料”，填写自我介绍、专业、技能与特长、倾向职位，分别勾选是否公开；右侧可对照自己的内容预览与公开展示预览。自我介绍支持页面列出的 Markdown 格式。完成后点击“保存资料与隐私”，预览中的修改才会生效。

“允许通过用户名搜索我”开启后，其他登录用户可以用完整用户名查找你，并查看已公开字段。关闭后，搜索与个人主页不可用。“搜索用户”按完整登录用户名查找，不能用昵称代替。

公开展示与 AI 使用是两项独立选择。只有勾选并保存“AI 任务偏好推荐”授权，相关个人资料（包括隐藏字段）才可发给所在项目使用的 AI 提供商。请先阅读授权说明；取消勾选并保存可撤回后续使用，已经开始发送的请求无法收回。每周总可用时间仅本人可见，始终不会发送给 AI。旧项目资料导入需要逐字段选择并保存，不会自动覆盖全局资料。

## 2. 创建与加入项目

### 分步创建：手动任务或 AI 预览

1. 点击左侧“新建项目 → 分步创建”，填写项目名称、说明、截止日期与可选主目标。未知日期可以留空。
2. 按需上传项目文件。文件类型、大小与数量以当前页面提示为准；此时资料只暂存在你的私有草稿中。
3. 填写组员总人数与邀请对象的完整登录用户名。人数用于规划；正式创建后才向这些用户发送邀请，对方接受后成为成员。
4. 在任务预览中填写目标与拆分要求。可以点击“添加手动任务”，逐项写明标题、内容、验收标准、预计工时与前置任务，再点击“保存当前任务预览”；也可以确认暂不创建任务。
5. 启用 AI 智能协作且当前服务可用时，可以生成 AI 拆分预览。核对目标、任务、引用原句与页码，修改后重新保存预览。
6. 进入最终确认，检查配置并创建。成功后进入项目；需要分享的邀请链接请及时复制保存。

“主目标”是团队整体目标，不计入任务数量或工时。重新生成 AI 预览可能产生新用量；确认创建使用已确认的结果。“保存草稿并返回”可暂时离开，在新建项目页继续已有草稿。网络中断时，先刷新草稿状态并核对是否已经创建成功，避免另建重复项目。

### 模板与项目邀请

“选择模板”打开项目形式的私有草稿；当前入口提供空项目模板。你可在各分区配置并预览，再保存为正式项目。草稿不是正式团队项目，保存创建后才进入正常协作。

收到用户名邀请时，在“我的项目”处理接受或拒绝。收到邀请码或邀请链接时，登录后打开左侧“加入项目”，按页面提示确认加入。邀请码可能已过期、已用尽或已撤销，遇到这些情况请联系项目邀请人。

负责人或获准管理团队的成员，可在“团队 → 团队成员”邀请新成员、查看未完成任务负荷并处理成员。邀请码原码只在创建时显示一次，应立即复制；有效期和可用次数以该邀请实际配置为准。

## 3. 理解项目权限与进度

“项目概览”汇总已保存的主目标、任务、成员、材料和要求状态，待处理事项会优先显示与你相关的任务。“活动历史”用于回看项目过程；它不能代替任务详情中的成果版本和验收记录。

普通成员可以读取项目、认领与提交自己的任务、上传文件，并在有权限时发起评分或答辩。团队管理、任务管理、资料管理、评分发起、历史评分修正分别授权；项目负责人拥有项目管理能力。团队中的“协作管理员”是项目权限模板，不等于网站管理员。只有项目负责人可以修改成员权限；拥有团队管理权限的成员可以邀请成员、移除其他非负责人成员，但不能修改任何人的权限。系统管理员和超级管理员身份在项目中不提供额外权限或移除保护，其项目能力同样取决于项目身份与显式授权。某个管理按钮没有出现时，先联系项目负责人确认你的权限。

负责人在“团队设置”决定项目是否启用 AI 智能协作，以及分工、验收采用自动应用还是负责人确认。请在开始协作前约定这些业务规则。标准由项目负责人保存；最新保存版本立即生效，不需要确认。

## 4. 任务：认领、成果与验收

### 按验收标准推进

在“任务 → 任务工作区”筛选待认领、进行中、待验收、已通过、已完成（待人工审核）、需改进或需重做的任务。项目中的任务均为平级任务，主目标单独保存；任务之间用前置依赖表达执行顺序。列表按前置依赖顺序显示；前置尚未完成只作提示，允许提前认领、执行与提交，但应与上下游成员确认信息是否可用。

任务设置窗口以“任务设置·任务名”显示，内容和分工默认展开；标题旁的“修改”按钮开启编辑。任务名称与预计投入并排，前置依赖位于内容与分工之间。前置选择页可搜索，列表顺序与任务界面一致。有效修改停止输入三秒或离开编辑区域后自动保存，关闭窗口前会等待保存；失败、必填内容缺失或同字段冲突会保留草稿并阻止关闭。未修改的字段采用最新内容，冲突字段可选择保留自己的修改或使用最新内容。顶部状态以颜色突出，旁边“更新”打开独立窗口，按当前权限执行认领、提交、验收或重新打开；必要操作仍须填写理由。

没有执行人的待认领任务可点击“我来认领”。点击“查看与提交”，阅读任务介绍、验收标准、依赖和来源依据。负责人或具备任务管理权限的人可新建任务、调整标准与安排分工；调整理由会帮助团队理解变化。重新分配待验收任务会撤回当前提交并使待处理评价失效，历史记录仍保留。

需要 AI 拆解、调整或安排未认领任务时，由具备任务管理权限的成员打开“AI 拆解、调整与分工”，选择固定资料版本、填写目标或调整要求并生成建议。核对预览中的任务、依赖、分工理由与引用，再按项目模式确认应用；过期建议应重新核对，不要覆盖后来发生的修改。

项目成员可在对应任务中向任意其他项目成员创建一对一“任务质询”工单。工单及双方往来消息统一保存在该任务内，发起者和质询对象都从此任务查看、回复；项目其他成员看不到工单内容。任务卡片会显示红色未读提示，打开并展示消息后标记已读，通知直接跳转到工单所在任务。

任务生成并保存后，系统在后台自动检查 AI 执行适用性；任务说明或验收标准变化后会重新判断。点击“AI 辅助”可以同时查看“辅助计划”和“代实施”。辅助计划由你点击生成，保存后再次打开直接读取；上下文变化时会提示计划过期，可主动重新生成。需要真人参与的任务也可以生成辅助计划。

适用性检查通过后，“代实施”可以将任务交给已配置的 DSH，或复制、下载提示词交给本地 Agent。打开“AI 辅助”本身不会派发任务。DSH 配置说明、设备状态、项目授权和默认设备位于“设置 → 本地 Agent”；本地工作目录在 DSH 中选择或修改。完成配置后，DSH 启动和网络恢复时自动连接；成果回传为草稿，仍需核对后提交验收。

需要真人到场、取得新的现场资料或实际操作的任务，以及包含这类步骤的混合任务，会禁用交接并显示模型给出的原因。已有调研资料的分析、方案设计等数字工作可通过检查。未检查、检查中、检查失败或 AI 服务关闭时，交接保持禁用；失败后可手动重试。修改任务标题、说明或验收标准后需要重新检查。判断通过不代表任务已经完成，成果仍须由执行人提交验收。

### 提交固定版本成果

1. 先在“资料”编写成果文档并保存新版本。
2. 返回任务详情，在“成果说明”逐项说明如何满足标准、成果位置和待解决问题。
3. 在“成果文件”直接上传文件，文件自动加入材料库并归属当前任务；每轮最多 10 个未归档文件。也可仅提交文字说明。上传或入库失败时先重试或移除待上传项，再提交。上传 DOCX、PDF、XLSX、PPTX、TXT、MD 文件时会自动提取正文写入材料，材料检查的 AI 评分可直接引用；扫描件、图片与音视频不提取正文，评分时视为无可核对材料，请先在“来源”完成 OCR 或把文字粘贴为文档。
4. 点击“提交本轮成果”。系统和项目 AI 启用时，本轮会自动评价一次；AI 禁用时不评价，由项目负责人或拥有任务管理权限的成员验收。

固定版本保存本轮评价对象，之后继续编辑材料不会改变这轮提交。未保存的本机内容不会自动成为提交依据。只有任务执行人可提交自己的成果；尚未分配时应先认领或由项目负责人或拥有任务管理权限的成员分工。

“需改进”或“需重做”后，在任务提交窗口更新已有文件、上传新文件，或归档不参与本轮的文件，再提交新一轮。归档文件在“已归档”入口恢复；整份材料归档也需要单独撤销。当前任务执行人可管理所属任务文件，资料管理者可管理项目文件。更新产生新文件和材料版本，过去各轮成果不会改变。项目负责人或拥有任务管理权限的成员核验后选择通过、改进或重做，并填写验收理由。可以通过“查看与提交”窗口标题栏、关闭按钮左侧的“查看历史记录”对照各轮说明、当时标准、绑定版本和决定。

自动验收模式下，正文证据符合标准、仅附件或外部引用尚未核验时，任务可先成为“已完成（待人工审核）”，计入完成数量并允许后续任务继续推进。项目负责人或拥有任务管理权限的成员在“查看与提交”中点击“确认人工审核”，核对附件或引用后选择通过、改进或重做。正文证据不足或评价不合格时不会先行通过。每轮只自动评价一次，没有手动重新评价入口；评价失败时保留成果，项目负责人或拥有任务管理权限的成员可人工验收。改进或重做后提交新一轮成果，AI 启用时新一轮会再次自动评价一次。

## 5. 资料：原文、文档、版本与贡献

### 导入来源并核对解析

进入“资料 → 项目资料”，点击“新增资料”，选择粘贴文本、网页链接或文件，也可选择录音、录像或拍照，预览后确认上传。网页能否读取取决于页面可访问性；文件支持范围和限制以页面提示为准。上传文件时确认贡献者，再导入。

解析状态与逐页处理状态显示在来源详情中。导入完成不一定表示解析完成；扫描 PDF 可能需要补充页面图片或按页面提示处理。展开全文片段，对照原文件核验引用、页码、日期与要求。提取出的要求是草稿，需要到“评分 → 项目标准”复核。重新解析产生新草稿，不应把新 AI 输出直接当成已经确认的规则。

### 编辑文档与恢复资源

点击“新增资料”，选择“新建文档”，填写标题和背景、参考资料或成果用途。选择文档后，用工具栏编写正文，点击“保存新版本”才形成服务端版本；可查看“材料版本历史”、讨论或导出文件。资料列表支持按标题搜索和按用途筛选。

附件变更也会生成新版本，先保存正文再调整附件。上传时按实际贡献选择成员，文件详情会展示贡献者；“移除关联”改变文档附件关联，原文件另由文件库管理。

“附件与回收站”显示项目文件及回收资源，尚未上传完成的文件也可能出现。按权限移入回收站可停止关联处理，恢复后可重新使用。历史引用和版本仍保留；来源已移走时会标记原文件不可用，不代表历史引文被删除。

离线编辑可能按账户、项目和材料保存在本机，取决于浏览器存储是否成功。联网后需要你确认，系统不会自动提交。遇到版本冲突，先对照本机草稿与服务端最新版本，再按页面提示处理；不要直接覆盖同伴修改。更换设备无法读取另一台设备的未提交草稿。

## 6. AI 协助成果与执行状态

在文档中点击“打开 AI 协助”，选择“代做、带做或只审”、AI 角色、关联任务、补充说明和所需固定资料版本，然后开始协作。代做与带做生成待复核草稿，只审提供审阅意见；带做时按已保存的问题继续回答。

会话记录与任务进度由服务端保存，可以选择已有会话恢复。排队中或运行中表示尚未结束；失败时先看原因与已保存历史，确有重试入口时再重试，避免连续重新发起。工具调用记录可查看本轮文件读取与搜索情况。互联网搜索须该项目支持且本轮明确允许，只填写可公开的查询。

AI 草稿返回后，检查事实、引用、占位符与缺失内容，修改草稿，选择采纳目标并确认复核，再点击“确认复核并采纳”。采纳创建新材料版本，保留草稿与人工修改记录；它不会自动完成任务。目标材料已变化时，先核对最新内容后再采纳。AI 不可用时仍可手动创建、分工、提交和验收。

## 7. 标准、材料检查与答辩演练

负责人进入“评分 → 项目标准 → 新建标准”，可导入已提取要求，逐项核对说明、日期与来源引用，并决定哪些要求参与评分、哪些只作检查项。填写评分维度和权重，点击“保存并生效”后，本版本立即成为唯一生效标准。后续通过“修订生效标准”保存新版本，旧版本只读；历史评分继续保留当时依据。

在“材料检查”自动使用生效标准，选择评价对象的固定文档版本，确认项目有明确主目标后开始本轮检查。查看独立评分记录中的总分、维度意见、要求检查、证据与限制。证据不足时可能无法产生数值评分，应先补充材料，再进行下一轮；有相应权限时可人工评分或修正历史结果并记录理由。

在“答辩演练”自动使用生效标准，选择所需材料，开始一轮真实文字问答。等待问题返回，再提交实际回答；结束后生成总结和评分。只有发起人可操作这场共享演练的回答、结束与重试，其他成员可以阅读记录。评分以保存并冻结的问答为证据，不能用空回答代替真实练习。

## 8. 通知、导出与求助

“设置 → 推送与通知”可查看通知历史、配置网页顶部提醒和当前设备系统通知。系统通知需要浏览器权限与设备订阅；不支持、已拒绝权限或推送尚不可用时，仍可使用站内历史。系统推送是否送达还受设备与浏览器影响，重要截止事项应同时自行安排提醒。退出登录会取消当前设备订阅。

在“团队 → 导出”先读取或“刷新数据”，再下载 JSON 汇总与 Markdown 整理稿，留存任务、标准、成果版本、评分和过程记录。导出是团队留档材料，不能代替官方申报与最终提交。

遇到问题，打开左侧“支持工单”，填写标题、问题描述、分类、紧急度与可选截图，提交后进入工单查看和回复。说明操作步骤、出现时间、错误提示和相关任务 ID 有助于定位；不要填写密码、验证码、API 密钥或支付资料。

## 9. 常见问题

- 项目找不到：确认登录的是接受邀请的账户，并检查邀请是否已接受、成员资格是否仍有效。
- 按钮不可用：先检查必要字段、固定版本、生效标准、当前权限与任务状态，阅读页面提示。
- AI 一直处理中：刷新读取已有任务状态；网络中断不等于服务端失败，不要重复新建同一操作。
- 成果修改后评分没变：已有评分绑定旧固定版本，需选择新版本开始新一轮检查或提交。
- 上传成功却没有要求：文件保存与解析是两个步骤，检查来源处理状态，并对照原文人工补充或修正标准。
- 多人编辑冲突：保留草稿、加载最新服务端版本、逐项核对后再保存，避免用过期内容覆盖新修改。


### 联网自动同步

进入项目、恢复联网和重新回到页面时，系统自动同步本机待处理操作并刷新项目离线缓存。正常联网时不再显示离线准备横幅。离线、同步失败和需要处理的冲突仍有提示；冲突操作保留本机内容，核对后再提交。

### 文件分类与归档

资料浏览左侧按任务分类展示上传文件，任务顺序与任务界面一致；没有明确任务归属的历史文件及公共上传文件进入“公共文件”，普通文档和系统背景仍可独立选择。文件和材料可以分别归档；归档内容从普通列表隐藏，在“已归档”入口只读查看、下载及恢复。材料归档后不能编辑或采纳 AI 修改，文件更新需先恢复归档。公共文件由上传者或资料管理者管理，系统管理员身份不提供额外项目权限。

AI 的自动选材、普通搜索和默认任务上下文排除归档内容，历史提交评价或明确指定的固定历史引用仍可读取。归档保留原文件及历史，与回收站不同。任务中的前置文件选择使用叠加弹窗，可搜索多选，关闭前等待自动保存。

### 项目标准的展示与引用

“评分”下的项目子菜单提供项目标准、材料检查和答辩演练。项目标准上方的黄色提示区分项目级与任务级标准，“任务”链接可进入当前项目任务页。标准阅读区仅显示评分维度、权重和编号参考文件；维度旁的上标对应底部文件，同一固定文件复用编号。文件链接打开被引用的固定文件，来源不可用时只保留文件名与编号，可在提示中查看状态。新生成和修订的标准仅包含评分维度、权重及评分方法引用，不再生成或编辑要求清单、截止日期、长说明或其他提示性要求；历史数据不删除，新建、生成、修订和历史查看入口保留。

任务提交记录的正文默认收起，点击“展开提交内容”可查看完整文本；再次点击收起。当前轮次和历史轮次均采用此方式，轮次、时间、提交人、成果文件与验收操作仍可查看。

### 纯评分生成与错误原因

AI 生成只输出评分维度与权重。资料有已有评分方法时，引用仅含该项真实评分名称和分值，引用保留到编辑、保存和历史读取，并显示编号文件链接。资料没有已有评分方法时，仅根据项目主目标提出维度和权重，不引用、总结或照抄其他资料原文，不增加提示性要求。旧格式的生成结果会被拒绝，需重新生成。

所有页面的错误提示保留后端原因原文与换行，不按错误码替换原因，也不显示错误码、请求编号和堆栈。重试、刷新等正常恢复按钮仍保留。

## AI 处理状态与失败续跑

在使用 AI 的功能内部，可以查看排队、处理中、等待补充信息、等待重试、完成或失败状态，以及当前正在执行的操作。分块处理会展示已完成数量；展开“操作记录”可查看步骤与时间。AI 最后一次回复时间按当前设备时区显示到秒，表示最近一次模型返回，包括中间回复；不是任务创建时间。尚未收到模型回复时会明确显示。

读取状态失败时，点击“重试”重新读取状态，不会重新执行模型任务。AI 任务执行失败时，点击“从停止处继续”复用已完成步骤和已保存响应，继续未完成部分；刷新或离开再返回也能恢复记录。任务内容、依据版本或权限发生变化时，需要重新发起。

上次请求结果不明时，点击继续会直接重新请求未完成步骤，可能再次计费；单次模型请求不能从内部生成位置继续。处理完成后保留回复时间和操作记录，模型草稿仍需核对。系统本地朗读显示播放状态。
<!-- help:user:end -->

<a id="help-technical"></a>
<!-- help:technical:start -->
# 系统技术说明：实现结构与维护验证

核对日期：2026-10-03。本文按现行路由、服务、迁移和测试编写；本次同步平级任务及待人工审核的实现说明。任务父子关系由增量迁移 `0043_remove_task_parent.sql` 移除。生产是否已应用迁移，应以发布验证记录和实际迁移状态为准；文末保留早期核对记录。

本文详细说明功能修改入口、数据归属、AI 请求执行链路及失败恢复条件，为代码阅读、系统维护与实现核对提供依据。先读代码地图、数据库关系和 AI 链路；需要某张表的全部字段或 DDL 时，打开[数据库完整结构字典](/app/help?doc=database)。资料整理、AI 评价及分数均为协作辅助结果，正式评审与供应商实际模型行为需要单独核验。

此前只读核对了生产数据库结构，不读取业务数据；该核对早于移除历史父任务字段的变更。文档不包含账户凭据、生产资源标识或模型密钥。代码路径相对仓库根目录，命令的环境与工作目录在对应章节标明。

## 1. 阅读顺序与代码地图

### 首次阅读顺序

本文依据当前工作区源码核对，先建立“页面 → API → 服务 → 数据表 → 后台作业”的地图，再阅读专项实现。建议依次阅读：根目录及两个子项目的 `package.json`；`frontend/src/App.tsx`、`components/ProjectNavigation.tsx`；`frontend/src/api/client.ts`；`backend/src/index.ts`、`app.ts`、`env.ts`；`core/auth.ts`、`services/project-permissions.ts`；相关 API 的 Zod 请求/响应与业务 handler；相应 service、迁移及测试。最后沿 `jobs.ts`、Workflows 与 AI gateway 深入异步执行。旧设计文档可解释历史背景，实际接口、权限和菜单以源码为准。

仓库不是前后端共同打包的单一应用。`backend/` 是 Hono Worker、D1/R2 访问、AI 服务和 Workflow；`frontend/` 是 React/Vite SPA 及转发 API 的独立 Worker；`scripts/` 是跨项目验证、发布预检和备份演练；`README.md` 统一维护手册，历史证据不再保留在源码中。根目录脚本使用 `--prefix` 分别执行两个项目；安装应使用各自锁文件的 `npm ci`，避免临时升级改变依赖版本。

### 功能修改入口

项目一级菜单当前只有概览、任务、资料、评分、团队五组。入口在 `ProjectNavigation.tsx` 的 `groups`；`App.tsx` 保留旧 URL 的 `ProjectRouteRedirect`，例如 sources/materials/ai 进入 data，requirements/reviews/rehearsals 进入 assessment。菜单扩展应以现行功能分组和路由映射为依据，不应按旧版页面数量重新增加菜单。`ProjectShell.useProject()` 提供项目上下文，使用 `['project', projectId]` 查询项目；页面必须位于该壳内。

| 需要修改的功能 | 前端入口 | 后端入口与深入阅读 |
| --- | --- | --- |
| 登录与个人账户 | `auth.ts`、`LoginPage.tsx`、`AccountSettingsPage.tsx` | `api/auth.ts`、`api/account-settings.ts`、`services/accounts.ts`、`password.ts` |
| 项目资料与材料编辑 | `DataWorkspacePage.tsx`、`SourcesPage.tsx`、`MaterialsPage.tsx` | `api/files.ts`、`sources.ts`、`materials.ts`、`resources.ts`；`services/files.ts`、`parse.ts`、`source-lifecycle.ts` |
| 任务分工与依赖 | `TasksPage.tsx`、`api/simplification.ts` | `api/tasks.ts`、`project-simplification.ts`；`services/project-simplification.ts`、`task-readiness.ts`、`assignment.ts` |
| 标准、评分及演练 | `AssessmentWorkspacePage.tsx` | `api/project-simplification.ts`、`reviews.ts`、`rehearsals.ts`；`services/assessments.ts`、`rehearsal.ts` |
| 成员与操作权限 | `TeamWorkspacePage.tsx`、`project-permissions.ts` | `api/members.ts`、`username-invitations.ts`；`services/project-permissions.ts` |
| AI 带做、工具、自动推进 | 页面中的 AI 入口、`api/collaboration.ts` | `api/agents.ts`、`ai-tools.ts`、`collaboration.ts`；`services/agent.ts`、`project-ai-tools.ts`、`project-progression.ts` |
| 活动历史与导出 | `LedgerPage.tsx`、`ExportPage.tsx` | `api/ledger.ts`、`project-simplification.ts`；`services/events.ts`、`project-context.ts` |
| 帮助文档 | `HelpPage.tsx`、`help/*.md` | Markdown 以 `?raw` 进入前端构建，无独立文档数据库 |

`services` 并非绝对的业务唯一位置：材料保存和任务部分写入直接在 API handler 内执行。修改前同时搜索 API 与 service 的 SQL，不能只根据文件名猜测业务边界。

### 关键文件的完整路径索引

| 调查对象 | 仓库根目录下的位置 |
| --- | --- |
| 前端入口、项目上下文和导航 | `frontend/src/main.tsx`、`frontend/src/App.tsx`、`frontend/src/components/ProjectShell.tsx`、`frontend/src/components/ProjectNavigation.tsx` |
| 请求、契约与协作客户端 | `frontend/src/api/client.ts`、`frontend/src/api/types.ts`、`frontend/src/api/openapi.ts`、`frontend/src/api/collaboration.ts`、`frontend/src/api/simplification.ts` |
| 资料与成果页面 | `frontend/src/pages/DataWorkspacePage.tsx`、`frontend/src/pages/SourcesPage.tsx`、`frontend/src/pages/MaterialsPage.tsx`、`frontend/src/pages/MaterialAiAssistance.tsx` |
| 任务、评分、成员 | `frontend/src/pages/TasksPage.tsx`、`frontend/src/pages/CollaborationWorkspace.tsx`、`frontend/src/pages/AssessmentWorkspacePage.tsx`、`frontend/src/pages/TeamWorkspacePage.tsx`、`frontend/src/project-permissions.ts` |
| 草稿与页面离开保护 | `frontend/src/storage.ts`、`frontend/src/pages/SettingsEditGuard.tsx`、`frontend/src/pages/settings-dirty.ts` |
| Worker与定时入口 | `frontend/src/worker.ts`、`backend/src/index.ts`、`backend/src/app.ts`、`backend/src/env.ts`、`backend/src/cron.ts` |
| 鉴权、权限、幂等 | `backend/src/core/auth.ts`、`backend/src/core/origin.ts`、`backend/src/services/accounts.ts`、`backend/src/services/project-permissions.ts`、`backend/src/services/idempotency.ts` |
| API与后台分发 | `backend/src/api/agents.ts`、`backend/src/api/collaboration.ts`、`backend/src/api/project-simplification.ts`、`backend/src/services/jobs.ts`、`backend/src/services/ai-jobs.ts` |
| Workflow和并发预占 | `backend/src/workflows/ai-job.ts`、`backend/src/workflows/parse-source.ts`、`backend/src/services/ai-execution-slices.ts`、`backend/src/services/ai-reservations.ts` |
| 工具、调查、证据 | `backend/src/services/project-ai-tools.ts`、`backend/src/services/project-context.ts`、`backend/src/services/project-investigation.ts`、`backend/src/services/project-evidence.ts`、`backend/src/services/project-reference-guard.ts` |
| 模型协议与调用审计 | `backend/src/ai/gateway.ts`、`backend/src/ai/transport.ts`、`backend/src/ai/tool-transport.ts`、`backend/src/ai/calls.ts`、`backend/src/ai/config.ts`、`shared/ai-providers.ts` |
| 来源与材料生命周期 | `backend/src/api/materials.ts`、`backend/src/services/files.ts`、`backend/src/services/source-lifecycle.ts`、`backend/src/services/source-inputs.ts`、`backend/src/services/parse.ts`、`backend/src/services/source-summary.ts` |
| 核心业务执行器 | `backend/src/services/agent.ts`、`backend/src/services/collaboration-ai.ts`、`backend/src/services/collaboration.ts`、`backend/src/services/assignment.ts`、`backend/src/services/assessments.ts`、`backend/src/services/review.ts`、`backend/src/services/rehearsal.ts` |
| 图、通知、推进、导出 | `backend/src/services/project-simplification.ts`、`backend/src/services/task-readiness.ts`、`backend/src/services/project-progression.ts`、`backend/src/services/notifications.ts`、`backend/src/api/ledger.ts` |

## 2. 系统组成与运行边界

```text
浏览器 React SPA（React Router / TanStack Query / Tiptap / PDF.js）
  ├─ 页面与帮助：前端 Worker → ASSETS
  └─ 同源 /api/v1：前端 Worker → API Service Binding → 后端 Hono Worker
      ├─ 请求中间件、Zod 契约、认证、项目操作权限 → API handler / service
      ├─ D1：实体、不可变版本、引用片段、状态、并发预占与审计元数据
      ├─ 私有 R2（FILES）：原文件、正文对象、AI 调用证据、调查检查点
      ├─ PARSE_WORKFLOW → ParseSourceWorkflow → runParseJob
      └─ AGENT_WORKFLOW → AgentRunWorkflow → executeAiSlice → runAiJob
定时 scheduled → handleScheduled：推进、通知、作业/分片恢复、并发预占/文件清理
```

主要运行组合为 React 19、React Router 7、Vite、TypeScript、Hono、Zod 与 Cloudflare Workers/D1/R2/Workflows。具体版本由两个子项目的锁文件决定，不能将 package.json 的范围表达式当成已安装精确版本。后端通过 nodejs_compat 使用密码 KDF 等兼容能力；浏览器不能直接访问 D1、R2 或模型密钥。

前端 Worker 的职责是静态资源与 API 转发；它不执行模型编排。后端 scheduled 使用 ctx.waitUntil 管理定时维护；模型长任务进入 Workflow，用户 HTTP 请求收到作业 ID 后读取状态。数据库提交、R2 写入和外部模型 HTTP 不构成一个全局事务，后文的幂等、预占、outbox、检查点及条件 SQL 都是为这个边界服务。

源码阅读主干：`frontend/src/App.tsx` → 对应 pages 页面 → `frontend/src/api/client.ts` → `frontend/src/worker.ts` → `backend/src/app.ts` → api 路由 → service → D1/R2 或 Workflow。接口完整清单来自 `backend/openapi/openapi.json`，上线版本也提供 `/api/v1/openapi.json`；两者可能因未发布源码不同而有差异，接口核对应比较二者。

## 3. 数据库结构与数据归属

### 源码核对先区分三类事实

`backend/migrations/*.sql` 是结构演进的事实源；`backend/src/services/*.ts` 和路由中的参数化 SQL 是运行时行为的事实源；生产 D1 的迁移记录与 `sqlite_master` 才是当前线上结构的事实源。不能凭文件名推断某个迁移已经应用，也不能把旧规划文档当成现行结构。

本节结构核对基于空的 SQLite 内存数据库按完整文件名执行迁移，仅跳过演示数据 `0002_seed.sql`。当前参考包含 `0033_remove_manual_ledger.sql` 的账本退役与 `0043_remove_task_parent.sql` 的平级任务调整，得到 79 张应用表、1 个视图、7 个触发器。逐列字典包括字段类型、默认值、主键、外键、唯一索引、普通索引和完整 CHECK DDL。空库参考不能证明生产存量数据内容或运行时行为；生产应用情况以实际迁移记录为准。

历史核对记录（早于上述迁移更新）：当时以只读导出的生产 `sqlite_schema` 做离线比对，排除 Cloudflare `_cf_KV`、`d1_migrations` 与 SQLite 内部对象：78 张业务表共 723 列的类型、默认值、NULL/PK 信息与 FK 元数据一致；所有表、1 个视图、5 个触发器的规范化 DDL 一致；51 个显式索引一致，无额外业务对象。生产迁移记录包含 37 个完整文件名（含 seed、两个 0025，不含 0033）。此证据证明核对时结构一致，不涉及读取生产业务行，也不证明存量数据内容或运行时行为正确。

### D1、R2 与运行时分别保存什么

- D1 保存账号、项目成员、来源及材料版本元数据、正文片段、任务依赖、提交/评估、作业状态、并发预占、AI 审计和通知发件箱。大部分主键是 `TEXT` UUID，时间戳是 ISO-8601 UTC `TEXT`，布尔值是带 CHECK 的 0/1 INTEGER，结构化载荷主要是 JSON TEXT。
- R2 通过 `env.FILES` 保存上传原文件、解析文本、图片、AI 输入输出证据、调查检查点及长文摘要块缓存。D1 的 `r2_key`、`text_r2_key`、`input_r2_key`、`output_r2_key`、`checkpoint_key` 是对象指针，不能把 D1 元数据存在等同于对象必然存在。
- `document-chunks.ts` 的 chunks 是将完整原文按模型输入容量划分的运行时数组，**没有 `document_chunks` 表**。原文落在 `source_fragments`；摘要块缓存使用 R2 中 `ai-document-chunks/...` 键。文件附件也没有独立 `attachments` 表，材料版本的 `attachments_json` 保存附件描述。
- `creation-template.ts` 当前模板目录是代码里的 `projectTemplates`（`blank`），没有 `project_templates` 表。项目导出通过读取当前项目与历史快照组装结果，没有持久化 `exports` 表；修改导出能力时应查对应导出路由和服务，避免假设数据库已有导出任务表。

### 主要关系图（文字版）

```text
users ── auth_accounts / sessions / personal_profiles
  └── project_members ── projects ── project_goals
                         ├── files ── file_contributors
                         ├── sources ── source_versions ── source_fragments / source_pages / source_processing
                         ├── materials ── material_versions（doc_json、markdown、attachments_json）
                         ├── requirement_sets ── requirements
                         ├── rubric_versions ── standards_versions ── assessments ── assessment_corrections
                         ├── tasks ── task_dependencies / task_submissions / task_summaries
                         │           └── task_inquiries ── task_inquiry_messages
                         ├── collaboration_proposals ── collaboration_proposal_revisions
                         ├── rehearsals ── rehearsal_turns
                         ├── agent_sessions ── agent_turns / agent_runs
                         └── jobs ── job_outbox / ai_execution_slices
                                    ├── usage_reservations ── ai_calls
                                    └── ai_investigations / ai_tool_calls
notification_events ── notification_inbox ── users
        └── notification_push_outbox ── push_subscriptions ── users
```

此图表示业务关系，不表示每条线都存在数据库外键。`current_version_id`、`current_submission_id`、多个 `job_id` 与 JSON 内版本 ID 是逻辑指针；`task_links.target_id`、评估 `entity_id` 是多态引用，必须由服务检查类型、项目归属和生命周期。只有全量字典中的 FK 才是 SQLite 已声明约束。尤其多数 `project_id` FK 只证明项目存在，不能独立阻止“将 A 项目的材料挂到 B 项目”；跨实体业务边界由 `project-reference-guard.ts`、`source-lifecycle.ts` 与相关服务完成。

## 4. 核心数据字典与读写入口

### 身份、成员与隐私

| 表 | 关键字段与约束 | 代码入口与含义 |
| --- | --- | --- |
| `users` | `id TEXT PK`；`email TEXT NOT NULL UNIQUE`；`display_name TEXT`；`created_at`、`last_login_at TEXT` | 保留历史身份 ID；迁移登录方式不能重新建用户或重绑项目 FK。 |
| `auth_accounts` | `user_id TEXT PK/FK users`；`username`、`username_norm UNIQUE`、`contact_email`、`contact_email_norm UNIQUE`；`password_hash TEXT`；`email_verified`、`is_admin INTEGER CHECK 0/1`；`account_role TEXT CHECK super_admin/admin/user` 可为 NULL | `accounts.ts`、`password.ts`、`auth-policy.ts`。用户名/联系邮箱的规范化字段与展示字段分开；旧用户可能没有密码，角色兼容逻辑不能仅看旧 is_admin。 |
| `sessions` | `id TEXT PK`；`user_id FK users ON DELETE CASCADE`；`token_hash TEXT UNIQUE NOT NULL`；`expires_at`、`revoked_at`、`last_seen_at`、`created_at TEXT`；`auth_method CHECK legacy/password` | 保存令牌哈希而非明文令牌；读用户信息前需检查会话到期、撤销与登录方式。 |
| `project_members` | `id TEXT PK`；`project_id`、`user_id FK`；唯一 `(project_id,user_id)`；`role CHECK owner/member`；`permissions_json TEXT NOT NULL CHECK json_valid`；`permissions_revision INTEGER`；保留旧 `major`、`skills_json`、`hours_per_week` | `project-permissions.ts`。权限载荷键为 `teamManage`、`taskManage`、`resourceManage`、`scoreInitiate`、`scoreCorrect`（0042 起存在，普通成员默认 `false`）；有效权限应调用服务计算。`role` 是项目身份，`permissions_json` 是项目操作能力，两者不能互相推导。 |
| `personal_profiles` | `user_id PK/FK`；`searchable`；`bio`、`major`、`specialties`、`preferred_roles` 及各自 `_public`；`ai_use_allowed INTEGER CHECK 0/1`；`revision`；`weekly_available_hours REAL CHECK NULL 或 0..168` | `personal-profiles.ts`。搜索公开性、字段公开性、AI 同意分别控制，不能从“是成员”推断允许发送其私人档案给模型。 |
| `personal_profile_import_candidates` | `id PK`、`user_id FK`；`source_project_id/name`；旧 `major`、`skills_json`、`hours_per_week`；`created_at`、`imported_at` | 0026 在清空项目域旧档案前保留用户可导入候选，来源项目 ID 刻意是文本快照而非 FK。 |

新账号的 `users.email` 是为兼容旧结构保留的内部不透明身份键，不能当作用户联系邮箱；实际联系邮箱与登录归一化地址在 `auth_accounts.contact_email/contact_email_norm`，对外 User.email 也来自这里。因此注册邮箱可选与 users.email 的 NOT NULL 并不冲突。查询或修改账号资料应沿用 accounts.ts 的映射，不要把内部身份键显示给用户或当作已验证邮箱。

`account_invitations` 是账号注册邀请，`invitations` 是项目邀请码，`project_username_invitations` 是指定用户名的项目邀请。三者用途、使用次数/状态和撤销机制不同，不可互换。用户名邀请的唯一部分索引限制同项目同收件人只有一条 `pending`。

### 项目、资源、版本与标准

| 表 | 关键字段与约束 | 主要载荷与行为 |
| --- | --- | --- |
| `projects` | `id PK`；`name`、`description`；`status CHECK active/archived`；`revision`；`created_by FK`；`competition_deadline_date`、`deadline_precision`；`ai_collaboration_enabled`；`planning_mode`、`assignment_mode`、`evaluation_mode`、`progression_mode CHECK manual/automatic`；`collaboration_revision`、`collaboration_mutation_token` | 普通字段 revision 与协作设置 revision 分开；`team_size_limit` 仍是兼容字段，0030 将存量值改为 NULL，但没有删列。旧数据库保留未使用的金额预算列。 |
| `project_goals` | `project_id PK/FK`；`title`、`detail`；`revision`、`graph_revision INTEGER`；`graph_token TEXT`；时间戳 | `project-simplification.ts`：目标文字与依赖图使用不同版本，修改任务图不应伪造目标文字变更。 |
| `files` | `id PK`；`project_id FK`、`uploader_user_id FK`；`r2_key`、`original_name`、`ext`；`mime_declared/detected`；`size_bytes`、`sha256`、`page_count`；`status CHECK pending/available/quarantined/discarded`；`gc_after`；`deleted_at/by`、`lifecycle_version`、`lifecycle_change_id` | `files.ts`、`file-lifecycle.ts`、`gc.ts`；索引 `(project_id,sha256)` 用于内容定位但不唯一。上传者身份与贡献者不是同一个概念。 |
| `file_contributors` | 复合 PK `(file_id,user_id)`；`file_id FK ON DELETE CASCADE`；`user_id TEXT`、`display_name TEXT` | 贡献署名保存用户和姓名快照，user_id 刻意无 FK，离开项目不会抹去历史署名。 |
| `sources` | `id PK`；`project_id FK`；`kind CHECK file/web/paste`；`title`、`url`；`current_version_id TEXT`；`purpose CHECK background/reference/output`；`resource_revision`；回收站与生命周期字段同 files，另有 `deleted_via_file_id FK files` | 来源实体与来源正文版本分开；用途改变不重建正文版本。 |
| `source_versions` | `id PK`；`source_id`、`project_id FK`；`revision`；唯一 `(source_id,revision)`；`origin CHECK file/web/paste`；`file_id FK`、`url`；`text_r2_key`、字符/页数；`status CHECK pending/processing/ready/failed`；`parse_error`；`ai_config_version_id FK` | 原始内容版本不覆盖；处理状态与冻结 AI 配置是版本上的执行元数据。 |
| `source_fragments` | `id PK`；`source_version_id`、`project_id FK`；`page_number`、`seq`；`kind CHECK text/ocr/web/paste`；`content TEXT`；唯一 `(source_version_id,seq)`；索引 `(source_version_id,page_number)` | 原文引用锚点。长片段切块后仍保留原 fragment ID，不能重写 ID 造成旧引用失效。 |
| `source_pages` | `id PK`；`source_version_id/project_id FK`；唯一 `(source_version_id,page_number)`；`text_status`、`image_status`、`ocr_status`；`image_file_id FK`、OCR方法/置信度、`needs_review` | 页级文本、页面图片、OCR 三种状态分别保存，解析失败不等于原文件被删除。 |
| `source_processing` | `source_version_id PK/FK`；`project_id FK`；`text_status`、`requirements_status`、`summary_status` 独立；要求/摘要错误；`summary_json`、`summary_job_id`、`summary_revision`、`covered_chars`、`total_chars` | `source-summary.ts`。全文读取完成、要求提取完成与摘要完成可以不同步；前端不应以一个总状态替代三个阶段。 |
| `materials` | `id PK`；`project_id FK`；`title`、`kind`；`current_version_id`；`revision`；`purpose`；`is_default_background`；部分 UNIQUE `(project_id) WHERE is_default_background=1` | 每项目最多一份默认背景；资料列表与可编辑稿件统一呈现，不等于来源表被废弃。 |
| `material_versions` | `id PK`；`material_id/project_id FK`；`revision`；唯一 `(material_id,revision)`；`doc_json`、`markdown`、`attachments_json TEXT`；`origin CHECK manual/ai_adoption`；`ai_run_id TEXT`、`author_id FK`、创建时间 | `tiptap.ts` 与材料路由。doc_json 是编辑器文档，markdown 是对应导出/上下文表示，附件是该版本的快照；保存新版本应同时维护三者。 |
| `requirement_sets` / `requirements` | 要求集含 `status draft/confirmed`、`revision`、`source_version_id FK`、确认者/时间；要求含 `requirement_set_id FK`、`seq`、分类、标题/细节、截止日期/精度、`citations_json`、`field_state ai_suggestion/edited/confirmed`；唯一 `(requirement_set_id,seq)` | 要求引用载荷含 `sourceVersionId`、`fragmentId`、`pageNumber`、`quote`；归属与原文校验需服务执行，数据库不验证引文真实性。 |
| `rubric_versions` | `id PK`；`project_id FK`；`version`；唯一 `(project_id,version)`；`source official/custom`；`weights_json`、`notes`；`status` 与确认字段 | 权重项通常含 `key`、`label`、`weight`，检查维度唯一、权重范围与总权重由服务执行。 |
| `standards_versions` | `id PK`；`project_id FK`；唯一 `(project_id,version)`；`requirement_set_ids_json`；`rubric_version_id FK`；`mappings_json`、`snapshot_json`；`status draft/confirmed`；`revision` 与确认字段 | 映射项 `{requirementId,dimensionKey}`；发布时将要求、维度和映射冻结在 snapshot_json。正式评估读取 confirmed 快照，不能用当前编辑草稿解释历史得分。 |

### 任务、提交、评估与人工修订

| 表 | 关键字段与约束 | 实现要点 |
| --- | --- | --- |
| `tasks` | `id PK`；`project_id FK`；`title/detail`；`assignee_id FK users`；`status CHECK todo/doing/blocked/done`；`revision`；`requirement_id FK`；`lifecycle_state CHECK open/in_progress/submitted/accepted/improve/rework` 可 NULL；`criteria`、`effort_hours REAL CHECK >0 且 <=200`；`current_submission_id`、`plan_proposal_id`；`source_citations_json` | 双状态用于兼容旧任务与协作流程。`collaboration.ts` 的映射对 NULL lifecycle 有回退；任意新写入必须保持状态一致，不能仅改一列。 |
| `task_dependencies` | 复合 PK `(task_id,depends_on_task_id)`；CHECK 非自身；两个 `(project_id,task_id)`/`(project_id,depends_on_task_id)` 复合 FK 引用 `tasks(project_id,id)` 并 CASCADE | 数据库阻止跨项目边及自环；环路仍由 `validateTaskGraph` 检查拓扑排序，不能只依赖 FK。 |
| `task_submissions` | `id PK`；`project_id/task_id FK`；唯一 `(task_id,round)`；`submitted_by FK`、`body`、`material_versions_json`；`criteria`、`task_revision`；`status pending/evaluated/accept/improve/rework`；`ai_decision/ai_feedback/ai_report_json`；`decision/feedback/decided_by`；`human_score_override_json`；`evaluation_job_id/attempts`；`revision/mutation_token` | 提交保存标准、任务版本与材料版本 ID 快照。AI 原始意见与最终决策、人工辅助得分覆盖分别保存，不能为了改分覆盖 AI 原证据。 |
| `collaboration_proposals` | `id PK`；`project_id FK`；`kind CHECK decompose/assign`；`job_id UNIQUE FK jobs`；`payload_json`；`settings_revision`；`status pending/applied/stale`；`revision/mutation_token` | 任务规划载荷可含 goal、tasks、updates、dependencies、references；分工含 assignments；实际结构以 collaboration-ai.ts 的 Zod schema 为准。应用建议前需核对每任务 expectedRevision。 |
| `collaboration_proposal_revisions` | `id PK`；`proposal_id/project_id FK`；唯一 `(proposal_id,revision)`；原 payload/status、actor、reason、created_at | 人工修改先保留上一版本；修改已应用规划不能重复创建原新增任务。 |
| `assessments` | `id PK`；`project_id FK`；`kind material_review/rehearsal`；`entity_id TEXT UNIQUE`；`goal_revision`、`standards_version_id FK`；`inputs_json`；`status pending/active/succeeded/failed`；`report_json`、`ai_report_json`；`job_id`、创建者/时间；`revision`、`origin` | `assessments.ts` 统一材料评估和答辩；输入冻结目标版本、标准版本与材料证据，entity_id 指向具体评估实体，未声明 FK。 |
| `assessment_corrections` | `id PK`；`assessment_id/project_id/actor_id FK`；唯一 `(assessment_id,revision)`；`reason`、`previous_report_json`、`report_json`、时间 | `assessment-corrections.ts` 保存修订链。界面可展示当前 report，审计必须同时保留原 AI report 和修订历史。 |
| `reviews` | `id PK`；`project_id/requirement_set_id/rubric_version_id FK`；`material_version_ids_json`；`status pending/running/succeeded/failed`；`report_json/job_id` | 原有预审底层实体仍存在；不要因统一 assessments 而直接删除。 |
| `rehearsals` / `rehearsal_turns` | 答辩含 `scope all/member`、`member_id FK`、材料版本 JSON、`status active/finished`、`processing_job_id`、`finish_job_id/finish_snapshot_json`；回合含唯一 `(rehearsal_id,sequence)`、`kind question/answer/followup/summary`、`content_json`、`run_id`、`author_id FK` | `rehearsal.ts`：共享答辩一次处理作业持有 processing_job_id，回答作者独立记录，避免两个成员并发覆盖同一轮。 |
| `task_readiness` / `task_completion_people` | readiness：`task_id PK/FK`、`assignee_id FK`、`ready CHECK 0/1`、`generation`；completion：`task_id PK/FK`、`user_id FK`、`completed_at` | 0037 的视图和触发器维护基线、完成者与通知。ready 要求任务未完成、已分配给当前成员、有依赖且所有上游 done；没有依赖不会触发“前置全部完成”通知。 |
| `task_inquiries` / `task_inquiry_messages` | inquiry：project/task/upstream/requester/recipient FK，`recipient_source CHECK submission/completion/substitute`，任务名称快照；message：inquiry/author FK，`body CHECK length 1..4000` | 新工单将 `task_id` 与 `upstream_task_id` 都保存为对应任务 ID，接收人由发起人选择；API 根据相同 ID 返回 `direct`。旧记录保留原双任务和 `recipient_source` 快照。参与者访问校验在路由，项目成员不能读取他人的私密工单。 |
| `task_summaries` | 复合 PK `(project_id,task_id,source_hash)`；`status queued/running/ready/failed`；`summary`、`job_id`、时间 | `task-summary.ts`：内容哈希隔离不同原文的摘要，避免旧作业覆盖新正文摘要。 |

### 创建草稿、模板和导出边界

`project_creation_drafts` 以 `id TEXT PK` 保存私人创建工作区；`owner_id FK users` 约束所属人，`status active/cancelled/committed` 标识提交状态，`revision` 用于 CAS，`payload_json` 保存用户输入，`preview_json` 保存预览，`preview_revision` 标识预览对应输入版本。`preview_state none/running/ready/failed`、`preview_attempt_id`、`preview_error` 使过期预览不能覆盖新预览。预分配的 `project_id TEXT UNIQUE NOT NULL` **没有项目 FK**，这是刻意设计：保存草稿、上传与预览不能创建正式项目。`commit_token` 作为创建提交门禁，`result_encrypted` 保存加密的提交结果；提交一次才将工作区转换为项目、成员、材料和标准。

`creation_draft_files` 以 `id PK`、`draft_id FK` 归属草稿，包含 `name/ext`、`r2_key UNIQUE`、`sha256`、`size_bytes/mime`、`pages_json`、`text_error`、`removed INTEGER` 与创建时间。草稿文件不在正式项目 files 表，提交时需要有意识地转移归属而不是只改 project_id。`ai_calls.draft_id FK` 允许没有正式 project_id 的预览调用仍可追溯。实现入口为 `creation-drafts.ts`、`draft-preview-jobs.ts`、`creation-template.ts`。

模板定义来自代码而不是数据库，当前支持 `blank`；workspace 材料项包含 key/title/markdown/purpose，标准项包含 requirements/weights/notes。导出要按对象关系与冻结版本读取，JSON内引用不是FK，不应写出已回收的资源为当前可用对象，也不应误导使用者为导出包包含所有 R2 原件。

### 作业、AI 证据、并发预占与通知

| 表 | 关键字段与约束 | 行为 |
| --- | --- | --- |
| `jobs` | `id PK`；可 NULL 的 `project_id FK`；kind 为 parse_source/ocr_pages/requirement_extract/assignment_suggest/agent_run/review_run/rehearsal_turn/web_fetch/gc；status 为 queued/running/waiting_input/succeeded/failed/cancelled；`input_json/input_r2_key/result_json/error_json`；`attempts/lease_until`；创建者与时间 | `input_json.operation` 在既有 kind 内区分摘要、协作等细分操作，新增操作不一定需要新增 kind。创建时冻结 configVersionId 与来源生命周期版本。创建草稿预览直接以 draftPreview payload 进入 AGENT_WORKFLOW，不落普通 jobs。 |
| `job_outbox` | `id PK`；`job_id UNIQUE FK`；`status pending/dispatched/done/failed`；`available_at/lease_until`；attempts/last_error/时间 | 作业和 outbox 同批写入；派发失败靠恢复器补投，先落库后派发不能只写 jobs。 |
| `ai_execution_slices` | 复合 PK `(job_id,slice)`；job FK；CHECK `0 <= slice < 512`；`instance_id UNIQUE`；`status pending/dispatched/running/continued/complete`；attempts/last_error/时间 | `ai-execution-slices.ts`：slice0 的实例名为 jobId，后续为 jobId-sN；一个作业允许跨独立 Workflow 实例接力，仍共用 job、并发预占和审计。 |
| `ai_investigations` | `id PK`；project/job/requested_by FK；`prompt_version/checkpoint_key`；`phase`、`step`、updated_at；索引 `(job_id,prompt_version)` | D1 保存检查点位置与进度；完整 exchanges、证据等在 R2，私人上下文检查点采用分块加密 envelope；不要将检查点当作普通公开资料。 |
| `ai_config_versions` | `id PK`；`version INTEGER UNIQUE`；`config_json TEXT`；`enabled`、notes、created_by/at | 每调用关联配置版本；冻结模型名称、供应商和协议选项，服务读取时校验。不能以最新配置推断过去调用。 |
| `usage_reservations` | `id PK`；project FK；`job_id`、`purpose`；`status reserved/settled/released`；`attempts_started`、`max_calls` | `ai-reservations.ts` 原子预占并发槽位和每任务调用次数；fetch 前持久化 started 尝试。旧金额字段和 `pending_reconcile` 状态保留给既有数据库记录，不参与当前运行。 |
| `ai_calls` | `id PK`；project/config/reservation/draft FK；`job_id/run_id`；`purpose textEconomy/visionEconomy/review`；`prompt_version/model`；`input_r2_key/output_r2_key`；prompt/completion tokens；`status ok/repaired/invalid/failed/timeout`；latency/time；`search_usage_json` | 模型调用审计，与业务成功分开：收到模型输出但校验失败可记录 invalid。旧费用字段仅保留在既有数据库行，不参与新调用。排查路径从 jobId 到 reservation、call、R2 证据和业务实体。 |
| `ai_tool_calls` | `id PK`；project/job/requested_by FK；`name/args_json/result_json`；`status ok/failed`；时间 | 工具调用证据，可和模型调用按 jobId 串起来；工具失败并不自动代表整个调查失败。 |
| `ai_diagnostics` | `id INTEGER PK AUTOINCREMENT`；`entry_json TEXT`；`byte_size CHECK=length(CAST(entry_json AS BLOB))+1` | 有界运维诊断，保存每次模型调用的成功/失败阶段、耗时和安全错误原因；不存 prompt、response 或密钥，超级管理员可查看和清空。 |
| `idempotency_records` | 唯一 `(idempotency_key,user_id,operation)`；request_hash；`status processing/completed`；response_status/body；created_at | 相同操作同用户同键同内容可返回历史响应；不同内容返回冲突，processing 不应被当成 completed。 |
| `notification_events` | `id PK`；`event_key UNIQUE`；kind/scope project或ticket；resource_id、actor FK；title/body/url/time | 去重事件源。任务可开始事件键含任务与 generation，避免重复通知也支持下一轮有效转换。 |
| `notification_inbox` | 复合 PK `(event_id,user_id)`；两者 FK；read_at/dismissed_at | 站内每人状态独立。 |
| `push_subscriptions` | `id PK`；user FK；session_hash；`endpoint UNIQUE`；p256dh/auth；时间与 disabled 字段 | Web Push 端点和密钥是用户敏感信息，不应进入公开文档或诊断输出。 |
| `notification_push_outbox` | 复合 PK `(event_id,subscription_id)`；两者 FK；status pending/sending/sent/cancelled/failed；attempts、available_at、lease_until、时间 | 发通知的网络请求发生在事务之后，以 outbox 保留派发进度；成功站内事件不保证设备已经收到 Push。 |

## 5. 状态机、并发写入与一致性约定

### 原子业务写入不等于端到端事务

项目使用 D1 `batch` 将相关 SQL 作为事务执行。例如 `createJobAndDispatch` 同批写 jobs 与 job_outbox；依赖图修改先 CAS 更新 `project_goals.graph_revision/graph_token`，后续删除/插入边带相同 token 门禁；应用协作建议先 CAS 更新 proposal 的状态和 mutation_token，后续任务/目标/事件写入必须带该 token。

需要保留 SQL 的 `WHERE revision=?`、当前成员权限、来源生命周期、AI 配置版本、项目开关、目标/图版本与当前作业状态条件。`meta.changes=0` 是前置条件失败，必须返回版本冲突或状态错误，不能当作操作成功。路由先检查权限只减少无效请求，SQL 中再次检查才能防止请求读完权限后项目负责人立刻撤权的竞争。

R2 写入、D1 批处理、Workflow 创建和 Web Push HTTP 请求不构成一个跨服务事务。正确性来自冻结快照、幂等键、确定性实例 ID、状态门禁和恢复机制；新功能需要说明“数据库已提交但网络派发失败”“对象已上传但数据库没写入”如何处理，不应假定一个 try/catch 能回滚所有外部资源。

### 不可覆盖的证据与可更新的执行状态

- 新材料内容写新的 `material_versions` 并移动材料 current_version_id；来源新内容写新的 source_versions。版本内容和作者、AI采纳来源用于追溯，处理元数据可随执行更新。
- 发布 standards 时冻结 snapshot_json；提交保存 task_revision、criteria、material_versions_json；AI结果只有在版本与成员/来源仍有效时才能应用。
- `task_submissions.ai_report_json`、`assessments.ai_report_json` 是 AI 原始证据；人工最终决定/得分保存在单独字段或修订表。修订不能倒写原模型意见。
- 回收站使用 deleted_at、lifecycle_version、lifecycle_change_id 做墓碑。老作业持有旧生命周期版本时不得写回，恢复文件也不能使旧作业获得新生命周期权限。

### 关键状态转换

```text
jobs: queued → running → succeeded / failed / cancelled
                  └── waiting_input（可继续输入；终态不得原地重放）
outbox: pending → dispatched → done / failed
AI slice: pending → dispatched → running → complete
                                  └── continued ＋ 下一 slice.pending
submission: pending → evaluated → accept / improve / rework
task lifecycle: open → in_progress → submitted → accepted / improve / rework
proposal: pending → applied；失效 → stale；人工修订创建历史并更新 revision
reservation: reserved → settled / released
```

箭头是主要流向；恢复器可能将尚未开始模型请求且引擎确证缺失的派发恢复成 queued/pending。`jobs.attempts` 是派发次数，`usage_reservations.attempts_started` 是持久化模型请求尝试次数，`ai_calls` 是已保存审计记录数，三者不能互相代替。引擎查询暂时失败不构成安全重放证据；模型调用已开始但实例/调用记录缺失时，不能自动再请求模型。

长调查只有保存安全检查点后才能继续下一 slice；`continueExecutionSlice` 原子创建下一行、将当前标为 continued、刷新 job，随后派发新的独立实例。claimExecutionSlice 仅抢占 pending/dispatched 且必须是最新 slice，避免引擎重放重复执行同一付费段。

### 图依赖与通知触发器

0037 的 `task_readiness_current` 视图和5个触发器是 schema 的执行逻辑，不只是查询优化：任务创建建立 baseline，任务状态/执行人变更更新 readiness，完成时记录实际提交者或旧执行人，0→1 readiness 写去重通知与 Push outbox，成员离开清 readiness。涉及 tasks、提交状态或成员退出的变更，必须同时检视触发器及 `task-readiness.ts`。

`generation` 使同任务下一次 readiness 转换有独立事件键。切换执行人建立新基线而不通知“领取后立即可开始”。旧任务迁移仅建立基线，不重放历史通知。改变依赖关系时还需服务刷新 readiness；数据库触发器不是对所有表变化自动覆盖的万能订阅器。

## 6. 后端入口、鉴权与写入约束

### 一次请求如何进入应用

前端 `src/worker.ts.fetch()` 将 `/api` 和 `/api/*` 经 `API` Service Binding 转发，其余请求由 `ASSETS.fetch()` 返回。后端 `index.ts` 将 fetch 交给 `createApp()`，scheduled 通过 `ctx.waitUntil(handleScheduled(env))` 运行 cron，并导出两个 Workflow 类。

`app.ts.createApp()` 依次注册 requestId 中间件、部分私密路由的 no-store 响应头、写请求 Origin 检查；业务路由再挂 `requireUser` 与 `requireProjectMember` 等。Zod 验证失败经 defaultHook 转成统一错误；AppError 和未预期异常都进入统一 failureBody，后者只公开固定内部错误消息。新路由应直接注册到根 OpenAPIHono 并使用完整 `/api/v1` 前缀，才能进入导出的契约，不宜额外建立不被导出收集的旁路子应用。

`core/http.ts.requestIdMiddleware` 只接受 UUID 格式的外部 request ID，否则生成新 UUID，写回响应头。`core/origin.ts` 放行 GET/HEAD/OPTIONS；其他方法带 Origin 时必须匹配白名单，local 允许 localhost/127.0.0.1；没有 Origin 的服务调用不在此拦截。Origin 检查不是业务鉴权，也不是允许非成员操作的理由。

### 账户权限和项目权限是两层约束

`api/auth.ts` 的 POST sessions 调用 `loginPasswordAccount`，用户名或联系邮箱加密码建立会话；register 使用一次性注册码。`services/password.ts` 使用 scrypt 并以 timingSafeEqual 核对；`core/auth.ts.loadSessionUser()` 只接受有效、未撤销、未到期且 auth_method=password 的会话，且账户必须存在 password_hash。Cookie 名为 ai_office_session，带 HttpOnly、Secure、SameSite=Lax、Path=/；数据库查找 token 的 SHA-256 哈希，不存明文 token。会话固定期限由 accounts.ts 的 SESSION_TTL_SECONDS 决定，不采用滑动续期。

### 账户角色、项目身份与项目权限是三层，不要混用

`core/account-role.ts` 与 `auth_accounts` 决定账户角色（`super_admin` / `admin` / `user`）；`project_members.role` 决定项目身份（`owner` / `member`）；`project_members.permissions_json` 决定项目操作能力（`teamManage`、`taskManage`、`resourceManage`、`scoreInitiate`、`scoreCorrect`）。三者不能互相推导：账户 `admin` 也必须先加入项目，才能获得该项目的成员记录与项目权限。

`requireProjectMember()` 先核实项目存在，再查成员，再核对 owner 或指定权限，不信任前端角色。仅项目 owner 获得完整项目权限；其他成员（包括 `admin` / `super_admin` 账号）按显式授权操作，未授权时默认 `teamManage=false`、`taskManage=false`、`resourceManage=false`、`scoreInitiate=true`、`scoreCorrect=false`。

权限管理的入口是 `requireProjectAdministrator()` / `canManageProjectPermissions()`：**仅项目 owner**。系统账号的 `admin` / `super_admin` 身份不参与项目授权。`teamManage` 覆盖邀请、撤销邀请、用户名邀请、审批加入申请和移除其他非负责人成员，不允许修改任何成员的 `permissions_json`。管理员账号作为非负责人成员时同样可被负责人调整权限或由团队管理者移除。`DELETE /members/{userId}` 统一使用 `projectPermissionSql()` 在事务内二次校验，移除 owner 一律拒绝。项目持续反馈仅 owner 可写；转让 owner、核心项目配置、AI 自动协作规则、标准版本也保持 owner-only。

「协作管理员」只是前端权限 preset（`administratorPermissions`），一键填入五项权限，不是数据库 `role`，也不产生新的权限表。前端 `projectPermission()` / `useProjectPermissions()` 与后端 `projectPermissionSql()` 使用同一组键；`canManagePermissions` 仅在该成员为项目负责人时为 true，`permissionsRevision` 与 `expectedRevision` 提供乐观并发控制（冲突返回 409）。

关键写 SQL 再次包含 `projectPermissionSql()`，让权限撤回与正在执行的请求竞争时，最终数据库判断生效。新增管理接口应同时做到入口校验、业务对象属于当前项目、SQL 提交时仍具权限；仅隐藏按钮不能形成权限边界。

### revision、幂等键和生命周期版本各解决什么问题

`expectedRevision` 是“我编辑时看见的业务版本”。以 materials 保存为例，先检查当前材料 revision；D1 batch 中插入新 material_versions 的 SQL 仍检查 expectedRevision、当前成员与作者/资源管理权限，再更新 materials 指针和 revision。任务 PATCH/assignment 同样将 revision 条件放在 UPDATE 内。冲突返回 VERSION_CONFLICT，调用方必须重新读取并保留用户编辑，不得 blind retry。

任务依赖图有独立 `project_goals.graph_revision`，替换依赖要求 expectedGraphRevision；不能用任务 revision 替代整张图的版本。文件与来源还有 lifecycle_version：软删除、恢复或重新生命周期可能使后台旧输入失效；`source-inputs.ts` 的 snapshot/assert/SQL guard 负责核对来源与文件快照。AI 结果应绑定创建时的输入与配置版本，不得将“旧输入得到的结果”直接发布到变化后的新数据上。

`services/idempotency.ts.withIdempotency()` 的唯一逻辑范围是 key、userId、operation，另外存请求体哈希。同键同内容且 completed 回放原响应；同键不同内容返回 IDEMPOTENCY_CONFLICT；processing 返回 INVALID_STATE。业务已成功但响应保存失败时保留 processing，不能定时删掉后重新执行。人工恢复接口须先核对业务记录，确认未生效或重试无重复副作用后才释放。expectedRevision 防止覆盖并发编辑，幂等键防止重复动作，二者不能相互替代。

## 7. 核心业务写入与后台执行边界

### 资料上传与来源处理

`services/files.ts.createFileInit()` 验证扩展名、贡献人和派生原文件属于项目，服务端生成 R2 key，创建 pending 文件及贡献人快照，并返回经鉴权的上传路径；客户端不能指定对象路径。`storeFileContent()` 按实际字节限制大小，检查 PDF/PNG/JPEG/WebP magic bytes 或 TXT/MD UTF-8，写 R2 后以生命周期条件改为 available，并记录 sha256、字节数和实际 MIME。类型不符的内容进入 quarantined 并安排回收；超大内容不落 R2，保留 pending 允许换小文件重试。下载还会在读取对象后再次检查生命周期。

`api/sources.ts` 建立来源与 source_versions，来源版本关联文件、URL 或 R2 文本。解析主逻辑在 `services/parse.ts.runParseJob()`，依次深入 extractSourceVersionText、ocrPendingPages、extractRequirements；`workflows/parse-source.ts` 承接持久执行。文本、PDF 文本和图像 OCR 是不同阶段，来源 exists 不代表已解析可用；排障需要分别查看 source_versions.status/parse_error、页文本及对应 job。更改文件处理务必验证软删除后旧作业无法重新发布，不能只验证正常上传。

### 材料版本与任务图

`api/materials.ts` 用 Tiptap JSON 保存可编辑结构，通过 `services/tiptap.ts` 生成 markdown，material_versions 保存不可变快照；materials.current_version_id 是当前指针。保存使用 D1 batch 同步版本、指针和事件，附件还保存引用快照，便于历史追溯。新增材料字段先确认属于稳定实体还是版本快照：标题等实体属性与某一版本正文、附件、作者来源不能混为一列。

`services/project-simplification.ts.validateTaskGraph()` 检查边指向同项目其他任务、重复边及环；`replaceTaskDependencies()` 用图版本和 guard 原子替换，再追加 `readinessStatements()`。依赖未 done 时准备状态提示为未就绪；这只是提示，不阻止提前认领、执行、提交或人工验收。task_readiness 记录 ready 转变与 generation，用于准备通知；新增/分派/更改依赖要在现有 batch 内补齐 readiness，避免事务之后异步补写而漏通知或重复通知。任务状态来自用户或受控流程，API 契约明确 AI 不允许直接任意改任务状态。

### 标准评分与答辩演练

`services/assessments.ts.assessmentInputs()` 冻结标准版本、材料版本、项目目标及来源快照；`scoreAssessment()` 生成评分报告；`assessmentPublication()` 在发布 SQL 再检查 assessment 原始 AI 状态、job 状态、成员及来源有效性，更新 report_json/ai_report_json 并增加 revision。人工修订与 AI 发布分开，不能将人工修订后的报告当作未发布 AI 作业继续覆盖。`runMaterialAssessmentJob()` 成功发布后释放并发预占并 succeedJob，失败标记 assessment 并结束预占；续执行异常必须交还持久执行，不可误判成普通失败。

`services/rehearsal.ts.runRehearsalTurnJob()` 要核对 processing_job_id，材料按版本读取；member 范围核对目标仍是项目成员并读取其任务，不能把请求者误当演练对象。summary 阶段使用 finish_snapshot_json 的回答快照，核对 finish_job_id，批量发布 assessment、summary turn 与 finished 状态。共享演练的操作者和目标成员属于不同概念，修改前阅读 `api/rehearsals.ts` 的所有权检查及 114-rehearsal-ownership 测试。

## 8. AI 调用链路：从用户操作到结果发布

### 阅读范围与版本边界

本章依据当前工作区源码核对。`agent.ts`、`assessments.ts`、`assignment.ts`、`guide-history.ts`、`project-ai-tools.ts`、`project-context.ts` 六个服务文件存在未提交修改，尤其涉及工具参数契约、评分提示、带做历史和调查继续执行的异常透传。以下函数名、表名和链路描述对应本地源码；这些未提交实现是否已发布，需要结合部署构建和线上版本另行核对。不能凭帮助页面更新就推断后台代码已经发布，也不能把本章的静态检查当作真实供应商付费调用验证。

核心调查函数的真实名称是 `projectToolConversation`，在 `backend/src/services/project-ai-tools.ts`；不要寻找不存在的 `runProjectInvestigation`。建议按 `api → ai-reservations/jobs → workflows → ai-jobs → 业务执行器 → agent/project-ai-tools → gateway → transport/tool-transport → calls → 发布 SQL` 的顺序阅读。

### 用户入口与执行器对照

路径中的 `{projectId}` 等参数由服务端路由解析。普通业务接口统一在 `/api/v1` 下；幂等记录的 `operation` 与 `jobs.input_json.operation` 用途不同，前者避免重复创建，后者参与后台业务路由，不能混为一个枚举。

| 用户操作 | HTTP 入口与主要源码 | 作业与执行器 |
| --- | --- | --- |
| 创建助手、代做/带做/只审 | `POST /api/v1/projects/{projectId}/agent-sessions`；后续 `POST .../agent-sessions/{sessionId}/turns`；`api/agents.ts` | `agent_run → runAgentJob`，由 `capability` 决定 `do/guide/review_only` |
| 采纳助手草稿 | `POST .../agent-runs/{runId}/adopt` | 独立采纳事务，不等同模型已生成 |
| 任务拆解/调整 | `POST .../collaboration/decompose`；`api/collaboration.ts` | `agent_run` + `collaboration.decompose → runCollaborationAiJob` |
| 分工建议 | `POST .../collaboration/assign` | `agent_run` + `collaboration.assign`；通用分工入口另使用 `assignment_suggest → runAssignmentSuggestionJob` |
| 提交后自动评价 | `POST .../tasks/{taskId}/submissions`（协作路径为同一处理器） | AI 启用时自动创建一次 `agent_run` + `collaboration.evaluate`，由 `enqueueEvaluation` 冻结轮次和标准；AI 禁用时不创建作业，不注册独立手动评价接口 |
| 任务简介 | `POST .../collaboration/tasks/{taskId}/summary`，也注册 `/projects/{projectId}/tasks/...` 别名 | `agent_run` + `collaboration.summary → runTaskSummaryJob` |
| 固定材料预审 | `POST .../reviews`；`api/reviews.ts` | `review_run → runReviewJob` |
| 主目标材料检查/演练评分 | `POST .../assessments`；`api/project-simplification.ts` | 材料检查 `review_run` + `assessmentId`；演练 `rehearsal_turn` |
| 答辩演练、回答、结束 | `POST .../rehearsals`、`.../{rehearsalId}/answers`、`.../{rehearsalId}/finish` | `rehearsal_turn → runRehearsalTurnJob`，`phase=question/followup/summary` |
| 解析来源、扫描页 OCR | `POST .../sources/{sourceId}/parse`、`.../page-images`；`api/sources.ts` | `parse_source/ocr_pages → runParseJob` |
| 单独文件总结 | `POST .../sources/{sourceId}/versions/{sourceVersionId}/processing/summary` | `requirement_extract` + `source.summary → runSourceSummary`，并非独立 JobKind |
| 创建项目的 AI 预览 | `api/creation-drafts.ts → enqueueDraftPreview` | 直接创建 `AGENT_WORKFLOW`，携带 `draftPreview`；不进入普通 `jobs` 路由 |

`services/jobs.ts` 中 `JobKind` 的完整类型是 `parse_source`、`ocr_pages`、`requirement_extract`、`assignment_suggest`、`agent_run`、`review_run`、`rehearsal_turn`、`web_fetch`、`gc`。其中 `gc` 虽被类型声明允许，不代表 `runAiJob` 有对应实现；实际垃圾回收由 cron 调用 `gc.ts`。解析路由集合是 `parse_source/ocr_pages/requirement_extract/web_fetch`；其他普通作业派发到 AI Workflow，而 `runAiJob` 只接受四种 AI 作业，新增类型必须同时补路由和执行器。

### 一次普通 AI 作业的顺序

以下以已存在项目的助手、协作或评分作业为例；来源处理按阶段预占，创建草稿预览另走直接 Workflow 路径。

```text
用户点击 → API 校验身份、项目权限、参数、expectedRevision、幂等键
  → withReservedAiJob / reserveAiSlot：冻结 configVersionId，预占并发槽位与调用次数
  → 写 agent_run / assessment / submission 等业务记录与输入快照
  → createJobAndDispatch：jobs(queued) + job_outbox(pending) 同 batch
  → tryDispatchJob：原子领取 jobs，queued → running，attempts + 1
  → ensureInitialExecutionSlice → dispatchExecutionSlice → AGENT_WORKFLOW.create
  → AgentRunWorkflow.step.do(retries.limit=0)
  → executeAiSlice → claimExecutionSlice → runAiJob → 业务执行器
  → aiJsonCall → projectToolConversation（需要项目工具时）
  → gatewayChat → beforeFetch guard/调用尝试标记 → prepareMessages
  → buildProviderRequest / applyToolMode → onDispatch → fetch
  → 规范化协议结果 → recordAiCall → 保存调查检查点 / 执行只读工具
  → 最终 JSON 与业务证据校验 → 条件 SQL 发布 → settleReservation
  → succeedJob → job_outbox(done) → GET /api/v1/jobs/{jobId} 展示结果
```

`createJobAndDispatch` 会将 `configVersionId` 写入 `jobs.input_json`；有来源时还冻结 `sourceLifecycleVersion`。除独立 `source.summary` 外，同一来源的解析/OCR/要求提取共享 `source_versions.ai_config_version_id`。配置版本冻结是可追溯依据，但很多业务同时要求其仍为最新启用版本；后台配置改变时旧作业可能被拒绝，需要重新发起，而不是无声切换到新模型。

任务状态只有 `queued/running/waiting_input/succeeded/failed/cancelled`。`waiting_input` 常表示扫描页需要用户补图片，并不表示所有运行都可以自动继续。`failJob`、`succeedJob` 使用条件更新避免覆盖终态；失败重试接口创建新 job ID，旧失败记录保留。`jobs.attempts` 是领取派发次数，既不是模型调用次数，也不是工具轮数。

### 各业务能力的生成、采纳和自动执行边界

助手 `do` 产出 `{title,markdown}`，转为 Tiptap `doc` 后保存 `agent_runs.output_json` 和 `agent_turns`，用户采纳才形成正式材料版本。`guide` 输出 `{type:question|draft,content}`，本轮会话由服务器绑定 `guideSessionId`；`buildGuideHistory` 提供历史目录，`list_guide_turns/read_guide_turn` 按页读取回答，每页最多 4000 字符，避免把目录摘要当成完整历史。仅原发起人、当前项目成员、仍 active 的 guide 会话可读取其历史。`review_only` 输出问题列表，含严重程度、说明、建议和可选 quote；引文须能在已输入材料或实际已读引用中核对，生成审阅结果不会自动改正文。

拆解与调整在 `collaboration-ai.ts` 生成 `collaboration_proposals`。局部调整只能修改冻结 scope 的标题、说明、验收标准和工时，不能删除任务或修改权限。`assertSnapshot/currentConfig` 检查任务 revision、来源、成员、`settingsRevision`、`goalRevision/graphRevision` 等。`applyProposal` 位于 `collaboration.ts`，采纳时仍检查当前权限和版本；自动采纳同样走该函数。结果会区分 `autoApplied/applyError`，因此“生成成功”不保证“已经应用”。

自动拆解后自动分工由 `enqueueDecompositionAssignment` 创建一个独立的 `collaboration.assign` 后续任务，带 `parentProposalId`，使用确定性 ID 避免重复；没有待分配任务则不创建。已创建的任务不会因此重新递归拆解。`continueConfirmedPlan` 支持明确确认方案后继续分工。分工使用 `generateAssignmentSuggestions`；验证每个任务恰好覆盖一次，责任人只能为输入中的项目成员或 null。模型给出的自由理由不作为个人评价发布，服务器生成固定协作提醒。

分工个人偏好采用 `profileStamp`：job 只保存成员 ID、成员记录 ID、个人资料 revision 和 `ai_use_allowed`，不保存个人简介正文。`recommendationDispatch` 在真实 fetch 前最后一次数据库读取中统一检查授权、成员范围、来源和最新配置，再提供当前允许用于 AI 的偏好与负载；调用方不能在这次读取与 fetch 之间加入异步 I/O。`finishRecommendationJob` 的发布 SQL 再检查 `profileSnapshotGuard`，防止授权撤回后仍发布旧推荐。

每轮提交在系统与项目 AI 启用时只自动创建一个评价作业，禁用时不评价；同轮重复或失败作业不能通过手动评价或通用重试接口创建第二份评价。提交评价使用固定 `task_submissions` 轮次、完整 `material_versions.markdown` 和可选生效标准的 `rubricSnapshot`。`evaluate` 要求 `current_submission_id/evaluation_job_id/task_revision/assignee_id/submitted_by` 一致，阶段性提纲按本任务 criteria 评价，不能要求尚未到达阶段的最终成果。此操作 `maxAttempts:1`，不自动修复评价结论。`assessEvidence` 检查逐字证据、附件/链接未读、coverage、limitations、低于 0.6 的评分置信度。任务为平级任务，主目标单独保存，依赖通过 `task_dependencies` 表达。原文证据不足时即使模型给 accept，自动验收仍被阻止；只有未读附件或引用造成证据限制、正文证据有效且其他校验通过时，可以先行接受，并在报告 `humanReview.status` 中保存 `pending`，对外返回 `pendingHumanReview`；负责人随后完成人工审核。先行接受仍使用 `accepted/done`，计入完成与依赖就绪；评分总分由 `calculateRubricWeightedTotal` 算，不采信模型总分。结果落 `ai_report_json` 后才可能由 `decideSubmission` 应用。已存在报告可复用，避免再次付费生成。

材料预审与主目标评分是两条路径。旧 `reviews` 冻结 `requirement_set_id/rubric_version_id/material_version_ids_json`；新 `assessments` 冻结 `goal_revision/standards_version_id/inputs_json`，`review_run` 携带 `assessmentId` 时 `runReviewJob` 转 `runMaterialAssessmentJob → scoreAssessment → publishAssessment/assessmentPublication`。每个数字评分都要固定成果引文；没有可靠证据或置信度不足则 score=null，不冒充 0 分。要求检查覆盖全部 requirement ID；没有证据的 met/unmet 改 unknown。材料检查不要求答辩回答，演练数字分必须含实际 answer 证据。空材料、无实际回答可返回 unscorable，无需发起模型请求。

演练依靠 `rehearsals.processing_job_id` 保证当前轮独占；finish 使用 `finish_job_id/finish_snapshot_json` 冻结完整问答。普通首问/追问输出 `{action:question|feedback,content}`，用户回答由 API 保存；有 assessment 的结束阶段调用 `scoreAssessment`，将评分发布、summary turn、finished 状态放在 batch 中，条件检查作业仍拥有结束权。`scope=member` 针对明确 `member_id` 的责任任务，不能把请求账户当目标成员。历史回合表没有 role 列：`kind=answer` 为答辩者，其余是评委侧。

文件解析不把所有阶段当作一次模型调用：`extractSourceVersionText` 尝试正文提取，缺扫描图返回 `waiting_input`；OCR 用 `visionEconomy`，要求提取用 `textEconomy`，文件总结单独记录于 `source_processing.summary_*`。`source.text` 表示只提正文；`source.summary` 可单独重试，不重复上传或 OCR。`runParseJob` 最先检查 source 生命周期；正文、要求、总结各有独立状态，禁止通过单一 `source_versions.status` 推断全部已完成。

任务简介实际表名为 `task_summaries`，operation 为 `collaboration.summary`。`runAiJob` 优先处理此 operation，否则会误落通用协作执行器。输入冻结 `sourceHash`；`runTaskSummaryJob` 每次调用及发布都检查 task、claim、用户、配置及 hash，生成最多 60 字简介，最多一次格式修复，不提供项目工具。

本地 Agent 交接的适用性由 `task-agent-eligibility.ts` 调用当前 `textEconomy` 模型判断，不使用关键词规则。任务保存和内容修改通过数据库触发器记录后台检查需求，由现有定时维护有界派发；已有任务及重新启用 AI 后的失效判断也会补检。判断按完整标题、说明、验收标准、配置版本及提示词版本的哈希缓存，失败不自动重发付费检查；前端仅读取和轮询状态。只有当前内容对应的 `ready/eligible=true` 允许代实施。

`GET/POST .../collaboration/tasks/{taskId}/assistance-plan` 读取和手动生成持久化辅助计划；生成作业复用调用审计、并发控制和 Workflow。计划上下文包含项目背景、目标、生效标准、资料及前置任务固定成果，发布前再次核对上下文和成员资格。重新生成时保留上次成功计划，过期只标记、不自动生成。辅助计划不受整项任务执行适用性限制。

DSH 桥接设备在设置中授权项目并选择默认设备，本机工作目录通过 DSH 原生选择器绑定。插件持久化凭据并在启动和网络恢复后自动连接；打开任务的“AI 辅助”弹窗不派发执行。只有显式执行才创建交接，成果回传为待核对草稿。手动复制、下载提示词作为无桥接配置时的交接方式保留。

创建项目草稿预览走例外路径：`enqueueDraftPreview → AGENT_WORKFLOW.create({draftPreview}) → previewDraft → gatewayChat`。它尚无正式 project ID，不使用普通项目 `usage_reservations`、调查工具或执行分片。预览使用 `preview_state/preview_attempt_id/preview_revision`，只生成主目标及 1–20 个任务，不分工、不评分，验证依赖无循环及文件页逐字 citations。模型输出失败不通过 `aiJsonCall` 修复；显式重新生成会重新发起模型请求。提交项目后通过 `draft_id` 将对应 `ai_calls.project_id` 归到新项目。

自动项目推进不是新 operation：`cron.ts → dispatchProjectProgression` 消费 `events.actor_type=user`，15 秒防抖，用 `project_progression` 游标和 `pending_job_id` 限制单个在途推进，再创建 `collaboration.decompose` + `progression:true/causeEventId`。AI 写事件不会递归触发；人工修订仍待审方案优先保留；存在活跃协作或解析任务时跳过。结束游标记录观察事件，避免每分钟无变化重复付费。

## 9. 工具的授权和证据模型

`projectToolConversation` 首先通过服务器读取 `get_project_overview/list_project_resources/list_tasks/read_project_standards` 给出索引，再由模型选择相关正文。工具只读当前授权项目；project ID、user ID、guide session 由服务器绑定，模型不能通过参数指定别的项目。`project-context.ts` 的工具参数由 Zod 同一 schema 生成 JSON Schema 并执行校验，避免提示契约与实际验证不一致。

发现工具包括 `get_project_overview`、`list_project_plans/read_project_plan`、`list_assessments/read_assessment`、`list_project_resources/search_project_information/list_resource_versions/read_resource`、`list_tasks/read_task/read_submission/read_project_standards/read_admin_feedback/read_project_history/read_member_workload`；文件工具为 `list_project_files/read_project_file`。文件列表每页 20 项；文件正文或保存总结每页最多 6000 字符；目录和分页继续采用 `nextOffset`。工具读取文件不自动发起 OCR 或总结请求，缺正文返回 unavailable；总结标记 `derived:true`，不能冒充来源原文引文。连续三轮相同工具名和参数、没有进展会停止。

工具返回和文件名统一按不可信数据处理。工具参数非法时将安全字段错误返回给模型，使其修正；权限变更、生命周期失效、并发限制、供应商不可用和 `InvestigationContinuation` 必须透传，不能包装成普通可忽略工具错误。工具审计落 `ai_tool_calls(name,args_json,result_json,status,requested_by,job_id)`，保留分页、片段 ID、错误和引用元数据，避免直接保存文件全文或搜索查询。

`ProjectReference` 包含 `resourceType/resourceId/versionId/revision/fragmentId/pageNumber/quote/usage`，派生总结还有 `offset/summaryRevision`。`referencesFromRead` 不给目录 `directoryOnly:true` 生成正文依据；`decisionReferences/extractDecisionReferences` 仅接受实际读过的 reference ID。模型最终返回 `referenceIds/decisionReferences:[{decisionPath,referenceIds}]`，用于区分读过与用于决策的依据。`validateReadReferences` 核对来源当前生命周期、固定版本、正文引文、派生总结 revision、带做回合所属会话、方案/评分当前生效内容；发布 SQL 的 `projectReferenceGuard` 再堵住检查与提交间的竞态。引用存在不等于语义上充分支持判断，仍需业务证据校验。

## 10. 调查检查点、分片和付费请求不确定性

调查 ID 通常为 `jobId + '-' + sanitized promptVersion`，对象位置 `ai/investigations/{id}.json`；索引在 `ai_investigations`，包含 `project_id/job_id/requested_by/prompt_version/checkpoint_key/phase/step/updated_at`。检查点保存 `step/exchanges/references/trace/compacted/pendingDispatch/content/pendingOutput/pendingResults/pendingSearchOutput/citations/searchUsed/providerRetry`。`phase` 为 read 或 complete，不是 JobStatus。

`privateContext=true` 时 JSON 按 Unicode 码点每 16000 字符拆块，用现有 `seal/unseal` 和 `AUTH_SECRET` 加密；信封格式 `encrypted-investigation-v1`，每块核对 id、index、total。不要更换 AUTH_SECRET 来解决普通失败，否则会同时影响既有加密数据。`compactExchanges` 做确定性历史压缩，保留资源定位元数据和近期交流，遗漏正文可以重新读取；它不允许凭压缩目录宣称已核对原文。

`projectToolConversation` 内部的 `checkpoint()` 调用 `project-investigation.ts.saveInvestigation()`，先写 R2，再更新 D1 的调查索引。模型请求前先保存 `pendingDispatch:true` 和调用开始标记，再重查 guard，最后 fetch。响应和调用记录成功后保存 `pendingDispatch:false` 及 `pendingOutput`。`loadInvestigation` 发现 pendingDispatch 时直接拒绝重放：上次已派发但结果不确定，避免重复发起模型请求。收到响应但未执行完工具时保存 pendingResults；恢复使用已持久化 pendingOutput，不重复模型请求。

`ai_execution_slices` 是同一业务 job 下独立 Workflow 实例的恢复 outbox：首片 instance ID=job ID，后续为 `{jobId}-s{n}`；状态 `pending/dispatched/running/continued/complete`，slice 从 0 到 511，最多 512 个，不等于允许 512 次模型调用。`claimExecutionSlice` 条件 UPDATE 确保每片只执行一次，旧片不能覆盖新片。收到模型工具响应后立即安全保存并 yield；工具每片最多执行 4 个，保存结果后再继续。`executeAiSlice` 只识别 `InvestigationContinuation` 并调用 `continueExecutionSlice`，其他异常不能当安全继续处理。外层业务 catch 必须先原样抛出该类，不能 failJob 或提前释放并发槽位。续片要同时传递 `AI_EXECUTION_SLICE:true`、原 job ID、promptVersion、私有上下文及业务 scope，确保读取同一检查点和预占记录。

分片用于重置 Worker invocation 子请求额度；单纯增加 `step.do` 不能重置该额度。512 是保护界限，不是 Cloudflare 任意错误恢复器。10034/嵌套子请求深度错误与供应商 HTTP 503 不同，不能靠供应商重试分类假装解决。

## 11. HTTP 协议、结构修复和供应商重试

`gatewayChat` 是共同网络入口；`transport.ts` 的 `buildProviderRequest/normalizeProviderResponse` 与 `tool-transport.ts` 的 `applyToolMode/normalizeToolResponse` 分别处理普通输出和工具协议。`shared/ai-providers.ts` 的 `protocolForConfig/modelCapabilities/providerOptionErrors` 决定兼容协议和参数，不通过任意 header/body 透传配置。

| 协议 | 请求和工具历史 | 返回与限制 |
| --- | --- | --- |
| Chat Completions | `Authorization: Bearer <provider key>`；messages；如发送输出字段则固定为 65535；tools.function + role=tool/tool_call_id | choices.message.content、usage.prompt_tokens/completion_tokens；拒绝截断/拒答；达到固定输出上限时提示缩短任务或降低思考强度 |
| Responses | `Authorization: Bearer <provider key>`；input，store=false，max_output_tokens 固定为 65535；function_call_output/call_id | output 中 assistant output_text；input_tokens/output_tokens；必须 completed；工具 adapter 另处理 function call |
| Anthropic Messages | `x-api-key: <provider key>`、anthropic-version；system 单独；必填 max_tokens 固定为 65535；tool_use/tool_result | end_turn/stop_sequence；usage 将 cache_creation/cache_read 算入输入；thinking 不当答案 |
| Gemini | `x-goog-api-key: <provider key>`；contents/model、systemInstruction、inlineData、generationConfig.maxOutputTokens 固定为 65535；functionDeclarations/functionResponse | STOP；忽略 thought；候选输出与 thoughtsTokenCount 合计输出用量；grounding 搜索引用另外处理 |

普通第三方模型使用 AI 设置中加密保存的 `apiKeyEncrypted`，直接请求对应 `apiUrl`；构建请求时按协议写入 `Authorization`、`x-api-key` 或 `x-goog-api-key`。Cloudflare AI Gateway 的默认 Provider Key 只用于显式配置为 Gateway 路由的专门功能（例如实时 Google 转录和 Gateway 语音生成）；它不接管普通模型槽位、Gemini 媒体摘要或 MiMo 媒体摘要。Workers AI 使用 Cloudflare 账户服务凭据和 `cf-aig-gateway-id`。设置 `redirect:'manual'`，普通供应商的任何 3xx 都不会跟随或转发凭据。不支持视觉输入时拒绝，不回落其他端点。输入最多 32 条消息、`maxInputChars`，序列化工具 body 还有大小界限；JSON 响应最多 4 MiB。敏感上下文只有经过 Gateway 的请求才添加 Gateway 日志/缓存控制头。

OpenCode Go 额外要求稳定 opaque session ID，生成 `x-opencode-session` 和已验证 user-agent；不能把用户输入直接当 header。模型 JSON 能力不足时不强行发送不支持字段，仍通过明确 JSON 提示和 Zod 验证。业务最终 JSON 错误由 `aiJsonCall` 至多增加一次修复请求；工具调查结束的修复关闭工具，保留完整输出和已读 ID，提示只纠正字段，且重复原权限/配置/授权检查。输入过大直接拒绝，不静默截掉报告末尾。评分评价可指定 `maxAttempts:1` 禁止修复改变判断。

供应商恢复与 JSON 修复是两个有界流程。`gatewayChat` 仅对已收到的 HTTP 429/500/502/503/504、且 AppError 为 retryable 的 `AI_UNAVAILABLE`，按 1 秒、5 秒、15 秒额外最多三次恢复；从首次明确拒绝开始共享 60 秒窗口，下一次 timeout 取配置 timeout 与窗口剩余时间较小值。调查作业通过 `onProviderRetry` 保存 `attempt/deadline/nextAttemptAt` 后抛 continuation，在独立实例等待后恢复；窗口跨分片不能重置。每次再次调用都执行 beforeFetch 和 prepareMessages。网络失败、超时、重定向、配置/权限错误、解析失败、10034 不属于该恢复列表。调用方不得在 JSON 修复循环中重新启动供应商恢复窗口；`AI_UNAVAILABLE` 终止当前调用内恢复；业务失败另由 D1 持久重试链在至少60秒后排队新作业，最多追加3次。配置、权限和并发额度拒绝会停止恢复，不能把业务恢复计数与调用内计数混为一谈。存在 `withSingleRetry` helper 也不代表核心链路应重复套用它。

原生搜索由 `nativeSearchCapability` 按 preset/protocol/model 白名单判断，不等于所有兼容模型都能搜索。只有 `allowSearch=true`、公开 `searchQuery`、模型能力支持，才暴露 web_search；工具查询必须与授权查询逐字一致，本轮最多一次。搜索单独请求只带公开查询，不带项目正文；必须返回 performed 与实际 citations 才可声称联网。Responses 使用 web_search，Messages 使用 web_search_20250305，Gemini 用 google_search，OpenRouter 强制 native 引擎；不可用不回落第三方。供应商真实兼容性仍应逐项验证，尤其 DeepSeek Anthropic 搜索不是仅凭模拟响应即可证明。

## 12. 并发控制、审计与发布竞态

`usage_reservations` 为每个作业保存 `project_id/job_id/purpose/status/attempts_started/max_calls`。每项目同时最多 2 个活动预占；`reserveAiSlot` 原子检查并发及同作业重复预占。普通任务预占至少 2 次，最多 24 次；调查达到额度时，`markAiCallStarted(...,true)` 可追加两个调用位，最多扩展至 24 次。4 工具/片、24 次模型调用、512 个执行分片分别限制不同资源，不能互相替代。历史金额字段仅保留在旧数据库结构中，应用不再读取或写入。

上述24次是普通调用预占及调查扩容的上限；`markAiCallStarted` 对 purpose 为 `ocr_pages` 的预占有单独计数条件，不能将调查的调用上限直接套用到逐页 OCR。OCR 同时依赖来源、页面范围、页数及图像输入限制。

`recordAiCall` 将 input/output 存 `ai-calls/{id}/input.json/output.json`，并将模型、`config_version_id/prompt_version/job_id/run_id/reservation_id/draft_id`、token 用量、延迟和执行状态写入 `ai_calls`。

R2/调用记录写失败不能触发第二次模型请求；checkpoint 先标记 in-flight，可阻止崩溃后无证据重放。`ai_diagnostics`（见 diagnostics.ts）记录每次模型调用的成功/失败、请求 ID、协议、HTTP 状态、阶段、耗时、safe host/path 和经脱敏的后端错误原因；不记录或展示解密密钥、原始供应商响应正文、提示词或模型回答。系统概况中仅超级管理员可查看和清空日志。

运行前检查并不足以保证发布正确，发布 SQL 仍绑定作业状态、当前项目成员、项目 active、来源 lifecycle、固定材料与实际已读引用、配置版本、设置 revision、任务 revision、提交轮次、guide session 或演练处理权。自动应用再检查一次规则，失败时保留提案/报告及 applyError，供人工审查。发布路径变更必须保留条件 UPDATE/INSERT SELECT 和结果 meta.changes 检查。

## 13. 排查与人工恢复：先取证，再创建新请求

先取前端 job ID，通过 `GET /api/v1/jobs/{jobId}` 看 status/result/error。以下是只读 SQL 示例，将 `'JOB_UUID'` 替换为观察到的 ID；查询应在对应环境的 D1 上运行，不读取私有全文或云端 secret。

```sql
SELECT id,kind,status,attempts,created_at,updated_at,finished_at,
       json_extract(input_json,'$.operation') AS operation,
       json_extract(input_json,'$.configVersionId') AS config_id,
       error_json
FROM jobs WHERE id='JOB_UUID';
SELECT job_id,status,attempts,available_at,lease_until,last_error
FROM job_outbox WHERE job_id='JOB_UUID';
SELECT job_id,slice,instance_id,status,attempts,last_error,updated_at
FROM ai_execution_slices WHERE job_id='JOB_UUID' ORDER BY slice;
SELECT id,purpose,status,max_calls,attempts_started
FROM usage_reservations WHERE job_id='JOB_UUID';
SELECT id,purpose,model,config_version_id,prompt_version,status,
       prompt_tokens,completion_tokens,latency_ms,created_at
FROM ai_calls WHERE job_id='JOB_UUID' ORDER BY created_at;
SELECT id,prompt_version,phase,step,checkpoint_key,updated_at
FROM ai_investigations WHERE job_id='JOB_UUID';
SELECT name,status,args_json,result_json,created_at
FROM ai_tool_calls WHERE job_id='JOB_UUID' ORDER BY created_at;
```

queued 且 outbox pending 看 lease/available_at 和 cron；running 看最新 slice，再查真实 Workflow instance 状态，不能仅因时间长就重派。cron 对超过 5 分钟未更新的 running 每批 10 条执行 `reconcileWorkflowJob`，先检查实例；只有明确 instance.not_found、且没有已开始模型证据的路径才安全补派。查询引擎 transient error 不允许重放。实例已结束而业务未提交则失败；最新 pending slice 可由 `recoverExecutionSlices` 补派。超过两小时预占只在 job 不属于 queued/running/waiting_input 时清理，不释放仍在运行的槽位。

waiting_input 看 source processing 和缺图片页；AI_OUTPUT_INVALID 看协议完成状态、output_limit、Zod 字段、引文/coverage；QUOTA_EXCEEDED 看并发与 max_calls；INVALID_STATE 看 settings/source/config/profile 版本；AI_UNAVAILABLE 看 HTTP 响应与网络失败分类。若有 pendingDispatch，保留任务和调用状态证据，不要手动清 pendingDispatch、重置 running 或清 R2。

`POST /api/v1/jobs/{jobId}/retry` 仅接受 failed，创建新 job；source.summary 要走 processing/summary 专用入口，`collaboration.*` 从当前任务重新发起重冻快照；演练仅原发起人在旧作业仍持有 processing_job_id 且 rehearsal active 时可重试。成功/取消任务不复活。通用 retry 不保证所有关联业务记录都能重新跑，因此优先使用对应业务的新发起路径。

### 源码核对清单

可优先阅读 `backend/test/111-investigation-continuation.test.ts`、`113-investigation-execution-slices.test.ts`、`114-native-search-slices.test.ts`、`120-provider-retries.test.ts`、`116-guide-history.test.ts`、`121-project-tool-contracts.test.ts`、`21-provider-adapters.test.ts`、`28-reservation-adoption-atomic.test.ts`、`96-output-limit-switch.test.ts`。当前文档只说明源码和已有测试覆盖意图，不宣称这些测试在本次文档调查中重新通过。

维护核对顺序：确认源码与部署版本；用本地 stub 验证 API 到 job 到报告；核对 continuation 穿过每个业务 catch；验证重复派发不重复模型请求、pendingDispatch 拒绝重放；验证拒绝/超时/输出修复分类；验证并发与 max_calls；验证成员移除、授权撤回、来源回收、设置变更及并发 finish 在发布 SQL 被拒绝；最后在获授权的供应商真实接口逐协议验证 token 和搜索证据。真实供应商可达性、当前模型能力和 Worker 子请求深度不能仅凭本地测试确认。
## 14. 前端请求、缓存与编辑安全

### 请求契约和查询刷新

`api/client.ts.request()` 为请求增加合法的 `X-Request-Id`，使用 `credentials: 'include'` 携带会话 Cookie；JSON 正常响应须有 `data`。错误转为 `ApiError`，保留 `status/code/requestId/retryable/stage/action/details`，显示消息通过 `error-info.ts` 转换。网络错误使用状态 0；AbortError 原样抛出；非 JSON 或缺少 data 的成功响应成为 `INVALID_RESPONSE`。遇到非 session 查询的 401 会广播 `auth-expired`，`App.tsx.ProtectedApp` 清空 QueryClient 并跳转登录。

`main.tsx` 的 QueryClient 默认查询新鲜期为 8 秒，窗口聚焦重新取数，最多额外重试一次且不重试 401；mutation 默认不自动重试。页面写入成功后显式失效相关 query key，例如 MaterialsPage 保存后刷新 material、materials、materialVersions 和 resource-library。新增修改必须检查列表、详情、壳内项目状态是否都应刷新，且 key 必须包含项目或账户边界；不要只更新一个局部组件后留下旁边的旧数据。

前端 POST 默认生成幂等键，但每次重新调用 `api.post` 会生成新键；这不是“任意重新点击都不会重复”。需要恢复同一个业务动作时，调用方必须持有并复用原键，服务端具体接口也必须使用 `withIdempotency`。分页批量读取 `listAllItems()` 会检测重复游标、items 缺失及超过 200 页，避免静默返回不完整列表。

### 材料草稿、版本冲突及离开保护

`storage.ts.saveDraft/getDraft/removeDraft` 以账户、项目、材料组成 localStorage 键；保存失败返回 false。`MaterialsPage.tsx` 维护文档、baseRevision 和重连确认状态，保存前提交当前 `expectedRevision`；409 VERSION_CONFLICT 时保留本地内容并读取最新服务器版本，不能通过将 revision 直接改成新值而静默覆盖他人的编辑。离线本机草稿不是已同步的共享材料，也不是跨设备备份。

`SettingsEditGuard.tsx` 用脏编辑集合和 React Router `useBlocker` 拦截页面切换，beforeunload 处理关页，`settings-before-leave` 协調退出登录。新增编辑页面要接入现有 dirty context，而非各自增加互不相容的 confirm。`WorkspaceErrorBoundary` 和 `resilient-lazy` 负责路由运行错误和懒加载资源失败；修改加载/错误流程时需检查手机网络断续及已登录会话恢复。

### PWA 更新、离线边界和通知

`vite.config.ts` 配置更新提示模式、`skipWaiting: false`、`clientsClaim: true`；导航由 `public/navigation-worker.js` 处理，不启用 Workbox 的运行时 HTML 缓存。带 hash 的 JS/CSS 使用 `ai-office-assets-compat-v1` CacheFirst，最多 256 项、保留 7 天，帮助旧标签页读取旧 chunk。API 由网络和后端提供，不把 Service Worker 缓存视为业务数据源。

`public/app-updates.js` 的更新控制器注册 `/sw.js`，检查等待 worker，确认后发 `SKIP_WAITING`，等待控制及激活后重新加载；重新加载发 `app-update-reload`，编辑保护识别该确认流程。新增 PWA 更新逻辑要配合既有草稿/dirty 保护，验证旧标签页、失败恢复和离线情形，避免只测全新打开页面。

`NotificationRuntime.tsx` 随登录账户挂载，`App.tsx.PwaStatus` 将通知 scope 切到账户加项目。服务端 `services/notifications.ts`、`web-push.ts` 与 `api/notifications.ts` 管理通知和设备订阅，浏览器推送由 `public/push-worker.js` 处理。账户通知、项目通知、系统更新提示具有不同作用域，退出登录和切换账户的测试不能省略。Web Push 还依赖浏览器权限及 VAPID 配置，单元测试不等于真机推送通过。

## 15. 本地启动、契约同步与验证

### Windows PowerShell 的可重复开发流程

以下命令在仓库根目录运行；分别检查退出码，失败即停止后续步骤。本地迁移仅针对模拟数据库；不附带 remote 或 production。两终端启动比后台进程更易观察错误：终端 A 跑后端，终端 B 跑前端，结束时 Ctrl+C。

```powershell
npm run install:all
if (!(Test-Path backend/.dev.vars)) {
  Copy-Item backend/.dev.vars.example backend/.dev.vars
}
git check-ignore backend/.dev.vars
```

复制后先在本机编辑 backend/.dev.vars，将 AUTH_SECRET、ADMIN_TOKEN 的示例值换为独立随机开发值；本地不调用模型时其余 provider 值可保持为空。下面初始化命令只适用于新的、空的本地模拟库；已有本地库先核对迁移和数据，不要盲目全量应用0033。全量新库重放包含0033，并移除旧人工账本表；不能用空库验证直接推断目标生产库的实际迁移状态。

```powershell
Push-Location backend
npm exec -- wrangler d1 migrations apply DB --local
Pop-Location
npm run bootstrap:admin:local
npm run dev:backend
```

bootstrap 仅初始化本地管理员，凭据保存在 Git 忽略目录；重复运行不会自动重置密码。查看本机凭据再登录，不把其内容粘贴到公开报告。后端终端保持运行。

另开终端进入同一仓库根目录：

```powershell
npm run dev:frontend
Invoke-RestMethod http://localhost:5173/api/v1/health
Invoke-RestMethod http://localhost:5173/api/v1/health/deps
```

Vite 默认 5173，代理 `/api` 到 127.0.0.1:8787；`AI_OFFICE_API_TARGET` 可更改代理目标。localhost 前端与后端要使用一致地址，避免会话、Origin 和代理产生误判。首次创建本地测试账号可按仓库 bootstrap 的 local 流程操作；私密参数放忽略文件，不把真实密码、密钥写进终端命令历史、报告或 Git。不要为解决本地登录覆盖生产凭据。

如确实需隐藏后台开发服务，使用 PowerShell `Start-Process`、`-WindowStyle Hidden`，分别将 stdout/stderr 指向本地忽略日志并保留 `-PassThru` 的进程信息。停止时只终止本次启动的准确进程或进程树；不要全局终止 node/wrangler。CLI 版本可从 package-lock 和 npm 脚本核对，不要求全局安装另一个 Wrangler。

### OpenAPI 变更顺序

契约来源为后端路由中的 createRoute/Zod schema，导出文件是生成物：

```powershell
npm run export:openapi --prefix backend
npm run typegen --prefix frontend
npm run typecheck
npm run lint
```

`backend/scripts/export-openapi.ts` 调用 createApp 导出到 `backend/openapi/openapi.json`；`frontend` typegen 生成 `src/api/openapi.ts`，手写业务别名在 `api/types.ts`。不能只改生成的 TypeScript 消除报错；必须同步请求验证、返回 DTO、契约和页面读取。导出后检查 diff 是否只出现预期内容，并跑 `backend/test/03-contract.test.ts`。

### 按变更选择测试

后端 Vitest 配置使用 Cloudflare Workers pool，`test/setup.ts` 在模拟 D1 按序应用迁移；测试 mock 模型调用，不应用测试去证明真实 provider 可用。按变更范围运行受影响测试及必要的全量检查，前端最终 build 已含 tsc。

| 变更范围 | 最低优先测试 |
| --- | --- |
| 上传、来源生命周期、解析 | 10-files、70-sources-parse、源分页与文件/来源生命周期相关测试 |
| 材料和任务 | 80-tasks-materials、102-project-simplification、110-project-plans-assessments-tools |
| 登录和权限 | 40-auth、41-password-kdf、43-account-roles、121-member-permissions |
| 评分与演练 | 84-reviews-rehearsals、110-project-plans-assessments-tools、114-rehearsal-ownership |
| AI 工具/执行恢复 | 121-project-tool-contracts、109-project-reference-guard、116-independent-workflow-slices、120-provider-retries |
| 前端请求与草稿 | api/client.test、storage.test、MaterialsPage 相关测试、SettingsEditGuard 相关测试 |
| 导航、帮助和 PWA | project-routes、HelpPage、AppShell、app-updates、navigation-worker、asset-compat、push-worker |

可从根目录运行 `npm run test:backend`、`npm run test:frontend`、`npm run typecheck`、`npm run lint`、`npm run build`。定向运行示例为 `npm test --prefix backend -- test/80-tasks-materials.test.ts`。有 UI 改动须另外真实浏览器核对桌面和手机宽度、深链接刷新、键盘和错误态；有运行时依赖改动须区分本地 Worker 模拟与线上 Cloudflare 实测。

## 16. 迁移与结构核对

1. 先查看 Git 状态、当前迁移文件和部署配置，再以只读方式核对目标 D1 的 `d1_migrations`、`sqlite_master`、关键表 `PRAGMA table_info/foreign_key_list/index_list`。生产资源 ID、凭据和业务数据不应出现在公开帮助文档。
2. 当前存在两个 `0025`：`0025_project_simplification.sql` 与 `0025_ticket_images.sql`。跟踪的是完整文件名；不能按数字前缀去重或认定二者互相替代。存在 0007 等编号缺口不代表数据库缺迁移，不得凭空补 SQL。
3. `0033_remove_manual_ledger.sql` 清空 contributions.correction_of 后 DROP contributions、resource_references、decisions。当前结构参考包含该迁移；重放新数据库与更新既有生产库是两种不同任务。未确认备份、实际迁移记录和历史数据保留要求前不能执行该文件。
4. 0012 是新增 auth_accounts 并回填联系邮箱，不迁移 user ID；0013 包含一个历史指定身份的角色回填，仅适合了解历史，不能当通用新环境 bootstrap；0026 先保存旧成员档案导入候选再清项目域字段，不能拆开运行。0030 清除 team_size_limit，0036 根据历史回答和作业回填作者/处理持有者，0037 建立通知 baseline，都含数据迁移副作用。
5. 本地参考重放必须有 SQLite JSON1、外键约束和迁移依赖；执行检查点为 integrity_check 与 foreign_key_check。通过空数据库检查只能证明结构可创建，不能验证存量数据转换；对真实迁移还需使用相关 preservation 测试和脱敏副本进行前后行数、ID、引用链及字段值核对。
6. 写跨表业务改动前找对应 service 的 CAS 门禁与 batch 边界；写 JSON 字段前找 Zod schema、契约和 toView 映射；删除文件前读 lifecycle/GC；改变任务图前读 validateTaskGraph；改变 AI 执行前读 ai-reservations/jobs/execution-slices/investigation。只改前端模型或数据库字段，通常无法完成完整行为变更。

### 可复现核对流程

```text
py scripts/verify-handover-docs.py
```

文档结构验证脚本在本地 SQLite 内存重放迁移，并核对已发布的结构字典；不连接生产，也不修改项目数据库。本次额外结构证据记录迁移完整文件名、执行/跳过原因与 SHA-256、所有表列/FK/索引/DDL、视图/触发器、完整性检查结果及生产结构离线比对。服务行为核对基于 jobs.ts、ai-reservations.ts、collaboration.ts、project-simplification.ts、source-summary.ts、document-chunks.ts、ai-execution-slices.ts、project-investigation.ts 等现行源码。完整列字典应作为可下载附录，帮助页面正文优先呈现关系、状态与读写入口。

## 17. 发布、恢复与排障

### 环境绑定与生产迁移

后端环境有 local、staging、production；绑定名称为 `DB`、`FILES`、`PARSE_WORKFLOW`、`AGENT_WORKFLOW`，cron 每分钟执行；前端绑定 `ASSETS` 和 `API`。现有 production 使用两个 Worker，前端 Service Binding 指向同环境后端。保留 wrangler 配置中的真实资源，不重建数据库或桶来“修复”环境。staging 的占位配置未完成时预检应失败，不可擅自借生产绑定。

Env 中需要按部署功能核对的敏感变量名称包括 AUTH_SECRET、CLOUDFLARE_API_TOKEN、ADMIN_TOKEN、RESEND_API_KEY、TURNSTILE_SECRET_KEY、VAPID_PRIVATE_KEY；其他绑定变量/配置包括 CLOUDFLARE_ACCOUNT_ID、AI_GATEWAY_ID、ALLOWED_ORIGINS、EMAIL_FROM、VAPID_PUBLIC_KEY、VAPID_SUBJECT。这里只列名称，实际是否必需应结合所启用功能和服务代码核对。当前 Env.AUTH_MODE 类型仍写 invite-only/turnstile，而 wrangler 实际使用 password，是需要核对的类型与配置不一致处；不要据旧枚举重新开启旧邮件登录。

发布前执行 `npm run preflight:deploy -- production`。`scripts/preflight-deploy.mjs` 检查环境、password 模式、D1/R2/Workflows、前后端 Service Binding 和 HTTPS Origins；它不会部署，也不验证线上 Secrets、数据库版本或真实模型。后端有 deploy:production 脚本；前端部署需在 build 后用现有 production Wrangler 配置。顺序按契约兼容性决定，一般先发布兼容旧前端的后端，再发布前端及静态资源，之后验证线上资源和 API。

禁止把 `wrangler d1 migrations apply --remote` 当成可直接执行的生产全量更新。`0033_remove_manual_ledger.sql` 会清除 correction_of 自引用并 DROP contributions、resource_references、decisions；它是破坏性历史迁移。先读取目标库迁移历史与真实 schema，列出已应用/待应用范围，核对数据依赖并备份，再决定单项批准的迁移。不能只将文件移走或更改迁移记录来绕过风险，也不能让测试已全量迁移的结果替代生产库判断。

生产备份应使用整库可恢复导出并保护文件访问，另核对 R2 对象、配置版本及作业恢复要求；数据库 SQL 不是文件对象的备份。`npm run backup:drill:local` 是独立模拟恢复演练，不能证明当前生产备份齐全。恢复后还需检查 users/project_members 外键、版本指针、jobs/并发预占及引用有效性；不要自动 reset 管理账号或重放仍在执行的作业。

### 排障取证顺序

请求失败先保留 requestId、时间、URL、账户/项目操作类型和错误 code/stage/action，不复制 Cookie 或 token。`health` 只能证明 Worker 存活；`health/deps` 返回 D1/R2 可达性，不能证明业务权限、schema 完整或模型正常。后端 `request_failed` 日志包含 requestId/code/httpStatus/retryable，公共错误有脱敏；需要深入诊断时使用现有允许的管理员诊断，不把 provider 原始响应公开到帮助页面。

异步任务先查 `/api/v1/jobs/{jobId}` 与创建业务对象：确认 queued/running/succeeded/failed、输入配置版本、实体版本和 Workflow ID/状态，然后判断是否可恢复。requestId 标识某次 HTTP，jobId 标识持久作业，Workflow instance 标识执行容器；三者不能互换。长作业要核对执行切片/continuation 与现有运行实例，避免因页面超时再次创建作业。失败是否可重试以错误分类和保存的业务状态为准，而非统一重新 POST。

怀疑 schema 漂移时查看目标库迁移历史及 `sqlite_master`/表字段、索引、外键；核对报错 SQL 所需列在哪个迁移加入，比较源码 DTO 与 OpenAPI 生成物。不要把 ai_config_versions.version、材料 revision、任务 graph_revision 当成数据库 schema 版本。前端菜单或代码旧时比较构建版本、hash 静态资源、等待 Service Worker 和旧标签页；先保存草稿再按既有更新流程刷新。

## 18. 典型扩展方法与当前状态边界

### 为实体增加字段

先写清字段属于实体当前属性、不可变版本快照还是派生展示。增加向后兼容迁移并决定旧行默认值；更新 SQL 写入/读取、Zod 验证和 DTO；必要时增加 expectedRevision 防并发覆盖及事务 guard；导出 OpenAPI/typegen；更新页面输入、空值展示、query 失效、导出及 AI 上下文。测试覆盖旧数据、未传字段、非法值、跨项目引用和版本冲突。最后检查新增字段是否含隐私，是否应该进入 AI 工具、公共资料或通知载荷。

### 增加 AI 工具或一种 AI 作业

读 `services/project-ai-tools.ts.projectToolDefinitions/executeFileTool/projectToolConversation`，先定义模型可见的 schema、参数限制、服务端绑定 context 和结果 DTO；严禁让模型参数决定 actor/project/session 身份。执行前后沿用 assertToolAccess、文件/来源生命周期快照及引用核验，记录脱敏 ai_tool_calls；接入 tool transport 时同时考虑可支持的 provider 及 continuation checkpoint。新作业还需 API 参数冻结、job 类型/dispatcher、并发槽位预占、Workflow 可恢复分支、幂等发布与调用留痕。不要只写一个 fetch gateway 的 handler 就绕过持久执行和审计证据。

测试至少涵盖非法参数、非成员/撤权、跨项目文件、软删除后的输入、模型返回格式错误、工具多轮上限、执行恢复及结果重复发布；更新功能入口和契约后再做本地/线上边界明确的验证。

### 当前工作区不是生产版本证明

本次核对时，`backend/src/services/agent.ts`、`assessments.ts`、`assignment.ts`、`guide-history.ts`、`project-ai-tools.ts`、`project-context.ts` 六个服务已有未提交修改；相应部分测试以及前端帮助/移动导航也有未提交改动。本文描述的是读取时的工作区实现，不能据此推断所有分支已经提交或线上 Worker 已部署相同实现。变更与发布核对前应保存 git status/diff、当前 commit、目标 Worker 版本及前端构建版本，分别确认这些修改的负责人、测试状态和发布范围；不要为“清理工作区”丢弃它们，也不要把 unrelated 后端改动夹进文档发布。
## 19. 术语与维护验证

| 标识或概念 | 应用于哪里 | 不应混用的概念 |
| --- | --- | --- |
| requestId | 某一次 HTTP 请求、响应错误与 request_failed 日志 | 一次点击可能创建长期 job，requestId 不等于 jobId |
| jobId | jobs 与调用、预占、调查、工具审计关联 | jobs.attempts 不是模型调用次数 |
| Workflow instance_id | 某一运行实例，首片为 jobId，后续为 jobId-sN | slice 是执行资源边界，不是新的业务任务 |
| configVersionId / promptVersion | 模型配置快照 / 提示词语义版本 | 当前配置不自动替换过去输入 |
| revision / graph_revision / lifecycle_version | 实体编辑 / 全图变更 / 删除恢复有效性 | 数据库迁移版本是 d1_migrations 的完整文件名 |
| source / material / fixed version | 来源证据 / 成果文档 / 已保存不可变版本 | 草稿、总结、附件目录不等于已核验原文 |
| read reference / decision reference | 实际读过的片段 / 对某项决定使用的依据 | 引文格式合法不证明语义判断正确 |
| reserved / settled / released | 活动并发预占 / 已结束或已释放 | 终态任务不能继续占用活动槽位 |

维护验证应形成可复核记录：本地安装和构建正常；登录及五组项目功能可定位到路由与 SQL；数据库字典验证通过并与目标环境迁移记录对齐；固定响应模型夹具能追踪排队、调用、报告和发布；并发编辑、撤权、回收站、pendingDispatch 及重复执行负向测试通过；发布只包含已核对的变更；线上资源和 API 状态有独立检查。真实模型行为、质量、设备推送与平台限制仍需单独验证，不能把本文的结构检查当成这些结果。

## 20. 全表定位目录

以下目录覆盖全部 78 张应用表；同域关系及核心列见前文，完整列/约束见结构附录。目录没有列出的 templates、exports、document_chunks、attachments 不是遗漏的数据库表。

| 域 | 表 | 用途与关系 |
| --- | --- | --- |
| 身份 | `users`, `auth_accounts`, `sessions` | 用户主体、密码身份与会话；账号和会话引用 users。 |
| 账号治理 | `account_invitations`, `account_role_audit` | 注册邀请及角色变更审计；创建/使用/操作/目标用户引用 users，不与项目邀请混用。 |
| 登录保护 | `auth_challenges`, `auth_password_rate_limits` | 邮箱验证码挑战的 HMAC/尝试/过期消费状态；密码登录限流的 bucket_key/attempts/expires_at。 |
| 邮件配额 | `auth_email_daily_usage`, `auth_email_recipient_usage`, `auth_email_ip_attempts` | 分别按 day、(day,email_hash)、ip_hash/attempted_at 计数或记录；非用户 FK 关联，不存验证码明文。 |
| 档案 | `personal_profiles`, `personal_profile_import_candidates` | 用户全局档案及旧成员档案候选，均归属 user；公开与AI使用同意独立。 |
| 项目 | `projects`, `project_members`, `project_goals` | 项目/成员/单主目标；成员(project,user)唯一，目标(project)一对一。 |
| 项目邀请 | `invitations`, `project_username_invitations` | 项目邀请码与指定账号邀请；邀请码保存 hash，用户名邀请保存处理状态和过期时间。 |
| 推进 | `project_progression`, `project_admin_feedback` | 项目推进游标 observed/pending_event 与待执行job；项目管理者人工反馈与是否要求AI重做，归属 project。 |
| 创建草稿 | `project_creation_drafts`, `creation_draft_files` | 未创建正式项目的私人工作区与上传文件，draft→owner，draft_file→draft。 |
| 文件 | `files`, `file_contributors` | 原文件对象索引与贡献署名；file→project/user，contributor→file并保留用户姓名快照。 |
| 来源 | `sources`, `source_versions`, `source_pages`, `source_fragments`, `source_processing` | 来源实体→版本→页/原文片段/处理状态；版本关联原文件与冻结AI配置。 |
| 材料 | `materials`, `material_versions` | 可编辑资料实体与内容/附件/作者快照，按(material,revision)唯一。 |
| 要求与标准 | `requirement_sets`, `requirements`, `rubric_versions`, `standards_versions` | 要求集→要求；评分维度版本→已发布整体标准快照。 |
| 任务图 | `tasks`, `task_dependencies`, `task_links` | 任务、项目内依赖边、多态关联；task_links种类 requirement/material/source_version/file，target_id需服务验证。 |
| 任务交付 | `task_submissions`, `task_summaries` | 每轮提交及哈希隔离摘要；提交保留当时标准、材料与任务版本。 |
| 任务准备 | `task_readiness`, `task_completion_people` | readiness基线/generation与实际完成者，关联tasks；配合视图/触发器。 |
| 私密询问 | `task_inquiries`, `task_inquiry_messages` | 当前/上游任务与请求者/收件人形成询问，消息归属inquiry/author。 |
| 协作建议 | `collaboration_proposals`, `collaboration_proposal_revisions` | 一个job一条规划/分工建议，修订保存原payload与人工理由。 |
| 助手 | `agent_sessions`, `agent_turns`, `agent_runs` | 项目助手会话、唯一(session,sequence)回合、执行/采纳证据；run关联job并保存inputs/output与采纳material version。 |
| 评估 | `assessments`, `assessment_corrections`, `reviews` | 统一评估及修订历史、原有预审底层实体；绑定已发布标准与材料版本证据。 |
| 答辩 | `rehearsals`, `rehearsal_turns` | 答辩范围/版本/处理作业、按序回合与回答作者。 |
| 过程记录 | `events`, `comments` | events按(project,type,entity_type,entity_id,dedup_key)去重；comments按target_type/id定位，多态target不含FK。 |
| 作业 | `jobs`, `job_outbox`, `ai_execution_slices`, `idempotency_records` | 业务任务、可靠派发、独立执行接力与HTTP请求去重；不能用一张表的状态替代全部执行证据。 |
| AI配置 | `ai_config_versions`, `ai_probes`, `app_config` | 模型配置版本；probe复合PK(config_version_id,purpose)保存能力检查passed/report/tested_at；app_config按key保存应用级JSON与时间。 |
| AI执行 | `ai_calls`, `usage_reservations`, `ai_investigations`, `ai_tool_calls`, `ai_diagnostics` | 调用证据、并发预占、R2调查检查点索引、工具证据、有界无内容诊断。 |
| 通知 | `notification_settings`, `notification_events`, `notification_inbox`, `push_subscriptions`, `notification_push_outbox` | 用户站内/Push开关、去重事件、每人已读状态、设备订阅与可靠网络发件箱。 |
| 反馈工单 | `support_tickets`, `support_ticket_messages`, `support_ticket_images` | 私人工单→回复/状态记录/图片；ticket归owner，message归author；图片先reserve pending再R2上传ready，限制类型与1..5MB。 |

当前标准由 `backend/src/services/effective-standard.ts` 统一解析：最高保存版本立即生效，新保存和修订均创建不可变版本。`GET /standards/current` 提供使用入口；不再注册标准确认接口。新评分、演练、任务评价和 AI 资料工具自动绑定此版本；模型调用、发布、应用及重试均核对版本，旧版本只可作为历史依据读取。`0044_saved_standard_activation.sql` 冻结旧保存草稿及引用组件，不改写已有报告。

### 任务设置自动保存与质询入口

任务设置由 TaskSettings 串行保存内容、依赖、分工，停止输入三秒和区域失焦触发保存，窗口关闭调用异步保存守卫。任务写入采用响应中的 revision；依赖采用最新 graphRevision，提交依赖后重新读取任务版本。409 后重新读取任务和依赖图，三方字段合并仅自动处理无冲突字段；同字段冲突保留草稿并要求选择。前端版本提示隐藏，后端事务守卫和审计保留。

任务质询按一对一工单组织。项目成员可在对应任务中选另一位项目成员创建工单，不要求是任务执行人，也不受依赖关系或任务状态限制。新记录将 `task_id` 与 `upstream_task_id` 都设为该对应任务；创建与回复通知均跳转到该任务。列表、回复和已读接口仍逐项校验发起者/接收者与当前项目成员资格，只有工单双方可见。旧记录的两个任务 ID 保持不变，并继续分别显示在历史发起任务和接收任务。GET /task-inquiries/unread 复用 `notification_inbox.read_at` 汇总；POST /tasks/{taskId}/inquiries/read 只更新已展示的 `messageIds`。无需数据库迁移。

离线工作台在项目入口、online、focus 和可见状态恢复时先 synchronizeOffline 再 prepareProject；组件和缓存准备层合并重复执行。正常联网时隐藏缓存就绪提示，失败与冲突仍可处理。可缓存 GET 优先读取当前账户的 IndexedDB 快照（含待同步操作叠加），再合并重复请求、后台静默更新；后台请求限时 15 秒，失败保留当前内容，快照变化后失效活动查询以刷新视图。任务页的澄清、建议历史及质询未读列表也纳入缓存；项目准备先保存任务与材料，再分批读取独立页面，单项失败不阻止其他页面保存，仅完整成功后写入就绪标记。Service Worker 对工作台导航优先返回构建时预缓存的静态入口，API 数据仍由账户隔离的应用缓存负责。

### 任务文件版本与归档（0055）

项目可供 AI 引用的业务输入和内容节点由 `AiReferenceBadge` 标记，`Field` / `SectionCard` 通过显式 `aiReference` 开启；标识为蓝色胶囊，不向用户正文写入告知文字。AppShell 内的 `AiReferencePreferencesProvider` 按账户读取本浏览器偏好，用户在“设置 → 外观”控制显示，默认开启，跨标签页通过 storage 事件同步。隐藏标识不改变个人资料授权或服务器读取权限；个人资料只有 aiUseAllowed 为真时标记，私密任务质询和安全凭据不标记。

0055_task_files_archive.sql 为 files 增加 archived_at，为 materials 增加 task_id/archived_at，并新增 task_file_uploads 保存物理上传文件到稳定材料身份的映射。一个任务上传文件对应 kind=task-file 的材料；current_version_id 指向当前附件，替换上传新 R2 对象及不可变 material_versions，旧文件和提交快照保留。登记按 fileId 去重，替换成功响应丢失后重试同一当前 fileId 返回原结果。新文件自动产生材料，提交界面按未归档当前版本构建 materialVersionIds，原提交协议保留。

任务文件管理权限在事务内重检当前执行人或 resourceManage；公共材料创建者和公共文件上传者可管理本人的内容。更换执行人后前任不再因上传身份管理任务文件。文件归档复用 lifecycle_version 乐观锁，材料归档递增 revision；审计与状态更新处于同一事务。归档和回收站分离，恢复文件不恢复整份材料。任务文件正文禁止普通编辑和 AI 采纳，通过文件替换入口更新。

共享 archive-policy 过滤默认 AI 文件发现、资料搜索、任务计划和交接输入；已归档或已被新版本替换的上传不进入普通列表。显式固定版本读取、历史提交和前置任务成果快照保留，不因归档破坏历史证据。提交写入事务拒绝已归档材料或附件，避免读取列表后发生归档仍提交。未提取正文的附件沿用现有未读证据与人工验收规则，不把上传成功视为 AI 已完整读取。

### 标准摘要展示与提交正文折叠

评分分区导航由 ProjectSectionNavigation 统一提供，保留 assessment 的 section 查询参数与旧 requirements/reviews/rehearsals 路由。StandardsEditor 保留评分维度编辑与历史入口，StandardSummary 只遍历 rubric.weights，并按 mappings 从对应 requirements.citations 生成引用编号；不会从 rubric.notes 猜测来源。编号按首次出现顺序分配，以固定 fileId 优先去重，文件名仅在底部引用列表展示。固定文件采用带成员权限的文件内容链接，避免当前来源版本的归档状态影响旧引用定位。

standardView 批量读取项目范围内的引用元数据与可用状态，源版本引用每份标准仅增加一次批量查询，fragmentId 历史引用另加一次解析查询。输出补充可选文件名和定位信息，不修改 snapshot_json 或评分规则；2000 条重复引用的测试验证仅执行两次读取（版本状态及引用元数据）。SubmissionBody 使用默认关闭的原生 details，仅折叠成果正文，完整文本和验收控件保留。此变更不需要数据库迁移。

### AI 失败请求批量重试

`0056/0057` 新增管理员批次、失败快照、后继映射和自动恢复队列。`cron` 分批执行 `recoverAdminAiRetries` 与 `recoverAutomaticAiRetries`，调用共同的业务恢复校验；并发槽位不足继续排队，权限/输入失效则停止。管理员读取统计，超级管理员才能一键入队。`GET /jobs/{id}` 跟随后继，待自动恢复的失败尝试对逻辑请求呈现 queued 并附 retry 元数据，保留原始错误；数据库旧失败作业仍保持终态。详见仓库 `README.md` 与 `README.md`，语音答辩已接入，文件转录仅Whisper；实时转录经Gateway、TTS使用系统本地语音，失败回退文字，真实模型验收仍需专用凭据。

### 音频模型职责与语音答辩

设置将 mediaUnderstanding 音视频理解、audioFileTranscription 固定 Whisper、realtimeAudioTranscription 专用实时模型、rehearsalSpeech 系统本地 TTS 和 processingStrategies 分开。新语音调用由后台保存凭据，浏览器只连接本项目 WebSocket，不发送项目材料给 ASR，也不让 TTS 出题，本地朗读不向合成服务器发送文字。语音失败切回文字，最终字幕保留，仍由用户核对并提交原 answers 接口；后台文字模型生成追问与评分。详见仓库 README.md 的接口、权限和真实验收边界。
### 评分生成输出契约 v2 与错误透传

standards.generate 使用严格 scoringStandardOutputSchema，只接受 methodSource 和 dimensions，维度只含 key/label/weight/citations。documented 必须引用实际读取的 source 固定片段，名称与原始分值逐字可验证，引用不得夹带其他原文；proposed 根据主目标生成总和100的权重，引用必须为空。服务端转换到兼容保存结构时 detail/notes 为空、category=scoring、日期为 null，原始分值按比例转换为百分比。scoringOnly 上下文只预载来源目录，仅暴露原文检索工具，不读取任务、反馈、旧标准或模型总结。引用批量补充原文件名和定位字段，前端 fromGenerated 保留并通过保存协议传回引用核心字段。scoringOutputVersion=2 阻止旧格式任务恢复或旧成功结果进入编辑器，不重放旧的已付费调查。

ApiError.message 直接取后端 message，兼容无错误码/请求编号的消息对象及纯文本原因。ErrorNotice、页面边界和所有作业/传输/通知/权限错误入口使用统一 errorMessage 原文显示，React 文本节点安全渲染并保留换行；诊断元数据只留在内部，不作为网页错误提示展示，不追加 traceback 或固定泛化提示。

## AI 活动与断点恢复

迁移 `backend/migrations/0061_ai_activity.sql` 增加安全活动摘要与步骤记录。`backend/src/services/ai-activity.ts` 维护真实阶段和模型返回时间，普通任务及私有创建草稿采用相同展示协议。任务操作记录可分页读取并串联执行尝试；草稿及无项目任务限制拥有者访问。

`backend/src/services/ai-checkpoints.ts` 在私有 R2 加密保存模型响应，调查断点按执行尝试隔离，已收到响应优先用于校验和业务保存。失败续跑沿用输入版本、来源生命周期、权限及并发检查；旧尝试不能覆盖新的业务结果。结果不明的模型请求不自动重放，用户主动续跑时重新请求当前步骤，界面提示可能重复计费。当前实现及验证说明见仓库 `README.md`。
<!-- help:technical:end -->

<a id="help-database"></a>
<!-- help:database:start -->
# 数据库完整结构字典

本字典由 `scripts/update-handbook-schema.py` 在空的内存 SQLite 中重放 `backend/migrations/*.sql` 后生成，仅跳过演示数据 `0002_seed.sql`。当前包含 152 张表（含全文索引影子表）。它描述代码迁移后的目标结构，不代表生产数据库已经应用；不会读取或修改本机或生产数据。完整约束保留在 DDL，类型、非空、默认值、主键、外键和索引来自实际元数据。

AI 金额字段仅为历史结构兼容，不代表现行项目预算功能。ID/JSON/时间字段的业务校验仍以服务端契约为准。字典中的 DDL 仅供说明与空库校验，部署必须按原迁移顺序执行。

[返回技术说明](/app/help?doc=technical)。

## `account_invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `code_hash` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `used_at` | TEXT | 否 | 无 | 否 |
| `used_by` | TEXT | 否 | 无 | 否 |

外键：
- `used_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_account_invitations_2`：`code_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_account_invitations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE account_invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES users(id)
);
```

## `account_role_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `previous_role` | TEXT | 是 | 无 | 否 |
| `new_role` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `target_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_account_role_audit_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE account_role_audit (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  previous_role TEXT NOT NULL,
  new_role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

## `admin_ai_retry_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'queued' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `admin_ai_retry_one_active`：`None`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_admin_ai_retry_batches_2`：`idempotency_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_admin_ai_retry_batches_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE admin_ai_retry_batches (
 id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, requested_by TEXT,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX admin_ai_retry_one_active ON admin_ai_retry_batches((1)) WHERE status IN ('queued','running');
```

## `admin_ai_retry_items`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `batch_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `failed_at` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `retry_job_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `batch_id` → `admin_ai_retry_batches.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `admin_ai_retry_due`：`status, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_admin_ai_retry_items_2`：`batch_id, target_type, target_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_admin_ai_retry_items_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE admin_ai_retry_items (
 id TEXT PRIMARY KEY, batch_id TEXT NOT NULL REFERENCES admin_ai_retry_batches(id),
 target_type TEXT NOT NULL CHECK(target_type IN ('job','draft')), target_id TEXT NOT NULL,
 failed_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','queued','skipped')),
 reason TEXT, retry_job_id TEXT, updated_at TEXT NOT NULL,
 UNIQUE(batch_id,target_type,target_id)
);
CREATE INDEX admin_ai_retry_due ON admin_ai_retry_items(status,updated_at);
```

## `admin_ai_retry_links`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `parent_job_id` | TEXT | 否 | 无 | 1 |
| `retry_job_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `retry_job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `parent_job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_admin_ai_retry_links_2`：`retry_job_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_admin_ai_retry_links_1`：`parent_job_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE admin_ai_retry_links (
 parent_job_id TEXT PRIMARY KEY REFERENCES jobs(id), retry_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), created_at TEXT NOT NULL
);
```

## `agent_bridge_artifacts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `handoff_id` | TEXT | 是 | 无 | 1 |
| `artifact_id` | TEXT | 是 | 无 | 2 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `stored` | INTEGER | 是 | 0 | 否 |

外键：
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `handoff_id` → `agent_bridge_handoffs.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_agent_bridge_artifacts_2`：`file_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_agent_bridge_artifacts_1`：`handoff_id, artifact_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_bridge_artifacts (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 artifact_id TEXT NOT NULL, file_id TEXT NOT NULL REFERENCES files(id), name TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, stored INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(handoff_id,artifact_id), UNIQUE(file_id)
);
```

## `agent_bridge_devices`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `credential_hash` | TEXT | 是 | 无 | 否 |
| `device_name` | TEXT | 是 | 无 | 否 |
| `bridge_version` | TEXT | 是 | 无 | 否 |
| `dsh_version` | TEXT | 是 | 无 | 否 |
| `owner_id` | TEXT | 否 | 无 | 否 |
| `pairing_expires_at` | TEXT | 是 | 无 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `last_seen_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `owner_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_agent_bridge_devices_2`：`credential_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_agent_bridge_devices_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_bridge_devices (
 id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL UNIQUE, device_name TEXT NOT NULL,
 bridge_version TEXT NOT NULL, dsh_version TEXT NOT NULL, owner_id TEXT REFERENCES users(id),
 pairing_expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, created_at TEXT NOT NULL
);
```

## `agent_bridge_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `handoff_id` | TEXT | 是 | 无 | 1 |
| `sequence` | INTEGER | 是 | 无 | 2 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `handoff_id` → `agent_bridge_handoffs.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_agent_bridge_events_1`：`handoff_id, sequence`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_bridge_events (
 handoff_id TEXT NOT NULL REFERENCES agent_bridge_handoffs(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(handoff_id,sequence)
);
```

## `agent_bridge_handoffs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `task_revision` | INTEGER | 是 | 无 | 否 |
| `device_id` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `request_hash` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `snapshot_hash` | TEXT | 否 | 无 | 否 |
| `snapshot_key` | TEXT | 否 | 无 | 否 |
| `context_hash` | TEXT | 否 | 无 | 否 |
| `context_stamp` | TEXT | 否 | 无 | 否 |
| `eligibility_hash` | TEXT | 否 | 无 | 否 |
| `session_id` | TEXT | 否 | 无 | 否 |
| `last_sequence` | INTEGER | 是 | 0 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `stale` | INTEGER | 是 | 0 | 否 |
| `adopted_submission_id` | TEXT | 否 | 无 | 否 |
| `adoption_token` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `device_id` → `agent_bridge_devices.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 3/0；MATCH NONE。

索引：
- `agent_bridge_queue`：`device_id, state, created_at`；唯一=0；来源=c；部分索引=0。
- `agent_bridge_one_task`：`task_id`；唯一=1；来源=c；部分索引=1。
- `agent_bridge_one_active`：`device_id`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_agent_bridge_handoffs_2`：`requested_by, idempotency_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_agent_bridge_handoffs_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_bridge_handoffs (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL REFERENCES tasks(id),
 task_revision INTEGER NOT NULL, device_id TEXT NOT NULL REFERENCES agent_bridge_devices(id),
 requested_by TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('checking','waiting_device','claimed','running','waiting_input','uploading','ready_for_review','blocked','failed','cancel_requested','cancelled','dispatch_uncertain')),
 reason TEXT, snapshot_hash TEXT, snapshot_key TEXT, context_hash TEXT, context_stamp TEXT, eligibility_hash TEXT,
 session_id TEXT, last_sequence INTEGER NOT NULL DEFAULT 0, result_json TEXT,
 stale INTEGER NOT NULL DEFAULT 0, adopted_submission_id TEXT, adoption_token TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(requested_by,idempotency_key)
);
CREATE UNIQUE INDEX agent_bridge_one_active ON agent_bridge_handoffs(device_id)
 WHERE state IN ('claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
CREATE UNIQUE INDEX agent_bridge_one_task ON agent_bridge_handoffs(task_id)
 WHERE state IN ('checking','waiting_device','claimed','running','waiting_input','uploading','cancel_requested','dispatch_uncertain');
CREATE INDEX agent_bridge_queue ON agent_bridge_handoffs(device_id,state,created_at);
```

## `agent_bridge_scopes`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `device_id` | TEXT | 是 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 2 |
| `workspace_label` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `device_id` → `agent_bridge_devices.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_agent_bridge_scopes_1`：`device_id, project_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_bridge_scopes (
 device_id TEXT NOT NULL REFERENCES agent_bridge_devices(id) ON DELETE CASCADE,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 workspace_label TEXT, PRIMARY KEY(device_id,project_id)
);
```

## `agent_runs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `session_id` | TEXT | 否 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `capability` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `mode` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'running' | 否 |
| `inputs_json` | TEXT | 是 | '{}' | 否 |
| `output_json` | TEXT | 否 | 无 | 否 |
| `prompt_version` | TEXT | 是 | '' | 否 |
| `ai_config_version_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `adopted_at` | TEXT | 否 | 无 | 否 |
| `adoption_material_version_id` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `session_id` → `agent_sessions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_agent_runs_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_agent_runs_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  job_id TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'adopted')),
  inputs_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  prompt_version TEXT NOT NULL DEFAULT '',
  ai_config_version_id TEXT,
  created_at TEXT NOT NULL,
  adopted_at TEXT,
  adoption_material_version_id TEXT
);
CREATE INDEX idx_agent_runs_project ON agent_runs (project_id);
```

## `agent_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `capability` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | '' | 否 |
| `task_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_agent_sessions_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_agent_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN ('do', 'guide', 'review_only')),
  title TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES tasks(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_sessions_project ON agent_sessions (project_id);
```

## `agent_turns`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `session_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `role` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `payload_json` | TEXT | 是 | '{}' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `session_id` → `agent_sessions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_agent_turns_2`：`session_id, sequence`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_agent_turns_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  kind TEXT NOT NULL CHECK (kind IN ('instruction', 'answer', 'draft', 'question', 'review_result')),
  run_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (session_id, sequence)
);
```

## `ai_activity_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `code` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `progress_json` | TEXT | 否 | 无 | 否 |

外键：
- `target_id` → `ai_task_activities.target_id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `ai_activity_events_target`：`target_id, id`；唯一=0；来源=c；部分索引=0。

```sql
CREATE TABLE ai_activity_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 target_id TEXT NOT NULL REFERENCES ai_task_activities(target_id),
 code TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('started','completed','failed','resumed')),
 created_at TEXT NOT NULL,
 progress_json TEXT
);
CREATE INDEX ai_activity_events_target ON ai_activity_events(target_id,id);
```

## `ai_automatic_retries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `target_kind` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `next_attempt_at` | TEXT | 是 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `ai_automatic_retries_target`：`target_kind, target_id`；唯一=0；来源=c；部分索引=0。
- `ai_automatic_retries_due`：`status, next_attempt_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_automatic_retries_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_automatic_retries (
  id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('job','draft_preview')),
  target_id TEXT NOT NULL,
  draft_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK(status IN ('pending','dispatching','dispatched','exhausted','cancelled','complete')),
  next_attempt_at TEXT NOT NULL,
  lease_token TEXT,
  lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ai_automatic_retries_due ON ai_automatic_retries(status,next_attempt_at);
CREATE INDEX ai_automatic_retries_target ON ai_automatic_retries(target_kind,target_id);
```

## `ai_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 否 | 无 | 否 |
| `prompt_version` | TEXT | 是 | '' | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `input_r2_key` | TEXT | 否 | 无 | 否 |
| `output_r2_key` | TEXT | 否 | 无 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `status` | TEXT | 是 | 'ok' | 否 |
| `latency_ms` | INTEGER | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `reservation_id` | TEXT | 否 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `search_usage_json` | TEXT | 否 | 无 | 否 |
| `cached_tokens` | INTEGER | 否 | 无 | 否 |
| `cache_miss_tokens` | INTEGER | 否 | 无 | 否 |
| `context_metadata_json` | TEXT | 否 | 无 | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `reservation_id` → `usage_reservations.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `idx_ai_calls_job`：`job_id`；唯一=0；来源=c；部分索引=1。
- `idx_ai_calls_reservation`：`reservation_id`；唯一=0；来源=c；部分索引=0。
- `idx_ai_calls_project`：`project_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_calls_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_calls (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT,
  run_id TEXT,
  purpose TEXT NOT NULL CHECK (purpose IN ('textEconomy', 'visionEconomy', 'review')),
  config_version_id TEXT REFERENCES ai_config_versions(id),
  prompt_version TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  input_r2_key TEXT,
  output_r2_key TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK (cost_status IN ('known', 'unknown')),
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'repaired', 'invalid', 'failed', 'timeout')),
  latency_ms INTEGER,
  created_at TEXT NOT NULL
, reservation_id TEXT REFERENCES usage_reservations(id), draft_id TEXT REFERENCES project_creation_drafts(id), search_usage_json TEXT, cached_tokens INTEGER, cache_miss_tokens INTEGER, context_metadata_json TEXT);
CREATE INDEX idx_ai_calls_job ON ai_calls(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX idx_ai_calls_project ON ai_calls (project_id, created_at);
CREATE INDEX idx_ai_calls_reservation ON ai_calls(reservation_id);
```

## `ai_clarifications`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `attempt_id` | TEXT | 是 | 无 | 否 |
| `context_revision` | INTEGER | 否 | 无 | 否 |
| `tool_call_id` | TEXT | 是 | 无 | 否 |
| `question_json` | TEXT | 是 | 无 | 否 |
| `answer_json` | TEXT | 否 | 无 | 否 |
| `transition_token` | TEXT | 否 | 无 | 否 |
| `round` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `owner_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 3/0；MATCH NONE。

索引：
- `idx_ai_clarifications_one_pending`：`attempt_id`；唯一=1；来源=c；部分索引=1。
- `idx_ai_clarifications_draft`：`draft_id, attempt_id, created_at`；唯一=0；来源=c；部分索引=0。
- `idx_ai_clarifications_job`：`job_id, owner_id, status, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_clarifications_2`：`attempt_id, tool_call_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_ai_clarifications_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_clarifications (
 id TEXT PRIMARY KEY,
 project_id TEXT REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 draft_id TEXT REFERENCES project_creation_drafts(id),
 owner_id TEXT NOT NULL REFERENCES users(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER,
 tool_call_id TEXT NOT NULL,
 question_json TEXT NOT NULL,
 answer_json TEXT,
 transition_token TEXT,
 round INTEGER NOT NULL CHECK(round BETWEEN 1 AND 3),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((job_id IS NOT NULL AND project_id IS NOT NULL AND draft_id IS NULL) OR (draft_id IS NOT NULL AND job_id IS NULL AND project_id IS NULL)),
 UNIQUE(attempt_id,tool_call_id)
);
CREATE INDEX idx_ai_clarifications_draft ON ai_clarifications(draft_id,attempt_id,created_at);
CREATE INDEX idx_ai_clarifications_job ON ai_clarifications(job_id,owner_id,status,created_at);
CREATE UNIQUE INDEX idx_ai_clarifications_one_pending ON ai_clarifications(attempt_id) WHERE status='pending';
```

## `ai_config_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `version` | INTEGER | 是 | 无 | 否 |
| `config_json` | TEXT | 是 | 无 | 否 |
| `enabled` | INTEGER | 是 | 0 | 否 |
| `notes` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 'system' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_config_versions_2`：`version`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_ai_config_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_config_versions (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL
);
```

## `ai_diagnostic_retention`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `entry_count` | INTEGER | 是 | 无 | 否 |
| `byte_count` | INTEGER | 是 | 无 | 否 |

外键：
- 无。

索引：
- 无。

```sql
CREATE TABLE ai_diagnostic_retention (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  entry_count INTEGER NOT NULL CHECK (entry_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0)
);
```

## `ai_diagnostics`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `entry_json` | TEXT | 是 | 无 | 否 |
| `byte_size` | INTEGER | 是 | 无 | 否 |

外键：
- 无。

索引：
- 无。

```sql
CREATE TABLE ai_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_json TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size = length(CAST(entry_json AS BLOB)) + 1)
);
```

## `ai_execution_policy`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `version` | INTEGER | 是 | 1 | 否 |
| `max_model_calls` | INTEGER | 是 | 100 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_execution_policy_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_execution_policy (
 id TEXT PRIMARY KEY CHECK(id='global'),
 version INTEGER NOT NULL DEFAULT 1,
 max_model_calls INTEGER NOT NULL DEFAULT 100 CHECK(max_model_calls BETWEEN 1 AND 10000),
 updated_at TEXT NOT NULL
);
```

## `ai_execution_policy_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `max_model_calls` | INTEGER | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_execution_policy_audit_2`：`version`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_ai_execution_policy_audit_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_execution_policy_audit (
 id TEXT PRIMARY KEY, actor_id TEXT, version INTEGER NOT NULL UNIQUE,
 max_model_calls INTEGER NOT NULL, created_at TEXT NOT NULL
);
```

## `ai_execution_slices`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `job_id` | TEXT | 是 | 无 | 1 |
| `slice` | INTEGER | 是 | 无 | 2 |
| `instance_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `ai_execution_slices_pending`：`status, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_execution_slices_2`：`job_id, slice`；唯一=1；来源=pk；部分索引=0。
- `sqlite_autoindex_ai_execution_slices_1`：`instance_id`；唯一=1；来源=u；部分索引=0。

```sql
CREATE TABLE "ai_execution_slices" (
 job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
 slice INTEGER NOT NULL CHECK(slice >= 0),
 instance_id TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL CHECK(status IN ('pending','dispatched','running','continued','complete')),
 attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(job_id,slice)
);
CREATE INDEX ai_execution_slices_pending ON ai_execution_slices(status,updated_at);
```

## `ai_executions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `target_kind` | TEXT | 是 | 无 | 1 |
| `target_id` | TEXT | 是 | 无 | 2 |
| `draft_id` | TEXT | 否 | 无 | 否 |
| `generation` | INTEGER | 是 | 1 | 否 |
| `window_calls` | INTEGER | 是 | 0 | 否 |
| `total_calls` | INTEGER | 是 | 0 | 否 |
| `call_limit` | INTEGER | 是 | 无 | 否 |
| `state` | TEXT | 是 | 'running' | 否 |
| `pause_reason` | TEXT | 否 | 无 | 否 |
| `inflight_token` | TEXT | 否 | 无 | 否 |
| `inflight_generation` | INTEGER | 否 | 无 | 否 |
| `final_call_used` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `ai_executions_state`：`state, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_executions_1`：`target_kind, target_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_executions (
 target_kind TEXT NOT NULL CHECK(target_kind IN ('job','draft_preview')),
 target_id TEXT NOT NULL, draft_id TEXT,
 generation INTEGER NOT NULL DEFAULT 1,
 window_calls INTEGER NOT NULL DEFAULT 0 CHECK(window_calls>=0),
 total_calls INTEGER NOT NULL DEFAULT 0 CHECK(total_calls>=0),
 call_limit INTEGER NOT NULL CHECK(call_limit BETWEEN 1 AND 10000),
 state TEXT NOT NULL DEFAULT 'running' CHECK(state IN ('running','paused','finalizing','cancelled','completed')),
 pause_reason TEXT, inflight_token TEXT, inflight_generation INTEGER,
 final_call_used INTEGER NOT NULL DEFAULT 0 CHECK(final_call_used IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 PRIMARY KEY(target_kind,target_id)
);
CREATE INDEX ai_executions_state ON ai_executions(state,updated_at);
```

## `ai_investigations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `prompt_version` | TEXT | 是 | 无 | 否 |
| `checkpoint_key` | TEXT | 是 | 无 | 否 |
| `phase` | TEXT | 是 | 'read' | 否 |
| `step` | INTEGER | 是 | 0 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `idx_ai_investigations_job`：`job_id, prompt_version`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_investigations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_investigations (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id), requested_by TEXT NOT NULL REFERENCES users(id),
 prompt_version TEXT NOT NULL, checkpoint_key TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'read', step INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_ai_investigations_job ON ai_investigations(job_id,prompt_version);
```

## `ai_probes`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `config_version_id` | TEXT | 是 | 无 | 1 |
| `purpose` | TEXT | 是 | 无 | 2 |
| `passed` | INTEGER | 是 | 0 | 否 |
| `report_json` | TEXT | 是 | 无 | 否 |
| `tested_at` | TEXT | 是 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_ai_probes_1`：`config_version_id, purpose`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_probes (
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 purpose TEXT NOT NULL,
 passed INTEGER NOT NULL DEFAULT 0,
 report_json TEXT NOT NULL,
 tested_at TEXT NOT NULL,
 PRIMARY KEY (config_version_id, purpose)
);
```

## `ai_resource_daily`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `quota_day` | TEXT | 是 | 无 | 1 |
| `scope` | TEXT | 是 | 无 | 2 |
| `scope_id` | TEXT | 是 | 无 | 3 |
| `calls` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_resource_daily_1`：`quota_day, scope, scope_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_resource_daily (
  quota_day TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN('user','project','platform')),
  scope_id TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0),
  PRIMARY KEY(quota_day,scope,scope_id)
);
```

## `ai_resource_dispatches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `dispatch_key` | TEXT | 是 | 无 | 否 |
| `quota_day` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 否 | 无 | 否 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `operation` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 否 | 无 | 否 |
| `model` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `completed_at` | TEXT | 否 | 无 | 否 |

外键：
- 无。

索引：
- `idx_ai_resource_active`：`status, lease_until`；唯一=0；来源=c；部分索引=1。
- `sqlite_autoindex_ai_resource_dispatches_2`：`dispatch_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_ai_resource_dispatches_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_resource_dispatches (
  id TEXT PRIMARY KEY, dispatch_key TEXT NOT NULL UNIQUE, quota_day TEXT NOT NULL,
  user_id TEXT, project_id TEXT, operation TEXT NOT NULL, target_id TEXT, model TEXT,
  status TEXT NOT NULL CHECK(status IN('claimed','completed','uncertain','cancelled')),
  lease_until TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX idx_ai_resource_active ON ai_resource_dispatches(status,lease_until) WHERE status IN('claimed','uncertain');
```

## `ai_resource_release_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `dispatch_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_resource_release_audit_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_resource_release_audit (
  id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL
);
```

## `ai_task_activities`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `target_id` | TEXT | 否 | 无 | 1 |
| `code` | TEXT | 是 | 'preparing' | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `last_response_at` | TEXT | 否 | 无 | 否 |
| `progress_json` | TEXT | 否 | 无 | 否 |
| `uncertain` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ai_task_activities_1`：`target_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_task_activities (
 target_id TEXT PRIMARY KEY,
 code TEXT NOT NULL DEFAULT 'preparing',
 updated_at TEXT NOT NULL,
 last_response_at TEXT,
 progress_json TEXT,
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1))
);
```

## `ai_tool_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `args_json` | TEXT | 是 | 无 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `requested_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `idx_ai_tool_calls_job`：`project_id, job_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_ai_tool_calls_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ai_tool_calls (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 job_id TEXT REFERENCES jobs(id),
 requested_by TEXT NOT NULL REFERENCES users(id),
 name TEXT NOT NULL,
 args_json TEXT NOT NULL,
 result_json TEXT,
 status TEXT NOT NULL CHECK(status IN ('ok','failed')),
 created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_tool_calls_job ON ai_tool_calls(project_id,job_id,created_at,id);
```

## `app_config`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `key` | TEXT | 否 | 无 | 1 |
| `value_json` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_app_config_1`：`key`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE app_config (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## `assessment_corrections`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `assessment_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `previous_report_json` | TEXT | 否 | 无 | 否 |
| `report_json` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `assessment_id` → `assessments.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_assessment_corrections_2`：`assessment_id, revision`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_assessment_corrections_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE assessment_corrections (
 id TEXT PRIMARY KEY,
 assessment_id TEXT NOT NULL REFERENCES assessments(id),
 project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL,
 reason TEXT NOT NULL,
 previous_report_json TEXT,
 report_json TEXT NOT NULL,
 created_at TEXT NOT NULL,
 UNIQUE(assessment_id,revision)
);
```

## `assessment_followups`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `assessment_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `message` | TEXT | 是 | 无 | 否 |
| `base_revision` | INTEGER | 是 | 无 | 否 |
| `base_report_json` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'queued' | 否 |
| `proposed_report_json` | TEXT | 否 | 无 | 否 |
| `published_report_json` | TEXT | 否 | 无 | 否 |
| `published_revision` | INTEGER | 否 | 无 | 否 |
| `error_json` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `assessment_id` → `assessments.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `assessment_followups_job`：`job_id`；唯一=0；来源=c；部分索引=0。
- `assessment_followups_history`：`project_id, assessment_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_assessment_followups_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE assessment_followups (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_report_json TEXT NOT NULL,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','conflict')),
  proposed_report_json TEXT,
  published_report_json TEXT,
  published_revision INTEGER,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX assessment_followups_history ON assessment_followups(project_id,assessment_id,created_at DESC,id DESC);
CREATE INDEX assessment_followups_job ON assessment_followups(job_id);
```

## `assessments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `entity_id` | TEXT | 否 | 无 | 否 |
| `goal_revision` | INTEGER | 是 | 无 | 否 |
| `standards_version_id` | TEXT | 是 | 无 | 否 |
| `inputs_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `report_json` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `origin` | TEXT | 是 | 'ai' | 否 |
| `ai_report_json` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `standards_version_id` → `standards_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_assessments_project`：`project_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_assessments_2`：`entity_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_assessments_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE assessments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('material_review','rehearsal')), entity_id TEXT UNIQUE,
 goal_revision INTEGER NOT NULL, standards_version_id TEXT NOT NULL REFERENCES standards_versions(id),
 inputs_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','succeeded','failed')),
 report_json TEXT, job_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
, revision INTEGER NOT NULL DEFAULT 1, origin TEXT NOT NULL DEFAULT 'ai', ai_report_json TEXT);
CREATE INDEX idx_assessments_project ON assessments(project_id,created_at);
```

## `audio_pipeline`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `job_id` | TEXT | 否 | 无 | 1 |
| `phase` | TEXT | 是 | 'pending' | 否 |
| `transcript_r2_key` | TEXT | 否 | 无 | 否 |
| `quality_json` | TEXT | 是 | '[]' | 否 |
| `chunks_json` | TEXT | 是 | '[]' | 否 |
| `final_summary_json` | TEXT | 否 | 无 | 否 |
| `summaries_json` | TEXT | 是 | '[]' | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `fallback_config_version_id` | TEXT | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `fallback_config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `audio_pipeline_phase`：`phase, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_audio_pipeline_1`：`job_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE audio_pipeline (
 job_id TEXT PRIMARY KEY REFERENCES jobs(id),
 phase TEXT NOT NULL DEFAULT 'pending',
 transcript_r2_key TEXT,
 quality_json TEXT NOT NULL DEFAULT '[]',
 chunks_json TEXT NOT NULL DEFAULT '[]',
 final_summary_json TEXT,
 summaries_json TEXT NOT NULL DEFAULT '[]',
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 fallback_config_version_id TEXT REFERENCES ai_config_versions(id),
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX audio_pipeline_phase ON audio_pipeline(phase,updated_at);
```

## `audio_pipeline_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `stage` | TEXT | 是 | 无 | 否 |
| `block_index` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'started' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_audio_pipeline_calls_2`：`job_id, stage, block_index`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_audio_pipeline_calls_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE audio_pipeline_calls (
 id TEXT PRIMARY KEY,
 job_id TEXT NOT NULL REFERENCES jobs(id),
 stage TEXT NOT NULL,
 block_index INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','ok','invalid','unknown')),
 created_at TEXT NOT NULL,
 UNIQUE(job_id,stage,block_index)
);
```

## `auth_accounts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `username` | TEXT | 否 | 无 | 否 |
| `username_norm` | TEXT | 否 | 无 | 否 |
| `contact_email` | TEXT | 否 | 无 | 否 |
| `contact_email_norm` | TEXT | 否 | 无 | 否 |
| `email_verified` | INTEGER | 是 | 0 | 否 |
| `password_hash` | TEXT | 否 | 无 | 否 |
| `is_admin` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `account_role` | TEXT | 否 | 无 | 否 |
| `recovery_email_version` | INTEGER | 是 | 0 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_auth_accounts_3`：`contact_email_norm`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_auth_accounts_2`：`username_norm`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_auth_accounts_1`：`user_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_accounts (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  username TEXT,
  username_norm TEXT UNIQUE,
  contact_email TEXT,
  contact_email_norm TEXT UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created_at TEXT NOT NULL
, account_role TEXT CHECK (account_role IN ('super_admin', 'admin', 'user')), recovery_email_version INTEGER NOT NULL DEFAULT 0 CHECK (recovery_email_version >= 0));
```

## `auth_challenges`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `email` | TEXT | 是 | 无 | 否 |
| `code_hmac` | TEXT | 是 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `ip` | TEXT | 否 | 无 | 否 |
| `requested_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `consumed_at` | TEXT | 否 | 无 | 否 |

外键：
- 无。

索引：
- `idx_auth_challenges_email`：`email, requested_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_auth_challenges_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hmac TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX idx_auth_challenges_email ON auth_challenges (email, requested_at);
```

## `auth_email_daily_usage`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `day` | TEXT | 否 | 无 | 1 |
| `sends` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_auth_email_daily_usage_1`：`day`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_email_daily_usage (
  day TEXT PRIMARY KEY,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0)
);
```

## `auth_email_dispatches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `day` | TEXT | 是 | 无 | 否 |
| `recipient_hash` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `auth_email_dispatch_recipient`：`recipient_hash, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_auth_email_dispatches_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_email_dispatches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  day TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verification','recovery')),
  status TEXT NOT NULL CHECK (status IN ('reserved','sent','failed','unknown')),
  created_at TEXT NOT NULL
);
CREATE INDEX auth_email_dispatch_recipient ON auth_email_dispatches(recipient_hash,created_at);
```

## `auth_email_ip_attempts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ip_hash` | TEXT | 是 | 无 | 否 |
| `attempted_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `idx_auth_email_ip_attempts`：`ip_hash, attempted_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_auth_email_ip_attempts_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_email_ip_attempts (
  id TEXT PRIMARY KEY,
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX idx_auth_email_ip_attempts ON auth_email_ip_attempts(ip_hash, attempted_at);
```

## `auth_email_recipient_usage`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `day` | TEXT | 是 | 无 | 1 |
| `email_hash` | TEXT | 是 | 无 | 2 |
| `sends` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_auth_email_recipient_usage_1`：`day, email_hash`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_email_recipient_usage (
  day TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  sends INTEGER NOT NULL DEFAULT 0 CHECK (sends >= 0),
  PRIMARY KEY (day, email_hash)
);
```

## `auth_password_rate_limits`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `bucket_key` | TEXT | 否 | 无 | 1 |
| `attempts` | INTEGER | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_auth_password_rate_limits_1`：`bucket_key`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE auth_password_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);
```

## `collaboration_proposal_revisions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `proposal_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `proposal_id` → `collaboration_proposals.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_collaboration_proposal_revisions_2`：`proposal_id, revision`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_collaboration_proposal_revisions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE collaboration_proposal_revisions (
 id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES collaboration_proposals(id),
 project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL,
 payload_json TEXT NOT NULL, status TEXT NOT NULL, actor_id TEXT NOT NULL,
 reason TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(proposal_id,revision)
);
```

## `collaboration_proposals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `settings_revision` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `mutation_token` | TEXT | 否 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_collaboration_proposals`：`project_id, status, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_collaboration_proposals_2`：`job_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_collaboration_proposals_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE collaboration_proposals (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('decompose','assign')), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 payload_json TEXT NOT NULL, settings_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','stale')),
 revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, mutation_token TEXT);
CREATE INDEX idx_collaboration_proposals ON collaboration_proposals(project_id,status,created_at);
```

## `comments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_comments_target`：`target_type, target_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_comments_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  author_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_comments_target ON comments (target_type, target_id);
```

## `creation_draft_files`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `mime` | TEXT | 是 | 无 | 否 |
| `pages_json` | TEXT | 是 | '[]' | 否 |
| `text_error` | TEXT | 否 | 无 | 否 |
| `removed` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `idx_creation_draft_files_draft`：`draft_id, removed, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_creation_draft_files_2`：`r2_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_creation_draft_files_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE creation_draft_files (
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 r2_key TEXT NOT NULL UNIQUE,
 sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 mime TEXT NOT NULL,
 pages_json TEXT NOT NULL DEFAULT '[]',
 text_error TEXT,
 removed INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_creation_draft_files_draft ON creation_draft_files(draft_id,removed,created_at,id);
```

## `document_parse_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `batch_number` | INTEGER | 是 | 无 | 2 |
| `digest` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `document_parse_sessions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_document_parse_batches_1`：`session_id, batch_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE "document_parse_batches" (
 session_id TEXT NOT NULL REFERENCES "document_parse_sessions"(id), batch_number INTEGER NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(session_id,batch_number)
);
```

## `document_parse_pages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `page_number` | INTEGER | 是 | 无 | 2 |

外键：
- `session_id` → `document_parse_sessions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_document_parse_pages_1`：`session_id, page_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE "document_parse_pages" (
 session_id TEXT NOT NULL REFERENCES "document_parse_sessions"(id), page_number INTEGER NOT NULL,
 PRIMARY KEY(session_id,page_number)
);
```

## `document_parse_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `method` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'processing' | 否 |
| `next_batch` | INTEGER | 是 | 0 | 否 |
| `next_seq` | INTEGER | 是 | 1 | 否 |
| `warnings_json` | TEXT | 是 | '[]' | 否 |
| `total_pages` | INTEGER | 否 | 无 | 否 |
| `processed_pages` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `document_parse_active`：`source_version_id, lifecycle_version`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_document_parse_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE "document_parse_sessions" (
 id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL,
 method TEXT NOT NULL CHECK(method IN ('browser-pdf','browser-docx','browser-xlsx','browser-pptx')), status TEXT NOT NULL DEFAULT 'processing',
 next_batch INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1,
 warnings_json TEXT NOT NULL DEFAULT '[]', total_pages INTEGER, processed_pages INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX document_parse_active ON document_parse_sessions(source_version_id,lifecycle_version) WHERE status IN ('processing','finalizing');
```

## `draft_document_blocks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `heading_json` | TEXT | 是 | '[]' | 否 |

外键：
- `file_id` → `creation_draft_files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_draft_document_blocks_2`：`file_id, seq`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_draft_document_blocks_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_document_blocks(
 id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 file_id TEXT NOT NULL REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL,
 page_number INTEGER,
 content TEXT NOT NULL,
 heading_json TEXT NOT NULL DEFAULT '[]',
 UNIQUE(file_id,seq)
);
```

## `draft_document_imports`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `interrupted` | INTEGER | 是 | 0 | 否 |
| `status` | TEXT | 是 | 'importing' | 否 |
| `warnings_json` | TEXT | 是 | '[]' | 否 |

外键：
- `file_id` → `creation_draft_files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_draft_document_imports_1`：`file_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_document_imports(
 file_id TEXT PRIMARY KEY REFERENCES creation_draft_files(id) ON DELETE CASCADE,
 draft_id TEXT NOT NULL,
 revision INTEGER NOT NULL,
 interrupted INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'importing' CHECK(status IN ('importing','complete','partial')),
 warnings_json TEXT NOT NULL DEFAULT '[]'
);
```

## `draft_document_part_leases`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `lease_owner` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `file_id` → `draft_document_uploads.file_id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_draft_document_part_leases_1`：`file_id, part_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_document_part_leases(
 file_id TEXT NOT NULL REFERENCES draft_document_uploads(file_id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL,
 lease_owner TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
```

## `draft_document_parts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `etag` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |

外键：
- `file_id` → `draft_document_uploads.file_id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_draft_document_parts_1`：`file_id, part_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_document_parts(
 file_id TEXT NOT NULL REFERENCES draft_document_uploads(file_id) ON DELETE CASCADE,
 part_number INTEGER NOT NULL,
 etag TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 PRIMARY KEY(file_id,part_number)
);
```

## `draft_document_uploads`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `upload_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `name` | TEXT | 是 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `operation_token` | TEXT | 否 | 无 | 否 |
| `operation_expires_at` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'uploading' | 否 |

外键：
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_draft_document_uploads_1`：`file_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_document_uploads(
 file_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id) ON DELETE CASCADE,
 upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL,
 name TEXT NOT NULL,
 ext TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 revision INTEGER NOT NULL,
 operation_token TEXT,
 operation_expires_at TEXT,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing','aborting','complete','cancelled'))
);
```

## `draft_preview_dispatches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `instance_id` | TEXT | 否 | 无 | 1 |
| `draft_id` | TEXT | 是 | 无 | 否 |
| `attempt_id` | TEXT | 是 | 无 | 否 |
| `context_revision` | INTEGER | 是 | 无 | 否 |
| `question_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `question_id` → `ai_clarifications.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `draft_id` → `project_creation_drafts.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `idx_draft_preview_dispatches_pending`：`status, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_draft_preview_dispatches_1`：`instance_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE draft_preview_dispatches (
 instance_id TEXT PRIMARY KEY,
 draft_id TEXT NOT NULL REFERENCES project_creation_drafts(id),
 attempt_id TEXT NOT NULL,
 context_revision INTEGER NOT NULL,
 question_id TEXT REFERENCES ai_clarifications(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','cancelled')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX idx_draft_preview_dispatches_pending ON draft_preview_dispatches(status,updated_at);
```

## `events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_type` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | '' | 否 |
| `type` | TEXT | 是 | 无 | 否 |
| `entity_type` | TEXT | 是 | 无 | 否 |
| `entity_id` | TEXT | 是 | '' | 否 |
| `dedup_key` | TEXT | 是 | '' | 否 |
| `payload_json` | TEXT | 是 | '{}' | 否 |
| `occurred_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_events_project_time`：`project_id, occurred_at`；唯一=0；来源=c；部分索引=0。
- `uq_events_dedup`：`project_id, type, entity_type, entity_id, dedup_key`；唯一=1；来源=c；部分索引=0。
- `sqlite_autoindex_events_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'ai', 'system')),
  actor_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  dedup_key TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_events_project_time ON events (project_id, occurred_at);
CREATE UNIQUE INDEX uq_events_dedup ON events (project_id, type, entity_type, entity_id, dedup_key);
```

## `file_contributors`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 2 |
| `display_name` | TEXT | 是 | 无 | 否 |

外键：
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_file_contributors_1`：`file_id, user_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_contributors (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 display_name TEXT NOT NULL,
 PRIMARY KEY (file_id, user_id)
);
```

## `file_derivations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `parent_file_id` | TEXT | 是 | 无 | 否 |

外键：
- `parent_file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_file_derivations_1`：`file_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_derivations (
 file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE, parent_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE
);
```

## `file_processing`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 是 | 无 | 1 |
| `lifecycle_version` | INTEGER | 是 | 无 | 2 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `source_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `attempted` | INTEGER | 是 | 0 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `file_processing_project`：`project_id, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_file_processing_1`：`file_id, lifecycle_version`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_processing (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, lifecycle_version INTEGER NOT NULL,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, source_id TEXT NOT NULL,
 source_version_id TEXT NOT NULL, job_id TEXT, attempted INTEGER NOT NULL DEFAULT 0,
 error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(file_id,lifecycle_version)
);
CREATE INDEX file_processing_project ON file_processing(project_id,updated_at);
```

## `file_processing_materials`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `source_version_id` | TEXT | 是 | 无 | 1 |
| `material_id` | TEXT | 是 | 无 | 2 |
| `text_hash` | TEXT | 是 | 无 | 否 |
| `parent_material_id` | TEXT | 否 | 无 | 否 |

外键：
- `parent_material_id` → `materials.id`；ON UPDATE NO ACTION；ON DELETE SET NULL；复合关系 0/0；MATCH NONE。
- `material_id` → `materials.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_file_processing_materials_1`：`source_version_id, material_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_processing_materials (
 source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
 material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE, text_hash TEXT NOT NULL,
 parent_material_id TEXT REFERENCES materials(id) ON DELETE SET NULL,
 PRIMARY KEY(source_version_id,material_id)
);
```

## `file_upload_part_leases`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `lease_owner` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `file_upload_sessions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_file_upload_part_leases_1`：`session_id, part_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_upload_part_leases (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 lease_owner TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY(session_id,part_number)
);
```

## `file_upload_parts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `part_number` | INTEGER | 是 | 无 | 2 |
| `etag` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |

外键：
- `session_id` → `file_upload_sessions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_file_upload_parts_1`：`session_id, part_number`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_upload_parts (
 session_id TEXT NOT NULL REFERENCES file_upload_sessions(id), part_number INTEGER NOT NULL,
 etag TEXT NOT NULL, size_bytes INTEGER NOT NULL, PRIMARY KEY(session_id,part_number)
);
```

## `file_upload_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `upload_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `part_bytes` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'uploading' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `operation_token` | TEXT | 否 | 无 | 否 |
| `operation_expires_at` | TEXT | 否 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `file_upload_active`：`file_id, lifecycle_version`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_file_upload_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE file_upload_sessions (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), lifecycle_version INTEGER NOT NULL, upload_id TEXT NOT NULL,
 r2_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, part_bytes INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','completing','complete','aborting','aborted')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, operation_token TEXT, operation_expires_at TEXT);
CREATE UNIQUE INDEX file_upload_active ON file_upload_sessions(file_id,lifecycle_version) WHERE status IN ('uploading','completing','aborting');
```

## `files`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `uploader_user_id` | TEXT | 是 | 无 | 否 |
| `r2_key` | TEXT | 是 | 无 | 否 |
| `mime_declared` | TEXT | 否 | 无 | 否 |
| `mime_detected` | TEXT | 否 | 无 | 否 |
| `ext` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 否 | 无 | 否 |
| `sha256` | TEXT | 否 | 无 | 否 |
| `page_count` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `gc_after` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `original_name` | TEXT | 是 | '' | 否 |
| `deleted_at` | TEXT | 否 | 无 | 否 |
| `deleted_by` | TEXT | 否 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 1 | 否 |
| `lifecycle_change_id` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |
| `processing_purpose` | TEXT | 否 | 无 | 否 |

外键：
- `deleted_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `uploader_user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_files_recycle`：`project_id, deleted_at, created_at, id`；唯一=0；来源=c；部分索引=0。
- `idx_files_project_sha`：`project_id, sha256`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_files_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  uploader_user_id TEXT NOT NULL REFERENCES users(id),
  r2_key TEXT NOT NULL,
  mime_declared TEXT,
  mime_detected TEXT,
  ext TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'quarantined', 'discarded')),
  gc_after TEXT,
  created_at TEXT NOT NULL
, original_name TEXT NOT NULL DEFAULT '', deleted_at TEXT, deleted_by TEXT REFERENCES users(id), lifecycle_version INTEGER NOT NULL DEFAULT 1, lifecycle_change_id TEXT, archived_at TEXT, processing_purpose TEXT CHECK(processing_purpose IN ('background','reference','output')));
CREATE INDEX idx_files_project_sha ON files (project_id, sha256);
CREATE INDEX idx_files_recycle ON files(project_id, deleted_at, created_at, id);
```

## `idempotency_records`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `idempotency_key` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `operation` | TEXT | 是 | 无 | 否 |
| `request_hash` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'processing' | 否 |
| `response_status` | INTEGER | 否 | 无 | 否 |
| `response_body` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_idempotency_records_1`：`idempotency_key, user_id, operation`；唯一=1；来源=u；部分索引=0。

```sql
CREATE TABLE idempotency_records (
  idempotency_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'completed')),
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (idempotency_key, user_id, operation)
);
```

## `invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `code_hash` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `max_uses` | INTEGER | 否 | 无 | 否 |
| `used_count` | INTEGER | 是 | 0 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_invitations_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_invitations_2`：`code_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_invitations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_invitations_project ON invitations (project_id);
```

## `job_outbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `available_at` | TEXT | 是 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `last_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_outbox_status`：`status, available_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_job_outbox_2`：`job_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_job_outbox_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE job_outbox (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'done', 'failed')),
  available_at TEXT NOT NULL,
  lease_until TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_outbox_status ON job_outbox (status, available_at);
```

## `jobs`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'queued' | 否 |
| `input_json` | TEXT | 是 | '{}' | 否 |
| `input_r2_key` | TEXT | 否 | 无 | 否 |
| `result_json` | TEXT | 否 | 无 | 否 |
| `error_json` | TEXT | 否 | 无 | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_jobs_project_time`：`project_id, created_at`；唯一=0；来源=c；部分索引=0。
- `idx_jobs_status_lease`：`status, lease_until`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_jobs_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('parse_source', 'ocr_pages', 'requirement_extract', 'assignment_suggest', 'agent_run', 'review_run', 'rehearsal_turn', 'web_fetch', 'gc')),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
  input_json TEXT NOT NULL DEFAULT '{}',
  input_r2_key TEXT,
  result_json TEXT,
  error_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_jobs_project_time ON jobs (project_id, created_at);
CREATE INDEX idx_jobs_status_lease ON jobs (status, lease_until);
```

## `maintenance_cursors`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `name` | TEXT | 否 | 无 | 1 |
| `cursor_created_at` | TEXT | 否 | 无 | 否 |
| `cursor_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_maintenance_cursors_1`：`name`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE maintenance_cursors (
  name TEXT PRIMARY KEY,
  cursor_created_at TEXT,
  cursor_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);
```

## `material_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `material_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `doc_json` | TEXT | 是 | 无 | 否 |
| `markdown` | TEXT | 是 | '' | 否 |
| `origin` | TEXT | 是 | 无 | 否 |
| `ai_run_id` | TEXT | 否 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `attachments_json` | TEXT | 是 | '[]' | 否 |

外键：
- `author_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `material_id` → `materials.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_material_versions_2`：`material_id, revision`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_material_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE material_versions (
  id TEXT PRIMARY KEY,
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  markdown TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'ai_adoption')),
  ai_run_id TEXT,
  author_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE (material_id, revision)
);
```

## `materials`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 'document' | 否 |
| `current_version_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `purpose` | TEXT | 是 | 'output' | 否 |
| `is_default_background` | INTEGER | 是 | 0 | 否 |
| `system_managed` | INTEGER | 是 | 0 | 否 |
| `task_id` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_materials_task`：`project_id, task_id`；唯一=0；来源=c；部分索引=0。
- `uq_project_system_background`：`project_id`；唯一=1；来源=c；部分索引=1。
- `uq_project_default_background`：`project_id`；唯一=1；来源=c；部分索引=1。
- `idx_materials_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_materials_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'document',
  current_version_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, purpose TEXT NOT NULL DEFAULT 'output'
  CHECK (purpose IN ('background','reference','output')), is_default_background INTEGER NOT NULL DEFAULT 0 CHECK(is_default_background IN (0,1)), system_managed INTEGER NOT NULL DEFAULT 0 CHECK(system_managed IN (0,1)), task_id TEXT REFERENCES tasks(id), archived_at TEXT);
CREATE INDEX idx_materials_project ON materials (project_id);
CREATE INDEX idx_materials_task ON materials(project_id,task_id);
CREATE UNIQUE INDEX uq_project_default_background ON materials(project_id) WHERE is_default_background=1;
CREATE UNIQUE INDEX uq_project_system_background ON materials(project_id) WHERE system_managed=1;
```

## `media_calls`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `window_start` | REAL | 是 | 无 | 否 |
| `window_end` | REAL | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `provider` | TEXT | 是 | 'gemini' | 否 |
| `cached_tokens` | INTEGER | 否 | 无 | 否 |
| `audio_tokens` | INTEGER | 否 | 无 | 否 |
| `video_tokens` | INTEGER | 否 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_media_calls_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE media_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  model TEXT NOT NULL,
  window_start REAL NOT NULL,
  window_end REAL,
  status TEXT NOT NULL CHECK(status IN ('started','ok','failed','unknown')),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd REAL,
  cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status IN ('known','unknown')),
  created_at TEXT NOT NULL
, provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo')), cached_tokens INTEGER, audio_tokens INTEGER, video_tokens INTEGER);
```

## `media_processing`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 否 | 无 | 否 |
| `draft_file_id` | TEXT | 否 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `stage` | TEXT | 是 | 'pending' | 否 |
| `provider_name` | TEXT | 否 | 无 | 否 |
| `provider_uri` | TEXT | 否 | 无 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `windows_json` | TEXT | 是 | '[]' | 否 |
| `summary_json` | TEXT | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_expires_at` | TEXT | 否 | 无 | 否 |
| `cleanup_pending` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `provider` | TEXT | 是 | 'gemini' | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `draft_file_id` → `creation_draft_files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 3/0；MATCH NONE。

索引：
- `media_cleanup`：`cleanup_pending, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_media_processing_2`：`job_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_media_processing_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE media_processing (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
  source_version_id TEXT REFERENCES source_versions(id),
  draft_file_id TEXT REFERENCES creation_draft_files(id),
  config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
  stage TEXT NOT NULL DEFAULT 'pending' CHECK(stage IN ('pending','uploading','processing','generating','ready','failed')),
  provider_name TEXT,
  provider_uri TEXT,
  duration_seconds REAL,
  windows_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT,
  error TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  cleanup_pending INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'gemini' CHECK(provider IN ('gemini','mimo')),
  CHECK ((source_version_id IS NULL) != (draft_file_id IS NULL))
);
CREATE INDEX media_cleanup ON media_processing(cleanup_pending,updated_at);
```

## `native_auth_transactions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `code_challenge` | TEXT | 是 | 无 | 否 |
| `client_state` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `approved_session_hash` | TEXT | 否 | 无 | 否 |
| `code_hash` | TEXT | 否 | 无 | 否 |
| `consumed_at` | TEXT | 否 | 无 | 否 |
| `client_type` | TEXT | 是 | 'android' | 否 |

外键：
- 无。

索引：
- `idx_native_auth_transactions_expiry`：`expires_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_native_auth_transactions_2`：`code_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_native_auth_transactions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE native_auth_transactions (
  id TEXT PRIMARY KEY,
  code_challenge TEXT NOT NULL,
  client_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  approved_session_hash TEXT,
  code_hash TEXT UNIQUE,
  consumed_at TEXT
, client_type TEXT NOT NULL DEFAULT 'android'
  CHECK (client_type IN ('android', 'windows')));
CREATE INDEX idx_native_auth_transactions_expiry ON native_auth_transactions(expires_at);
```

## `notification_events`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `event_key` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `scope` | TEXT | 是 | 无 | 否 |
| `resource_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `url` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `notification_events_created`：`created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_notification_events_2`：`event_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_notification_events_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('project','ticket')),
  resource_id TEXT NOT NULL,
  actor_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX notification_events_created ON notification_events(created_at DESC,id DESC);
```

## `notification_inbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `event_id` | TEXT | 是 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 2 |
| `read_at` | TEXT | 否 | 无 | 否 |
| `dismissed_at` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `event_id` → `notification_events.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `notification_inbox_user`：`user_id, event_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_notification_inbox_1`：`event_id, user_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE notification_inbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  read_at TEXT,
  dismissed_at TEXT,
  PRIMARY KEY (event_id,user_id)
);
CREATE INDEX notification_inbox_user ON notification_inbox(user_id,event_id);
```

## `notification_push_outbox`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `event_id` | TEXT | 是 | 无 | 1 |
| `subscription_id` | TEXT | 是 | 无 | 2 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `attempts` | INTEGER | 是 | 0 | 否 |
| `available_at` | TEXT | 是 | 无 | 否 |
| `lease_until` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `subscription_id` → `push_subscriptions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `event_id` → `notification_events.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `notification_push_due`：`status, available_at, lease_until`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_notification_push_outbox_1`：`event_id, subscription_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE notification_push_outbox (
  event_id TEXT NOT NULL REFERENCES notification_events(id),
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(event_id,subscription_id)
);
CREATE INDEX notification_push_due ON notification_push_outbox(status,available_at,lease_until);
```

## `notification_settings`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `in_app_enabled` | INTEGER | 是 | 1 | 否 |
| `push_enabled` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_notification_settings_1`：`user_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE notification_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  in_app_enabled INTEGER NOT NULL DEFAULT 1 CHECK (in_app_enabled IN (0,1)),
  push_enabled INTEGER NOT NULL DEFAULT 1 CHECK (push_enabled IN (0,1)),
  updated_at TEXT NOT NULL
);
```

## `ocr_model_capabilities`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `endpoint_model_hash` | TEXT | 否 | 无 | 1 |
| `single_image_only` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_ocr_model_capabilities_1`：`endpoint_model_hash`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE ocr_model_capabilities (
  endpoint_model_hash TEXT PRIMARY KEY,
  single_image_only INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
```

## `password_recovery_tokens`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `token_hash` | TEXT | 是 | 无 | 否 |
| `password_fingerprint` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `used_at` | TEXT | 否 | 无 | 否 |
| `claim_id` | TEXT | 否 | 无 | 否 |
| `issuance_source` | TEXT | 是 | 'admin' | 否 |
| `email_fingerprint` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `password_recovery_user`：`user_id, expires_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_password_recovery_tokens_2`：`token_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_password_recovery_tokens_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE password_recovery_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  password_fingerprint TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  claim_id TEXT
, issuance_source TEXT NOT NULL DEFAULT 'admin' CHECK (issuance_source IN ('admin','email')), email_fingerprint TEXT);
CREATE INDEX password_recovery_user ON password_recovery_tokens(user_id, expires_at);
```

## `personal_profile_import_candidates`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `source_project_id` | TEXT | 是 | 无 | 否 |
| `source_project_name` | TEXT | 是 | 无 | 否 |
| `major` | TEXT | 是 | 无 | 否 |
| `skills_json` | TEXT | 是 | 无 | 否 |
| `hours_per_week` | REAL | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `imported_at` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_profile_import_owner`：`user_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_personal_profile_import_candidates_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE personal_profile_import_candidates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_project_id TEXT NOT NULL,
  source_project_name TEXT NOT NULL,
  major TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  hours_per_week REAL,
  created_at TEXT NOT NULL,
  imported_at TEXT
);
CREATE INDEX idx_profile_import_owner ON personal_profile_import_candidates(user_id,created_at,id);
```

## `personal_profiles`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `user_id` | TEXT | 否 | 无 | 1 |
| `searchable` | INTEGER | 是 | 0 | 否 |
| `bio` | TEXT | 是 | '' | 否 |
| `major` | TEXT | 是 | '' | 否 |
| `specialties` | TEXT | 是 | '' | 否 |
| `preferred_roles` | TEXT | 是 | '' | 否 |
| `bio_public` | INTEGER | 是 | 0 | 否 |
| `major_public` | INTEGER | 是 | 0 | 否 |
| `specialties_public` | INTEGER | 是 | 0 | 否 |
| `preferred_roles_public` | INTEGER | 是 | 0 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `ai_use_allowed` | INTEGER | 是 | 0 | 否 |
| `weekly_available_hours` | REAL | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_personal_profiles_1`：`user_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE personal_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  searchable INTEGER NOT NULL DEFAULT 0 CHECK(searchable IN (0,1)),
  bio TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  preferred_roles TEXT NOT NULL DEFAULT '',
  bio_public INTEGER NOT NULL DEFAULT 0 CHECK(bio_public IN (0,1)),
  major_public INTEGER NOT NULL DEFAULT 0 CHECK(major_public IN (0,1)),
  specialties_public INTEGER NOT NULL DEFAULT 0 CHECK(specialties_public IN (0,1)),
  preferred_roles_public INTEGER NOT NULL DEFAULT 0 CHECK(preferred_roles_public IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
, ai_use_allowed INTEGER NOT NULL DEFAULT 0 CHECK(ai_use_allowed IN (0,1)), weekly_available_hours REAL
  CHECK (weekly_available_hours IS NULL OR (weekly_available_hours >= 0 AND weekly_available_hours <= 168)));
```

## `project_admin_feedback`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `target_type` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 否 | 无 | 否 |
| `feedback` | TEXT | 是 | 无 | 否 |
| `request_ai_redo` | INTEGER | 是 | 0 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `idx_project_admin_feedback_project`：`project_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_project_admin_feedback_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_admin_feedback (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 actor_id TEXT NOT NULL REFERENCES users(id), target_type TEXT NOT NULL,
 target_id TEXT, feedback TEXT NOT NULL, request_ai_redo INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX idx_project_admin_feedback_project ON project_admin_feedback(project_id,created_at);
```

## `project_ai_chat_context_cleanup`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `object_key` | TEXT | 否 | 无 | 1 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_project_ai_chat_context_cleanup_1`：`object_key`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_ai_chat_context_cleanup (
 object_key TEXT PRIMARY KEY,created_at TEXT NOT NULL
);
```

## `project_ai_chat_messages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `question_id` | TEXT | 是 | 无 | 否 |
| `role` | TEXT | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `references_json` | TEXT | 是 | '[]' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `question_id` → `project_ai_chat_questions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_ai_chat_messages_1`：`question_id, role`；唯一=1；来源=u；部分索引=0。

```sql
CREATE TABLE project_ai_chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL REFERENCES project_ai_chat_questions(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,references_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
 UNIQUE(question_id,role)
);
```

## `project_ai_chat_operations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `question_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `operation_key` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `label` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `href` | TEXT | 否 | 无 | 否 |
| `detail` | TEXT | 否 | 无 | 否 |
| `attempt` | INTEGER | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `question_id` → `project_ai_chat_questions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_ai_chat_operations_1`：`job_id, operation_key`；唯一=1；来源=u；部分索引=0。

```sql
CREATE TABLE project_ai_chat_operations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,question_id TEXT NOT NULL REFERENCES project_ai_chat_questions(id) ON DELETE CASCADE,
 job_id TEXT NOT NULL, operation_key TEXT NOT NULL,kind TEXT NOT NULL,label TEXT NOT NULL,status TEXT NOT NULL,
 href TEXT,detail TEXT,attempt INTEGER NOT NULL,created_at TEXT NOT NULL, UNIQUE(job_id,operation_key)
);
```

## `project_ai_chat_questions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `session_id` | TEXT | 是 | 无 | 否 |
| `generation` | INTEGER | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `context_stamp` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `project_ai_chat_sessions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `project_ai_chat_questions_session`：`session_id, generation, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_project_ai_chat_questions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_ai_chat_questions (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES project_ai_chat_sessions(id), generation INTEGER NOT NULL,
 project_id TEXT NOT NULL, user_id TEXT NOT NULL, content TEXT NOT NULL, job_id TEXT NOT NULL,
 context_stamp TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX project_ai_chat_questions_session ON project_ai_chat_questions(session_id,generation,created_at,id);
```

## `project_ai_chat_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `generation` | INTEGER | 是 | 1 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_ai_chat_sessions_2`：`project_id, user_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_project_ai_chat_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_ai_chat_sessions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
 generation INTEGER NOT NULL DEFAULT 1, job_id TEXT, updated_at TEXT NOT NULL,
 UNIQUE(project_id,user_id)
);
```

## `project_creation_drafts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `payload_json` | TEXT | 是 | 无 | 否 |
| `preview_json` | TEXT | 否 | 无 | 否 |
| `preview_revision` | INTEGER | 否 | 无 | 否 |
| `preview_state` | TEXT | 是 | 'none' | 否 |
| `preview_attempt_id` | TEXT | 否 | 无 | 否 |
| `preview_error` | TEXT | 否 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `commit_token` | TEXT | 否 | 无 | 否 |
| `result_encrypted` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `preview_waiting_id` | TEXT | 否 | 无 | 否 |
| `preview_config_version_id` | TEXT | 否 | 无 | 否 |

外键：
- `preview_config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `owner_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `idx_creation_drafts_owner`：`owner_id, updated_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_project_creation_drafts_2`：`project_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_project_creation_drafts_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_creation_drafts (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','committed')),
 revision INTEGER NOT NULL DEFAULT 1,
 payload_json TEXT NOT NULL,
 preview_json TEXT,
 preview_revision INTEGER,
 preview_state TEXT NOT NULL DEFAULT 'none' CHECK(preview_state IN ('none','running','ready','failed')),
 preview_attempt_id TEXT,
 preview_error TEXT,
 project_id TEXT NOT NULL UNIQUE,
 commit_token TEXT,
 result_encrypted TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
, preview_waiting_id TEXT, preview_config_version_id TEXT REFERENCES ai_config_versions(id));
CREATE INDEX idx_creation_drafts_owner ON project_creation_drafts(owner_id,updated_at);
```

## `project_feedback_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `feedback` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_feedback_versions_2`：`project_id, version`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_project_feedback_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_feedback_versions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 feedback TEXT NOT NULL,
 actor_id TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,
 UNIQUE(project_id,version)
);
```

## `project_goals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 否 | 无 | 1 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `graph_revision` | INTEGER | 是 | 1 | 否 |
| `graph_token` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_goals_1`：`project_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_goals (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 revision INTEGER NOT NULL DEFAULT 1, graph_revision INTEGER NOT NULL DEFAULT 1,
 graph_token TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

## `project_invitation_requests`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `requested_by` | TEXT | 是 | 无 | 否 |
| `username` | TEXT | 是 | 无 | 否 |
| `expires_in_days` | INTEGER | 是 | 7 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `decided_by` | TEXT | 否 | 无 | 否 |
| `invitation_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `decided_at` | TEXT | 否 | 无 | 否 |

外键：
- `decided_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `requested_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `invitation_request_pending`：`project_id, requested_by, username`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_project_invitation_requests_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_invitation_requests(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),requested_by TEXT NOT NULL REFERENCES users(id),username TEXT NOT NULL,expires_in_days INTEGER NOT NULL DEFAULT 7,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),revision INTEGER NOT NULL DEFAULT 1,decided_by TEXT REFERENCES users(id),invitation_id TEXT,created_at TEXT NOT NULL,decided_at TEXT);
CREATE UNIQUE INDEX invitation_request_pending ON project_invitation_requests(project_id,requested_by,username) WHERE status='pending';
```

## `project_members`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `role` | TEXT | 是 | 无 | 否 |
| `skills_json` | TEXT | 是 | '[]' | 否 |
| `hours_per_week` | REAL | 否 | 无 | 否 |
| `joined_at` | TEXT | 是 | 无 | 否 |
| `major` | TEXT | 是 | '' | 否 |
| `permissions_json` | TEXT | 是 | '{"teamManage":false,"taskManage":false,"resourceManage":false,"scoreInitiate":true}' | 否 |
| `permissions_revision` | INTEGER | 是 | 1 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `uq_project_members`：`project_id, user_id`；唯一=1；来源=c；部分索引=0。
- `sqlite_autoindex_project_members_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  skills_json TEXT NOT NULL DEFAULT '[]',
  hours_per_week REAL,
  joined_at TEXT NOT NULL
, major TEXT NOT NULL DEFAULT '', permissions_json TEXT NOT NULL DEFAULT '{"teamManage":false,"taskManage":false,"resourceManage":false,"scoreInitiate":true}' CHECK(json_valid(permissions_json)), permissions_revision INTEGER NOT NULL DEFAULT 1);
CREATE UNIQUE INDEX uq_project_members ON project_members (project_id, user_id);
```

## `project_progression`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 否 | 无 | 1 |
| `observed_event_at` | TEXT | 是 | '' | 否 |
| `observed_event_id` | TEXT | 是 | '' | 否 |
| `pending_job_id` | TEXT | 否 | 无 | 否 |
| `pending_event_at` | TEXT | 否 | 无 | 否 |
| `pending_event_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_project_progression_1`：`project_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_progression (
 project_id TEXT PRIMARY KEY REFERENCES projects(id),
 observed_event_at TEXT NOT NULL DEFAULT '',
 observed_event_id TEXT NOT NULL DEFAULT '',
 pending_job_id TEXT,
 pending_event_at TEXT, pending_event_id TEXT,
 updated_at TEXT NOT NULL
);
```

## `project_username_invitations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `recipient_id` | TEXT | 是 | 无 | 否 |
| `username` | TEXT | 是 | 无 | 否 |
| `invited_by` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `handled_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `invited_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `recipient_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。

索引：
- `idx_username_invite_recipient`：`recipient_id, created_at`；唯一=0；来源=c；部分索引=0。
- `idx_pending_username_invite`：`project_id, recipient_id`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_project_username_invitations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE project_username_invitations (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 recipient_id TEXT NOT NULL REFERENCES users(id),
 username TEXT NOT NULL,
 invited_by TEXT NOT NULL REFERENCES users(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','revoked','expired')),
 expires_at TEXT NOT NULL,
 handled_at TEXT,
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pending_username_invite ON project_username_invitations(project_id,recipient_id) WHERE status='pending';
CREATE INDEX idx_username_invite_recipient ON project_username_invitations(recipient_id,created_at);
```

## `projects`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `name` | TEXT | 是 | 无 | 否 |
| `description` | TEXT | 是 | '' | 否 |
| `competition_deadline_date` | TEXT | 否 | 无 | 否 |
| `deadline_precision` | TEXT | 是 | 'unknown' | 否 |
| `team_size_limit` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `ai_budget_usd` | REAL | 否 | 无 | 否 |
| `assignment_mode` | TEXT | 是 | 'manual' | 否 |
| `evaluation_mode` | TEXT | 是 | 'manual' | 否 |
| `collaboration_revision` | INTEGER | 是 | 1 | 否 |
| `collaboration_mutation_token` | TEXT | 否 | 无 | 否 |
| `ai_collaboration_enabled` | INTEGER | 是 | 0 | 否 |
| `planning_mode` | TEXT | 是 | 'manual' | 否 |
| `progression_mode` | TEXT | 是 | 'manual' | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_projects_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  competition_deadline_date TEXT,
  deadline_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (deadline_precision IN ('date', 'datetime', 'unknown')),
  team_size_limit INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, ai_budget_usd REAL, assignment_mode TEXT NOT NULL DEFAULT 'manual' CHECK (assignment_mode IN ('manual','automatic')), evaluation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (evaluation_mode IN ('manual','automatic')), collaboration_revision INTEGER NOT NULL DEFAULT 1, collaboration_mutation_token TEXT, ai_collaboration_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ai_collaboration_enabled IN (0,1)), planning_mode TEXT NOT NULL DEFAULT 'manual' CHECK(planning_mode IN ('manual','automatic')), progression_mode TEXT NOT NULL DEFAULT 'manual' CHECK(progression_mode IN ('manual','automatic')));
```

## `push_subscriptions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `session_hash` | TEXT | 是 | 无 | 否 |
| `endpoint` | TEXT | 是 | 无 | 否 |
| `p256dh` | TEXT | 是 | 无 | 否 |
| `auth` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `disabled_at` | TEXT | 否 | 无 | 否 |
| `disabled_reason` | TEXT | 否 | 无 | 否 |
| `transport` | TEXT | 是 | 'webpush' | 否 |
| `installation_id` | TEXT | 否 | 无 | 否 |
| `native_token` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `push_native_token`：`native_token`；唯一=0；来源=c；部分索引=1。
- `push_native_installation`：`user_id, installation_id`；唯一=1；来源=c；部分索引=1。
- `push_subscriptions_user`：`user_id, disabled_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_push_subscriptions_2`：`endpoint`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_push_subscriptions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  disabled_reason TEXT
, transport TEXT NOT NULL DEFAULT 'webpush' CHECK(transport IN ('webpush','fcm')), installation_id TEXT, native_token TEXT);
CREATE UNIQUE INDEX push_native_installation ON push_subscriptions(user_id,installation_id) WHERE transport='fcm';
CREATE INDEX push_native_token ON push_subscriptions(native_token) WHERE transport='fcm';
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id,disabled_at);
```

## `recording_segments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `sequence` | INTEGER | 是 | 无 | 2 |
| `file_id` | TEXT | 是 | 无 | 否 |
| `source_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `start_ms` | INTEGER | 是 | 无 | 否 |
| `end_ms` | INTEGER | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `interruptions_json` | TEXT | 是 | '[]' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `source_id` → `sources.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `session_id` → `recording_sessions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `idx_recording_source`：`source_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_recording_segments_2`：`session_id, file_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_recording_segments_1`：`session_id, sequence`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE recording_segments (
 session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>=1), file_id TEXT NOT NULL REFERENCES files(id),
 source_id TEXT NOT NULL REFERENCES sources(id), source_version_id TEXT NOT NULL REFERENCES source_versions(id),
 start_ms INTEGER NOT NULL CHECK(start_ms>=0),end_ms INTEGER NOT NULL CHECK(end_ms>=start_ms),
 sha256 TEXT NOT NULL,interruptions_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
 PRIMARY KEY(session_id,sequence),UNIQUE(session_id,file_id)
);
CREATE INDEX idx_recording_source ON recording_segments(source_id);
```

## `recording_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `client_session_id` | TEXT | 是 | 无 | 否 |
| `material_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'uploading' | 否 |
| `processing_status` | TEXT | 是 | 'pending' | 否 |
| `contributor_ids_json` | TEXT | 是 | '[]' | 否 |
| `interruptions_json` | TEXT | 是 | '[]' | 否 |
| `segment_count` | INTEGER | 是 | 0 | 否 |
| `summary_revision` | INTEGER | 是 | 0 | 否 |
| `summary_job_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `material_id` → `materials.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_recordings_project`：`project_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_recording_sessions_3`：`project_id, created_by, client_session_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_recording_sessions_2`：`material_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_recording_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE recording_sessions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 created_by TEXT NOT NULL REFERENCES users(id), client_session_id TEXT NOT NULL,
 material_id TEXT NOT NULL UNIQUE REFERENCES materials(id) ON DELETE CASCADE,
 title TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('audio','video','photo')),
 status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','complete')),
 processing_status TEXT NOT NULL DEFAULT 'pending', contributor_ids_json TEXT NOT NULL DEFAULT '[]',
 interruptions_json TEXT NOT NULL DEFAULT '[]', segment_count INTEGER NOT NULL DEFAULT 0,
 summary_revision INTEGER NOT NULL DEFAULT 0, summary_job_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(project_id,created_by,client_session_id)
);
CREATE INDEX idx_recordings_project ON recording_sessions(project_id,created_at,id);
```

## `recording_summary_nodes`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `session_id` | TEXT | 是 | 无 | 1 |
| `revision` | INTEGER | 是 | 无 | 2 |
| `level` | INTEGER | 是 | 无 | 3 |
| `node_index` | INTEGER | 是 | 无 | 4 |
| `summary` | TEXT | 是 | 无 | 否 |
| `citations_json` | TEXT | 是 | 无 | 否 |
| `snapshot_json` | TEXT | 是 | 无 | 否 |

外键：
- `session_id` → `recording_sessions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_recording_summary_nodes_1`：`session_id, revision, level, node_index`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE recording_summary_nodes (
 session_id TEXT NOT NULL REFERENCES recording_sessions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, level INTEGER NOT NULL, node_index INTEGER NOT NULL,
 summary TEXT NOT NULL, citations_json TEXT NOT NULL, snapshot_json TEXT NOT NULL,
 PRIMARY KEY(session_id,revision,level,node_index)
);
```

## `recovery_email_verifications`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `token_hash` | TEXT | 是 | 无 | 否 |
| `pending_email` | TEXT | 是 | 无 | 否 |
| `password_fingerprint` | TEXT | 是 | 无 | 否 |
| `email_fingerprint` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `used_at` | TEXT | 否 | 无 | 否 |
| `claim_id` | TEXT | 否 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `recovery_email_verification_user`：`user_id, expires_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_recovery_email_verifications_2`：`token_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_recovery_email_verifications_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE recovery_email_verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  pending_email TEXT NOT NULL,
  password_fingerprint TEXT NOT NULL,
  email_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  claim_id TEXT
);
CREATE INDEX recovery_email_verification_user ON recovery_email_verifications(user_id,expires_at);
```

## `rehearsal_speech`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `turn_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `content_hash` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `voice` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `lease_token` | TEXT | 否 | 无 | 否 |
| `lease_expires_at` | TEXT | 否 | 无 | 否 |
| `dispatched_at` | TEXT | 否 | 无 | 否 |
| `r2_key` | TEXT | 否 | 无 | 否 |
| `mime` | TEXT | 否 | 无 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `turn_id` → `rehearsal_turns.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `rehearsal_id` → `rehearsals.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 3/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 4/0；MATCH NONE。

索引：
- `rehearsal_speech_job`：`job_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_rehearsal_speech_2`：`turn_id, content_hash, config_version_id, model, voice`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_rehearsal_speech_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE rehearsal_speech (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id),
 rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id),
 turn_id TEXT NOT NULL REFERENCES rehearsal_turns(id),
 sequence INTEGER NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id),
 content_hash TEXT NOT NULL,
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 model TEXT NOT NULL,
 voice TEXT NOT NULL,
 -- Mutable retry pointer. A row is inserted before its job/outbox batch.
 job_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 lease_token TEXT,
 lease_expires_at TEXT,
 dispatched_at TEXT,
 r2_key TEXT,
 mime TEXT,
 duration_seconds REAL,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(turn_id,content_hash,config_version_id,model,voice)
);
CREATE INDEX rehearsal_speech_job ON rehearsal_speech(job_id);
```

## `rehearsal_turns`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `sequence` | INTEGER | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `content_json` | TEXT | 是 | '{}' | 否 |
| `run_id` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 否 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `rehearsal_id` → `rehearsals.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_rehearsal_turns_2`：`rehearsal_id, sequence`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_rehearsal_turns_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE rehearsal_turns (
  id TEXT PRIMARY KEY,
  rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'answer', 'followup', 'summary')),
  content_json TEXT NOT NULL DEFAULT '{}',
  run_id TEXT,
  created_at TEXT NOT NULL, author_id TEXT REFERENCES users(id),
  UNIQUE (rehearsal_id, sequence)
);
```

## `rehearsal_voice_sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `rehearsal_id` | TEXT | 是 | 无 | 否 |
| `question_sequence` | INTEGER | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `config_version_id` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `cost_status` | TEXT | 是 | 'unknown' | 否 |
| `cost_usd` | REAL | 否 | 无 | 否 |
| `root_session_id` | TEXT | 是 | 无 | 否 |
| `retry_number` | INTEGER | 是 | 0 | 否 |
| `transcript_text` | TEXT | 是 | '' | 否 |
| `audio_bytes` | INTEGER | 是 | 0 | 否 |
| `audio_frames` | INTEGER | 是 | 0 | 否 |
| `event_sequence` | INTEGER | 是 | 0 | 否 |
| `duration_seconds` | REAL | 否 | 无 | 否 |
| `started_at` | TEXT | 否 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |
| `error_code` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `rehearsal_id` → `rehearsal_turns.rehearsal_id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `question_sequence` → `rehearsal_turns.sequence`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/1；MATCH NONE。
- `config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `actor_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `rehearsal_id` → `rehearsals.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 4/0；MATCH NONE。

索引：
- `rehearsal_voice_retry_number`：`root_session_id, retry_number`；唯一=1；来源=c；部分索引=0。
- `rehearsal_voice_expiry`：`status, expires_at`；唯一=0；来源=c；部分索引=0。
- `rehearsal_voice_active`：`rehearsal_id`；唯一=1；来源=c；部分索引=1。
- `sqlite_autoindex_rehearsal_voice_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE rehearsal_voice_sessions (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 rehearsal_id TEXT NOT NULL REFERENCES rehearsals(id) ON DELETE CASCADE,
 question_sequence INTEGER NOT NULL,
 actor_id TEXT NOT NULL REFERENCES users(id),
 config_version_id TEXT NOT NULL REFERENCES ai_config_versions(id),
 model TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','connecting','open','succeeded','failed','closed','expired')),
 cost_status TEXT NOT NULL DEFAULT 'unknown' CHECK(cost_status='unknown'),
 cost_usd REAL,
 root_session_id TEXT NOT NULL,
 retry_number INTEGER NOT NULL DEFAULT 0 CHECK(retry_number BETWEEN 0 AND 3),
 transcript_text TEXT NOT NULL DEFAULT '',
 audio_bytes INTEGER NOT NULL DEFAULT 0,
 audio_frames INTEGER NOT NULL DEFAULT 0,
 event_sequence INTEGER NOT NULL DEFAULT 0,
 duration_seconds REAL,
 started_at TEXT,
 expires_at TEXT NOT NULL,
 finished_at TEXT,
 error_code TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(rehearsal_id,question_sequence) REFERENCES rehearsal_turns(rehearsal_id,sequence),
 CHECK(cost_usd IS NULL)
);
CREATE UNIQUE INDEX rehearsal_voice_active ON rehearsal_voice_sessions(rehearsal_id) WHERE status IN ('reserved','connecting','open');
CREATE INDEX rehearsal_voice_expiry ON rehearsal_voice_sessions(status,expires_at);
CREATE UNIQUE INDEX rehearsal_voice_retry_number ON rehearsal_voice_sessions(root_session_id,retry_number);
```

## `rehearsals`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `scope` | TEXT | 是 | 无 | 否 |
| `member_id` | TEXT | 否 | 无 | 否 |
| `material_version_ids_json` | TEXT | 是 | '[]' | 否 |
| `status` | TEXT | 是 | 'active' | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `finished_at` | TEXT | 否 | 无 | 否 |
| `finish_job_id` | TEXT | 否 | 无 | 否 |
| `finish_snapshot_json` | TEXT | 否 | 无 | 否 |
| `processing_job_id` | TEXT | 否 | 无 | 否 |
| `reference_inputs_json` | TEXT | 是 | '{}' | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `member_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_rehearsals_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE rehearsals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('all', 'member')),
  member_id TEXT REFERENCES users(id),
  material_version_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'finished')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  finished_at TEXT
, finish_job_id TEXT, finish_snapshot_json TEXT, processing_job_id TEXT, reference_inputs_json TEXT NOT NULL DEFAULT '{}');
```

## `requirement_sets`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `source_version_id` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_requirement_sets_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_requirement_sets_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE requirement_sets (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_version_id TEXT REFERENCES source_versions(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  revision INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_requirement_sets_project ON requirement_sets (project_id);
```

## `requirements`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `requirement_set_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `category` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `due_date` | TEXT | 否 | 无 | 否 |
| `due_precision` | TEXT | 是 | 'unknown' | 否 |
| `citations_json` | TEXT | 是 | '[]' | 否 |
| `field_state` | TEXT | 是 | 'ai_suggestion' | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `requirement_set_id` → `requirement_sets.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_requirements_2`：`requirement_set_id, seq`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_requirements_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE requirements (
  id TEXT PRIMARY KEY,
  requirement_set_id TEXT NOT NULL REFERENCES requirement_sets(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('deadline', 'deliverable', 'format', 'scoring', 'team', 'other')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  due_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (due_precision IN ('date', 'datetime', 'unknown')),
  citations_json TEXT NOT NULL DEFAULT '[]',
  field_state TEXT NOT NULL DEFAULT 'ai_suggestion' CHECK (field_state IN ('ai_suggestion', 'edited', 'confirmed')),
  updated_at TEXT NOT NULL,
  UNIQUE (requirement_set_id, seq)
);
```

## `resource_index_blocks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `resource_type` | TEXT | 是 | 无 | 否 |
| `version_id` | TEXT | 是 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `fragment_id` | TEXT | 否 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `heading` | TEXT | 是 | '' | 否 |
| `start_offset` | INTEGER | 是 | 无 | 否 |
| `end_offset` | INTEGER | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `search_content` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_resource_blocks_version`：`project_id, resource_type, version_id, seq`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_resource_index_blocks_2`：`project_id, resource_type, version_id, seq`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_resource_index_blocks_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE resource_index_blocks (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL,
 version_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 fragment_id TEXT,
 page_number INTEGER,
 heading TEXT NOT NULL DEFAULT '',
 start_offset INTEGER NOT NULL,
 end_offset INTEGER NOT NULL,
 content TEXT NOT NULL,
 search_content TEXT NOT NULL,
 UNIQUE(project_id,resource_type,version_id,seq)
);
CREATE INDEX idx_resource_blocks_version ON resource_index_blocks(project_id,resource_type,version_id,seq);
```

## `resource_index_fts`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `content` |  | 否 | 无 | 否 |
| `block_id` |  | 否 | 无 | 否 |

外键：
- 无。

索引：
- 无。

```sql
CREATE VIRTUAL TABLE resource_index_fts USING fts5(content, block_id UNINDEXED, tokenize='trigram');
```

## `resource_index_fts_config`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `k` |  | 是 | 无 | 1 |
| `v` |  | 否 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_resource_index_fts_config_1`：`k`；唯一=1；来源=pk；部分索引=0。

此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。

```text
CREATE TABLE 'resource_index_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;
```

## `resource_index_fts_content`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `c0` |  | 否 | 无 | 否 |
| `c1` |  | 否 | 无 | 否 |

外键：
- 无。

索引：
- 无。

此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。

```text
CREATE TABLE 'resource_index_fts_content'(id INTEGER PRIMARY KEY, c0, c1);
```

## `resource_index_fts_data`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `block` | BLOB | 否 | 无 | 否 |

外键：
- 无。

索引：
- 无。

此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。

```text
CREATE TABLE 'resource_index_fts_data'(id INTEGER PRIMARY KEY, block BLOB);
```

## `resource_index_fts_docsize`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `sz` | BLOB | 否 | 无 | 否 |

外键：
- 无。

索引：
- 无。

此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。

```text
CREATE TABLE 'resource_index_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);
```

## `resource_index_fts_idx`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `segid` |  | 是 | 无 | 1 |
| `term` |  | 是 | 无 | 2 |
| `pgno` |  | 否 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_resource_index_fts_idx_1`：`segid, term`；唯一=1；来源=pk；部分索引=0。

此影子表由全文虚拟表自动创建；下列为派生结构说明，不应单独执行。

```text
CREATE TABLE 'resource_index_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;
```

## `resource_index_state`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `resource_type` | TEXT | 是 | 无 | 2 |
| `version_id` | TEXT | 是 | 无 | 3 |
| `cursor` | INTEGER | 是 | 0 | 否 |
| `source_seq` | INTEGER | 是 | 0 | 否 |
| `source_offset` | INTEGER | 是 | 0 | 否 |
| `next_seq` | INTEGER | 是 | 0 | 否 |
| `heading` | TEXT | 是 | '' | 否 |
| `status` | TEXT | 是 | 'building' | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_resource_index_state_1`：`project_id, resource_type, version_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE resource_index_state (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('source','material')),
 version_id TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0,
 source_seq INTEGER NOT NULL DEFAULT 0,
 source_offset INTEGER NOT NULL DEFAULT 0,
 next_seq INTEGER NOT NULL DEFAULT 0,
 heading TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'building' CHECK(status IN ('building','ready')),
 PRIMARY KEY(project_id,resource_type,version_id)
);
```

## `resource_policy`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `version` | INTEGER | 是 | 1 | 否 |
| `policy_json` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- 无。

```sql
CREATE TABLE resource_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 1,
  policy_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

## `resource_policy_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `actor_id` | TEXT | 否 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `policy_json` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_resource_policy_audit_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE resource_policy_audit (id TEXT PRIMARY KEY, actor_id TEXT, version INTEGER NOT NULL, policy_json TEXT NOT NULL, created_at TEXT NOT NULL);
```

## `reviews`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `requirement_set_id` | TEXT | 是 | 无 | 否 |
| `rubric_version_id` | TEXT | 是 | 无 | 否 |
| `material_version_ids_json` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `report_json` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `rubric_version_id` → `rubric_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `requirement_set_id` → `requirement_sets.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `idx_reviews_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_reviews_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requirement_set_id TEXT NOT NULL REFERENCES requirement_sets(id),
  rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
  material_version_ids_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  report_json TEXT,
  job_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_project ON reviews (project_id);
```

## `rubric_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `source` | TEXT | 是 | 无 | 否 |
| `weights_json` | TEXT | 是 | 无 | 否 |
| `notes` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_rubric_versions_2`：`project_id, version`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_rubric_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE rubric_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('official', 'custom')),
  weights_json TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed')),
  confirmed_by TEXT REFERENCES users(id),
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, version)
);
```

## `sessions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 是 | 无 | 否 |
| `token_hash` | TEXT | 是 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `revoked_at` | TEXT | 否 | 无 | 否 |
| `last_seen_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `auth_method` | TEXT | 是 | 'legacy' | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_sessions_user`：`user_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_sessions_2`：`token_hash`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_sessions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
, auth_method TEXT NOT NULL DEFAULT 'legacy' CHECK (auth_method IN ('legacy', 'password')));
CREATE INDEX idx_sessions_user ON sessions (user_id);
```

## `source_fragments`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `page_number` | INTEGER | 否 | 无 | 否 |
| `seq` | INTEGER | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `content` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `heading_path` | TEXT | 否 | 无 | 否 |
| `extraction_session_id` | TEXT | 否 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_source_fragments_stream`：`source_version_id, project_id, seq, id`；唯一=0；来源=c；部分索引=0。
- `idx_source_fragments_page`：`source_version_id, page_number`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_source_fragments_2`：`source_version_id, seq`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_source_fragments_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE source_fragments (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text', 'ocr', 'web', 'paste')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL, heading_path TEXT, extraction_session_id TEXT,
  UNIQUE (source_version_id, seq)
);
CREATE INDEX idx_source_fragments_page ON source_fragments (source_version_id, page_number);
CREATE INDEX idx_source_fragments_stream ON source_fragments(source_version_id,project_id,seq,id);
```

## `source_ocr_batches`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `page_numbers_json` | TEXT | 是 | 无 | 否 |
| `model` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `context_chars` | INTEGER | 是 | 0 | 否 |
| `prompt_tokens` | INTEGER | 否 | 无 | 否 |
| `completion_tokens` | INTEGER | 否 | 无 | 否 |
| `error_code` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `job_id` → `jobs.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `source_ocr_batches_version`：`source_version_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_source_ocr_batches_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE source_ocr_batches (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id),
  lifecycle_version INTEGER NOT NULL,
  job_id TEXT REFERENCES jobs(id),
  page_numbers_json TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('dispatched','ok','partial','failed','rejected')),
  context_chars INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX source_ocr_batches_version ON source_ocr_batches(source_version_id, created_at);
```

## `source_pages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_version_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `page_number` | INTEGER | 是 | 无 | 否 |
| `text_status` | TEXT | 是 | 'none' | 否 |
| `image_file_id` | TEXT | 否 | 无 | 否 |
| `image_status` | TEXT | 是 | 'none' | 否 |
| `ocr_status` | TEXT | 是 | 'none' | 否 |
| `ocr_method` | TEXT | 否 | 无 | 否 |
| `ocr_confidence` | REAL | 否 | 无 | 否 |
| `needs_review` | INTEGER | 是 | 0 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `image_file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_source_pages_2`：`source_version_id, page_number`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_source_pages_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE source_pages (
  id TEXT PRIMARY KEY,
  source_version_id TEXT NOT NULL REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text_status TEXT NOT NULL DEFAULT 'none' CHECK (text_status IN ('none', 'extracted', 'empty')),
  image_file_id TEXT REFERENCES files(id),
  image_status TEXT NOT NULL DEFAULT 'none' CHECK (image_status IN ('none', 'uploaded', 'rejected')),
  ocr_status TEXT NOT NULL DEFAULT 'none' CHECK (ocr_status IN ('none', 'pending', 'ok', 'failed')),
  ocr_method TEXT,
  ocr_confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE (source_version_id, page_number)
);
```

## `source_processing`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `source_version_id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `text_status` | TEXT | 是 | 'pending' | 否 |
| `requirements_status` | TEXT | 是 | 'pending' | 否 |
| `requirements_error` | TEXT | 否 | 无 | 否 |
| `summary_status` | TEXT | 是 | 'pending' | 否 |
| `summary_json` | TEXT | 否 | 无 | 否 |
| `summary_error` | TEXT | 否 | 无 | 否 |
| `summary_job_id` | TEXT | 否 | 无 | 否 |
| `summary_revision` | INTEGER | 是 | 0 | 否 |
| `covered_chars` | INTEGER | 否 | 无 | 否 |
| `total_chars` | INTEGER | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `source_version_id` → `source_versions.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_source_processing_1`：`source_version_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE source_processing (
  source_version_id TEXT PRIMARY KEY REFERENCES source_versions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  text_status TEXT NOT NULL DEFAULT 'pending' CHECK (text_status IN ('pending','processing','waiting_input','ready','failed')),
  requirements_status TEXT NOT NULL DEFAULT 'pending' CHECK (requirements_status IN ('pending','processing','ready','failed')),
  requirements_error TEXT,
  summary_status TEXT NOT NULL DEFAULT 'pending' CHECK (summary_status IN ('pending','queued','running','ready','failed','cancelled')),
  summary_json TEXT,
  summary_error TEXT,
  summary_job_id TEXT,
  summary_revision INTEGER NOT NULL DEFAULT 0,
  covered_chars INTEGER,
  total_chars INTEGER,
  updated_at TEXT NOT NULL
);
```

## `source_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `source_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `revision` | INTEGER | 是 | 无 | 否 |
| `origin` | TEXT | 是 | 无 | 否 |
| `file_id` | TEXT | 否 | 无 | 否 |
| `url` | TEXT | 否 | 无 | 否 |
| `text_r2_key` | TEXT | 否 | 无 | 否 |
| `char_count` | INTEGER | 否 | 无 | 否 |
| `page_count` | INTEGER | 否 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `parse_error` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `ai_config_version_id` | TEXT | 否 | 无 | 否 |
| `extraction_method` | TEXT | 否 | 无 | 否 |
| `extraction_warnings_json` | TEXT | 是 | '[]' | 否 |
| `extraction_coverage` | TEXT | 否 | 无 | 否 |

外键：
- `ai_config_version_id` → `ai_config_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。
- `source_id` → `sources.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `sqlite_autoindex_source_versions_2`：`source_id, revision`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_source_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE source_versions (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('file', 'web', 'paste')),
  file_id TEXT REFERENCES files(id),
  url TEXT,
  text_r2_key TEXT,
  char_count INTEGER,
  page_count INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  parse_error TEXT,
  created_at TEXT NOT NULL, ai_config_version_id TEXT REFERENCES ai_config_versions(id), extraction_method TEXT, extraction_warnings_json TEXT NOT NULL DEFAULT '[]', extraction_coverage TEXT,
  UNIQUE (source_id, revision)
);
```

## `sources`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `url` | TEXT | 否 | 无 | 否 |
| `current_version_id` | TEXT | 否 | 无 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `deleted_at` | TEXT | 否 | 无 | 否 |
| `deleted_by` | TEXT | 否 | 无 | 否 |
| `deleted_via_file_id` | TEXT | 否 | 无 | 否 |
| `lifecycle_version` | INTEGER | 是 | 1 | 否 |
| `lifecycle_change_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 'reference' | 否 |
| `resource_revision` | INTEGER | 是 | 1 | 否 |
| `automatic_import` | INTEGER | 是 | 0 | 否 |

外键：
- `deleted_via_file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `deleted_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `idx_sources_recycle`：`project_id, deleted_at, created_at, id`；唯一=0；来源=c；部分索引=0。
- `idx_sources_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_sources_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'web', 'paste')),
  title TEXT NOT NULL,
  url TEXT,
  current_version_id TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, deleted_at TEXT, deleted_by TEXT REFERENCES users(id), deleted_via_file_id TEXT REFERENCES files(id), lifecycle_version INTEGER NOT NULL DEFAULT 1, lifecycle_change_id TEXT, purpose TEXT NOT NULL DEFAULT 'reference'
  CHECK (purpose IN ('background','reference','output')), resource_revision INTEGER NOT NULL DEFAULT 1, automatic_import INTEGER NOT NULL DEFAULT 0 CHECK(automatic_import IN (0,1)));
CREATE INDEX idx_sources_project ON sources (project_id);
CREATE INDEX idx_sources_recycle ON sources(project_id, deleted_at, created_at, id);
```

## `standards_versions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `version` | INTEGER | 是 | 无 | 否 |
| `title` | TEXT | 是 | '' | 否 |
| `status` | TEXT | 是 | 'draft' | 否 |
| `requirement_set_ids_json` | TEXT | 是 | '[]' | 否 |
| `rubric_version_id` | TEXT | 是 | 无 | 否 |
| `mappings_json` | TEXT | 是 | '[]' | 否 |
| `snapshot_json` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `confirmed_by` | TEXT | 否 | 无 | 否 |
| `confirmed_at` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `confirmed_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `rubric_version_id` → `rubric_versions.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `sqlite_autoindex_standards_versions_2`：`project_id, version`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_standards_versions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE standards_versions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed')),
 requirement_set_ids_json TEXT NOT NULL DEFAULT '[]', rubric_version_id TEXT NOT NULL REFERENCES rubric_versions(id),
 mappings_json TEXT NOT NULL DEFAULT '[]', snapshot_json TEXT,
 revision INTEGER NOT NULL DEFAULT 1, confirmed_by TEXT REFERENCES users(id), confirmed_at TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,version)
);
```

## `storage_counters`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `scope` | TEXT | 是 | 无 | 1 |
| `scope_id` | TEXT | 是 | 无 | 2 |
| `bytes` | INTEGER | 是 | 0 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_storage_counters_1`：`scope, scope_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE storage_counters(scope TEXT NOT NULL,scope_id TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes>=0),PRIMARY KEY(scope,scope_id));
```

## `storage_inventory_state`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | INTEGER | 否 | 无 | 1 |
| `ready` | INTEGER | 是 | 0 | 否 |
| `external_checked_at` | TEXT | 否 | 无 | 否 |
| `cursor` | TEXT | 否 | 无 | 否 |
| `scanning` | INTEGER | 是 | 0 | 否 |
| `verification_note` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- 无。

```sql
CREATE TABLE storage_inventory_state (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN(0,1)), external_checked_at TEXT, cursor TEXT, scanning INTEGER NOT NULL DEFAULT 0, verification_note TEXT, updated_at TEXT NOT NULL);
```

## `storage_objects`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `object_key` | TEXT | 否 | 无 | 1 |
| `size_bytes` | INTEGER | 是 | 0 | 否 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `user_id` | TEXT | 否 | 无 | 否 |
| `category` | TEXT | 是 | 无 | 否 |
| `etag` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `idx_storage_objects_user`：`user_id`；唯一=0；来源=c；部分索引=0。
- `idx_storage_objects_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_storage_objects_1`：`object_key`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE storage_objects (
  object_key TEXT PRIMARY KEY, size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes>=0),
  project_id TEXT, user_id TEXT, category TEXT NOT NULL CHECK(category IN('upload','system')),
  etag TEXT, updated_at TEXT NOT NULL
);
CREATE INDEX idx_storage_objects_project ON storage_objects(project_id);
CREATE INDEX idx_storage_objects_user ON storage_objects(user_id);
```

## `storage_reservations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `object_key` | TEXT | 是 | 无 | 否 |
| `bytes` | INTEGER | 是 | 无 | 否 |
| `project_id` | TEXT | 否 | 无 | 否 |
| `user_id` | TEXT | 否 | 无 | 否 |
| `category` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `recovery_token` | TEXT | 否 | 无 | 否 |
| `recovery_expires_at` | TEXT | 否 | 无 | 否 |
| `upload_id` | TEXT | 否 | 无 | 否 |
| `expires_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `idx_storage_reservations_expiry`：`expires_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_storage_reservations_2`：`object_key`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_storage_reservations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE storage_reservations (
  id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, bytes INTEGER NOT NULL CHECK(bytes>=0),
  project_id TEXT, user_id TEXT, category TEXT NOT NULL CHECK(category IN('upload','system')),
  kind TEXT NOT NULL CHECK(kind IN('put','multipart','delete')),
  status TEXT NOT NULL CHECK(status IN('reserved','uncertain','reclaiming')), recovery_token TEXT, recovery_expires_at TEXT, upload_id TEXT, expires_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_storage_reservations_expiry ON storage_reservations(expires_at);
```

## `storage_resolution_audit`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `reservation_id` | TEXT | 是 | 无 | 否 |
| `actor_id` | TEXT | 是 | 无 | 否 |
| `reason` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_storage_resolution_audit_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE storage_resolution_audit(id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
```

## `support_ticket_images`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ticket_id` | TEXT | 是 | 无 | 否 |
| `content_type` | TEXT | 是 | 无 | 否 |
| `size_bytes` | INTEGER | 是 | 无 | 否 |
| `sha256` | TEXT | 是 | 无 | 否 |
| `state` | TEXT | 是 | 'pending' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `ticket_id` → `support_tickets.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `support_ticket_images_ticket`：`ticket_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_support_ticket_images_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE support_ticket_images (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  sha256 TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_images_ticket ON support_ticket_images(ticket_id, created_at, id);
```

## `support_ticket_messages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `ticket_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `ticket_id` → `support_tickets.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `support_ticket_messages_ticket_created`：`ticket_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_support_ticket_messages_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE support_ticket_messages (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES support_tickets(id),
  author_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('reply','status')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  created_at TEXT NOT NULL
);
CREATE INDEX support_ticket_messages_ticket_created ON support_ticket_messages(ticket_id, created_at, id);
```

## `support_tickets`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `owner_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `urgency` | TEXT | 是 | 'normal' | 否 |
| `category` | TEXT | 是 | 'other' | 否 |

外键：
- `owner_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。

索引：
- `support_tickets_created`：`created_at, id`；唯一=0；来源=c；部分索引=0。
- `support_tickets_owner_created`：`owner_id, created_at, id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_support_tickets_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE support_tickets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','waiting_user','resolved','closed')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','urgent')), category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('interface','functionality','account','performance','other')));
CREATE INDEX support_tickets_created ON support_tickets(created_at DESC, id DESC);
CREATE INDEX support_tickets_owner_created ON support_tickets(owner_id, created_at DESC, id DESC);
```

## `task_agent_auto_checks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `pending` | INTEGER | 是 | 1 | 否 |
| `activation_epoch` | INTEGER | 是 | 0 | 否 |
| `config_version_id` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_agent_auto_checks_1`：`task_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_agent_auto_checks (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)),
 activation_epoch INTEGER NOT NULL DEFAULT 0,
 config_version_id TEXT, updated_at TEXT NOT NULL
);
```

## `task_agent_eligibility`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 2 |
| `source_hash` | TEXT | 是 | 无 | 3 |
| `status` | TEXT | 是 | 无 | 否 |
| `eligible` | INTEGER | 否 | 无 | 否 |
| `reason` | TEXT | 否 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `idx_task_agent_eligibility_job`：`job_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_agent_eligibility_1`：`project_id, task_id, source_hash`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_agent_eligibility (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  eligible INTEGER CHECK(eligible IN (0,1)),
  reason TEXT,
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id,source_hash)
);
CREATE INDEX idx_task_agent_eligibility_job ON task_agent_eligibility(job_id);
```

## `task_assistance_plans`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 否 | 无 | 1 |
| `markdown` | TEXT | 否 | 无 | 否 |
| `generated_at` | TEXT | 否 | 无 | 否 |
| `plan_source_hash` | TEXT | 否 | 无 | 否 |
| `source_hash` | TEXT | 是 | 无 | 否 |
| `context_stamp` | TEXT | 是 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `error` | TEXT | 否 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_assistance_plans_1`：`task_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_assistance_plans (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 markdown TEXT, generated_at TEXT, plan_source_hash TEXT,
 source_hash TEXT NOT NULL, context_stamp TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
 job_id TEXT NOT NULL, error TEXT, updated_at TEXT NOT NULL
);
```

## `task_completion_people`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `user_id` | TEXT | 否 | 无 | 否 |
| `completed_at` | TEXT | 是 | 无 | 否 |

外键：
- `user_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_completion_people_1`：`task_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_completion_people (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 user_id TEXT REFERENCES users(id), completed_at TEXT NOT NULL
);
```

## `task_dependencies`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 1 |
| `depends_on_task_id` | TEXT | 是 | 无 | 2 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `tasks.project_id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `depends_on_task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/1；MATCH NONE。
- `project_id` → `tasks.project_id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/1；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_task_dependencies_upstream`：`project_id, depends_on_task_id, task_id`；唯一=0；来源=c；部分索引=0。
- `idx_task_dependencies_project`：`project_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_dependencies_1`：`task_id, depends_on_task_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_dependencies (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL, depends_on_task_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(task_id,depends_on_task_id), CHECK(task_id != depends_on_task_id),
 FOREIGN KEY(project_id,task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE,
 FOREIGN KEY(project_id,depends_on_task_id) REFERENCES tasks(project_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_task_dependencies_project ON task_dependencies(project_id);
CREATE INDEX idx_task_dependencies_upstream ON task_dependencies(project_id, depends_on_task_id, task_id);
```

## `task_file_uploads`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `file_id` | TEXT | 否 | 无 | 1 |
| `material_id` | TEXT | 是 | 无 | 否 |

外键：
- `material_id` → `materials.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `file_id` → `files.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `idx_task_file_uploads_material`：`material_id`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_file_uploads_1`：`file_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_file_uploads (
  file_id TEXT PRIMARY KEY REFERENCES files(id),
  material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE
);
CREATE INDEX idx_task_file_uploads_material ON task_file_uploads(material_id);
```

## `task_inquiries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `upstream_task_id` | TEXT | 是 | 无 | 否 |
| `requester_id` | TEXT | 是 | 无 | 否 |
| `recipient_id` | TEXT | 是 | 无 | 否 |
| `recipient_source` | TEXT | 是 | 无 | 否 |
| `task_title` | TEXT | 是 | 无 | 否 |
| `upstream_title` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `recipient_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `requester_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `upstream_task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 3/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 4/0；MATCH NONE。

索引：
- `task_inquiries_task`：`project_id, task_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_inquiries_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_inquiries (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
 task_id TEXT NOT NULL REFERENCES tasks(id), upstream_task_id TEXT NOT NULL REFERENCES tasks(id),
 requester_id TEXT NOT NULL REFERENCES users(id), recipient_id TEXT NOT NULL REFERENCES users(id),
 recipient_source TEXT NOT NULL CHECK(recipient_source IN('submission','completion','substitute')),
 task_title TEXT NOT NULL, upstream_title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX task_inquiries_task ON task_inquiries(project_id,task_id,created_at);
```

## `task_inquiry_messages`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `inquiry_id` | TEXT | 是 | 无 | 否 |
| `author_id` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `author_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `inquiry_id` → `task_inquiries.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。

索引：
- `task_inquiry_messages_thread`：`inquiry_id, created_at`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_inquiry_messages_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_inquiry_messages (
 id TEXT PRIMARY KEY, inquiry_id TEXT NOT NULL REFERENCES task_inquiries(id), author_id TEXT NOT NULL REFERENCES users(id),
 body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at TEXT NOT NULL
);
CREATE INDEX task_inquiry_messages_thread ON task_inquiry_messages(inquiry_id,created_at);
```

## `task_links`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `kind` | TEXT | 是 | 无 | 否 |
| `target_id` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_links_2`：`task_id, kind, target_id`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_task_links_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('requirement', 'material', 'source_version', 'file')),
  target_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, kind, target_id)
);
```

## `task_readiness`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `task_id` | TEXT | 否 | 无 | 1 |
| `assignee_id` | TEXT | 否 | 无 | 否 |
| `ready` | INTEGER | 是 | 无 | 否 |
| `generation` | INTEGER | 是 | 0 | 否 |

外键：
- `assignee_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_readiness_1`：`task_id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_readiness (
 task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 assignee_id TEXT REFERENCES users(id), ready INTEGER NOT NULL CHECK(ready IN (0,1)), generation INTEGER NOT NULL DEFAULT 0
);
```

## `task_submissions`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `task_id` | TEXT | 是 | 无 | 否 |
| `round` | INTEGER | 是 | 无 | 否 |
| `submitted_by` | TEXT | 是 | 无 | 否 |
| `body` | TEXT | 是 | 无 | 否 |
| `material_versions_json` | TEXT | 是 | '[]' | 否 |
| `criteria` | TEXT | 是 | 无 | 否 |
| `task_revision` | INTEGER | 是 | 无 | 否 |
| `status` | TEXT | 是 | 'pending' | 否 |
| `ai_decision` | TEXT | 否 | 无 | 否 |
| `ai_feedback` | TEXT | 否 | 无 | 否 |
| `decision` | TEXT | 否 | 无 | 否 |
| `feedback` | TEXT | 否 | 无 | 否 |
| `decided_by` | TEXT | 否 | 无 | 否 |
| `evaluation_job_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `evaluation_attempts` | INTEGER | 是 | 0 | 否 |
| `ai_report_json` | TEXT | 否 | 无 | 否 |
| `mutation_token` | TEXT | 否 | 无 | 否 |
| `human_score_override_json` | TEXT | 否 | 无 | 否 |

外键：
- `submitted_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 2/0；MATCH NONE。

索引：
- `idx_submissions_task`：`project_id, task_id, round`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_task_submissions_2`：`task_id, round`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_task_submissions_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_submissions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, round INTEGER NOT NULL,
 submitted_by TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, material_versions_json TEXT NOT NULL DEFAULT '[]',
 criteria TEXT NOT NULL, task_revision INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','evaluated','accept','improve','rework')),
 ai_decision TEXT CHECK(ai_decision IN ('accept','improve','rework')), ai_feedback TEXT,
 decision TEXT CHECK(decision IN ('accept','improve','rework')), feedback TEXT, decided_by TEXT,
 evaluation_job_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, evaluation_attempts INTEGER NOT NULL DEFAULT 0, ai_report_json TEXT, mutation_token TEXT, human_score_override_json TEXT,
 UNIQUE(task_id,round)
);
CREATE INDEX idx_submissions_task ON task_submissions(project_id,task_id,round);
```

## `task_summaries`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `project_id` | TEXT | 是 | 无 | 1 |
| `task_id` | TEXT | 是 | 无 | 2 |
| `source_hash` | TEXT | 是 | 无 | 3 |
| `summary` | TEXT | 否 | 无 | 否 |
| `status` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |

外键：
- `task_id` → `tasks.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 1/0；MATCH NONE。

索引：
- `sqlite_autoindex_task_summaries_1`：`project_id, task_id, source_hash`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE task_summaries (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','running','ready','failed')),
  job_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, source_hash)
);
```

## `tasks`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `title` | TEXT | 是 | 无 | 否 |
| `detail` | TEXT | 是 | '' | 否 |
| `assignee_id` | TEXT | 否 | 无 | 否 |
| `due_date` | TEXT | 否 | 无 | 否 |
| `due_precision` | TEXT | 是 | 'unknown' | 否 |
| `status` | TEXT | 是 | 'todo' | 否 |
| `requirement_id` | TEXT | 否 | 无 | 否 |
| `revision` | INTEGER | 是 | 1 | 否 |
| `created_by` | TEXT | 是 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `updated_at` | TEXT | 是 | 无 | 否 |
| `lifecycle_state` | TEXT | 否 | 无 | 否 |
| `criteria` | TEXT | 是 | '' | 否 |
| `current_submission_id` | TEXT | 否 | 无 | 否 |
| `effort_hours` | REAL | 是 | 1 | 否 |
| `source_citations_json` | TEXT | 是 | '[]' | 否 |
| `plan_proposal_id` | TEXT | 否 | 无 | 否 |
| `started_at` | TEXT | 否 | 无 | 否 |
| `archived_at` | TEXT | 否 | 无 | 否 |

外键：
- `created_by` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 0/0；MATCH NONE。
- `requirement_id` → `requirements.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 1/0；MATCH NONE。
- `assignee_id` → `users.id`；ON UPDATE NO ACTION；ON DELETE NO ACTION；复合关系 2/0；MATCH NONE。
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 3/0；MATCH NONE。

索引：
- `idx_tasks_project_id`：`project_id, id`；唯一=1；来源=c；部分索引=0。
- `idx_tasks_project`：`project_id, status`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_tasks_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id),
  due_date TEXT,
  due_precision TEXT NOT NULL DEFAULT 'unknown' CHECK (due_precision IN ('date', 'datetime', 'unknown')),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  requirement_id TEXT REFERENCES requirements(id),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, lifecycle_state TEXT CHECK (lifecycle_state IN ('open','in_progress','submitted','accepted','improve','rework')), criteria TEXT NOT NULL DEFAULT '', current_submission_id TEXT, effort_hours REAL NOT NULL DEFAULT 1 CHECK(effort_hours > 0 AND effort_hours <= 200), source_citations_json TEXT NOT NULL DEFAULT '[]', plan_proposal_id TEXT, started_at TEXT, archived_at TEXT);
CREATE INDEX idx_tasks_project ON tasks (project_id, status);
CREATE UNIQUE INDEX idx_tasks_project_id ON tasks(project_id,id);
```

## `usage_reservations`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `project_id` | TEXT | 是 | 无 | 否 |
| `job_id` | TEXT | 否 | 无 | 否 |
| `purpose` | TEXT | 是 | 无 | 否 |
| `estimated_cost` | REAL | 是 | 0 | 否 |
| `status` | TEXT | 是 | 'reserved' | 否 |
| `settled_cost` | REAL | 否 | 无 | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `settled_at` | TEXT | 否 | 无 | 否 |
| `attempts_started` | INTEGER | 是 | 0 | 否 |
| `max_calls` | INTEGER | 是 | 2 | 否 |

外键：
- `project_id` → `projects.id`；ON UPDATE NO ACTION；ON DELETE CASCADE；复合关系 0/0；MATCH NONE。

索引：
- `idx_reservations_active_sweep`：`created_at, id`；唯一=0；来源=c；部分索引=1。
- `idx_reservations_active_job_created`：`job_id, created_at`；唯一=0；来源=c；部分索引=1。
- `idx_reservations_project_status`：`project_id, status`；唯一=0；来源=c；部分索引=0。
- `sqlite_autoindex_usage_reservations_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  job_id TEXT,
  purpose TEXT NOT NULL,
  estimated_cost REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'settled', 'released', 'pending_reconcile')),
  settled_cost REAL,
  created_at TEXT NOT NULL,
  settled_at TEXT
, attempts_started INTEGER NOT NULL DEFAULT 0, max_calls INTEGER NOT NULL DEFAULT 2);
CREATE INDEX idx_reservations_active_job_created
  ON usage_reservations(job_id, created_at DESC) WHERE status = 'reserved';
CREATE INDEX idx_reservations_active_sweep ON usage_reservations(created_at,id) WHERE status='reserved';
CREATE INDEX idx_reservations_project_status ON usage_reservations (project_id, status);
```

## `users`

| 字段 | 类型 | NOT NULL | 默认值 | 主键顺序 |
| --- | --- | --- | --- | --- |
| `id` | TEXT | 否 | 无 | 1 |
| `email` | TEXT | 是 | 无 | 否 |
| `display_name` | TEXT | 是 | '' | 否 |
| `created_at` | TEXT | 是 | 无 | 否 |
| `last_login_at` | TEXT | 否 | 无 | 否 |

外键：
- 无。

索引：
- `sqlite_autoindex_users_2`：`email`；唯一=1；来源=u；部分索引=0。
- `sqlite_autoindex_users_1`：`id`；唯一=1；来源=pk；部分索引=0。

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
```

## 视图与触发器

```sql
CREATE TRIGGER ai_activity_job_created AFTER INSERT ON jobs BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.created_at);
 INSERT INTO ai_activity_events(target_id,code,state,created_at) VALUES(NEW.id,'preparing','started',NEW.created_at);
END;
CREATE TRIGGER ai_activity_job_status AFTER UPDATE OF status ON jobs WHEN NEW.status != OLD.status BEGIN
 INSERT OR IGNORE INTO ai_task_activities(target_id,code,updated_at) VALUES(NEW.id,'preparing',NEW.updated_at);
 UPDATE ai_task_activities SET code=CASE NEW.status WHEN 'succeeded' THEN 'completed' WHEN 'waiting_input' THEN 'waiting_input' WHEN 'cancelled' THEN 'cancelled' WHEN 'queued' THEN 'retrying' ELSE code END, updated_at=NEW.updated_at WHERE target_id=NEW.id;
 INSERT INTO ai_activity_events(target_id,code,state,created_at,progress_json) SELECT NEW.id,code,CASE NEW.status WHEN 'failed' THEN 'failed' WHEN 'succeeded' THEN 'completed' WHEN 'queued' THEN 'resumed' ELSE 'started' END,NEW.updated_at,progress_json FROM ai_task_activities WHERE target_id=NEW.id;
END;
CREATE TRIGGER ai_diagnostics_retention_delete AFTER DELETE ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET entry_count = entry_count - 1,
    byte_count = byte_count - OLD.byte_size WHERE id = 1;
END;
CREATE TRIGGER ai_diagnostics_retention_insert AFTER INSERT ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET entry_count = entry_count + 1,
    byte_count = byte_count + NEW.byte_size WHERE id = 1;
END;
CREATE TRIGGER ai_diagnostics_retention_update AFTER UPDATE OF byte_size ON ai_diagnostics
BEGIN
  UPDATE ai_diagnostic_retention SET byte_count = byte_count + NEW.byte_size - OLD.byte_size WHERE id = 1;
END;
CREATE TRIGGER ai_resource_cancel_count AFTER UPDATE OF status ON ai_resource_dispatches
WHEN OLD.status='claimed' AND NEW.status='cancelled' BEGIN
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='platform' AND scope_id='global';
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='user' AND scope_id=NEW.user_id;
  UPDATE ai_resource_daily SET calls=calls-1 WHERE quota_day=NEW.quota_day AND scope='project' AND scope_id=NEW.project_id;
END;
CREATE TRIGGER ai_resource_dispatch_count AFTER INSERT ON ai_resource_dispatches BEGIN
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='platform' AND scope_id='global';
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='user' AND scope_id=NEW.user_id;
  UPDATE ai_resource_daily SET calls=calls+1 WHERE quota_day=NEW.quota_day AND scope='project' AND scope_id=NEW.project_id;
END;
CREATE TRIGGER auth_email_dispatch_count AFTER INSERT ON auth_email_dispatches BEGIN
  INSERT INTO auth_email_daily_usage(day,sends) VALUES (NEW.day,1)
    ON CONFLICT(day) DO UPDATE SET sends=sends+1;
  INSERT INTO auth_email_recipient_usage(day,email_hash,sends) VALUES (NEW.day,NEW.recipient_hash,1)
    ON CONFLICT(day,email_hash) DO UPDATE SET sends=sends+1;
END;
CREATE TRIGGER resource_index_delete AFTER DELETE ON resource_index_blocks BEGIN
 DELETE FROM resource_index_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER resource_index_insert AFTER INSERT ON resource_index_blocks BEGIN
 INSERT INTO resource_index_fts(rowid,content,block_id) VALUES(new.rowid,new.search_content,new.id);
END;
CREATE TRIGGER storage_objects_count_delete AFTER DELETE ON storage_objects
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
END;
CREATE TRIGGER storage_objects_count_insert AFTER INSERT ON storage_objects
BEGIN
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',1*NEW.size_bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',1*NEW.size_bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,1*NEW.size_bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,1*NEW.size_bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER storage_objects_count_update AFTER UPDATE OF size_bytes,user_id,project_id,category ON storage_objects
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.size_bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',NEW.size_bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',NEW.size_bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,NEW.size_bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,NEW.size_bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER storage_reservations_count_delete AFTER DELETE ON storage_reservations
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
END;
CREATE TRIGGER storage_reservations_count_insert AFTER INSERT ON storage_reservations
BEGIN
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',1*NEW.bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',1*NEW.bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,1*NEW.bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,1*NEW.bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER storage_reservations_count_update AFTER UPDATE OF bytes,user_id,project_id,category ON storage_reservations
BEGIN
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='all' AND 1;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='platform' AND scope_id='upload' AND OLD.category='upload';
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='user' AND scope_id=OLD.user_id AND OLD.user_id IS NOT NULL;
 UPDATE storage_counters SET bytes=bytes-OLD.bytes WHERE scope='project' AND scope_id=OLD.project_id AND OLD.project_id IS NOT NULL;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','all',NEW.bytes WHERE 1 ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'platform','upload',NEW.bytes WHERE NEW.category='upload' ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'user',NEW.user_id,NEW.bytes WHERE NEW.user_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
 INSERT INTO storage_counters(scope,scope_id,bytes) SELECT 'project',NEW.project_id,NEW.bytes WHERE NEW.project_id IS NOT NULL ON CONFLICT(scope,scope_id) DO UPDATE SET bytes=bytes+excluded.bytes;
END;
CREATE TRIGGER system_background_goal_insert AFTER INSERT ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER system_background_goal_update AFTER UPDATE OF title,detail ON project_goals BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.project_id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.project_id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER system_background_project_update AFTER UPDATE OF name,description ON projects BEGIN

 INSERT INTO materials(id,project_id,title,kind,purpose,system_managed,is_default_background,revision,created_by,created_at,updated_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),p.id,'系统背景','background','background',1,
 CASE WHEN EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND is_default_background=1) THEN 0 ELSE 1 END,1,p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM materials WHERE project_id=p.id AND system_managed=1);
 INSERT INTO material_versions(id,material_id,project_id,revision,doc_json,markdown,origin,author_id,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-a'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),m.id,p.id,COALESCE((SELECT MAX(revision) FROM material_versions WHERE material_id=m.id),0)+1,
 json_object('type','doc','content',json_array(json_object('type','paragraph','content',json_array(json_object('type','text','text','项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END))))),
 '项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END,'manual',p.created_by,strftime('%Y-%m-%dT%H:%M:%fZ','now')
 FROM projects p JOIN project_goals g ON g.project_id=p.id JOIN materials m ON m.project_id=p.id AND m.system_managed=1
 WHERE p.id=NEW.id AND NOT EXISTS(SELECT 1 FROM material_versions WHERE id=m.current_version_id AND markdown=('项目名称：'||p.name||char(10)||char(10)||'项目说明：'||CASE WHEN trim(p.description)='' THEN '尚未填写' ELSE p.description END||char(10)||char(10)||'主目标：'||g.title||char(10)||char(10)||'目标说明：'||CASE WHEN trim(g.detail)='' THEN '尚未填写' ELSE g.detail END));
 UPDATE materials SET current_version_id=(SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1),
 revision=(SELECT MAX(revision) FROM material_versions WHERE material_id=materials.id),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE project_id=NEW.id AND system_managed=1 AND current_version_id IS NOT (SELECT id FROM material_versions WHERE material_id=materials.id ORDER BY revision DESC LIMIT 1);
END;
CREATE TRIGGER task_agent_check_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_agent_auto_checks(task_id,updated_at) VALUES(NEW.id,NEW.updated_at);
END;
CREATE TRIGGER task_agent_check_edited AFTER UPDATE OF title,detail,criteria ON tasks
 WHEN OLD.title IS NOT NEW.title OR OLD.detail IS NOT NEW.detail OR OLD.criteria IS NOT NEW.criteria BEGIN
 INSERT INTO task_agent_auto_checks(task_id,pending,updated_at) VALUES(NEW.id,1,NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET pending=1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER task_agent_check_global_reenabled AFTER UPDATE OF enabled ON ai_config_versions
 WHEN OLD.enabled=0 AND NEW.enabled=1 AND NEW.version=(SELECT MAX(version) FROM ai_config_versions) BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.created_at
 WHERE task_id IN (SELECT id FROM tasks WHERE archived_at IS NULL);
END;
CREATE TRIGGER task_agent_check_project_reenabled AFTER UPDATE OF ai_collaboration_enabled ON projects
 WHEN OLD.ai_collaboration_enabled=0 AND NEW.ai_collaboration_enabled=1 BEGIN
 UPDATE task_agent_auto_checks SET pending=1,activation_epoch=activation_epoch+1,updated_at=NEW.updated_at
 WHERE task_id IN (SELECT id FROM tasks WHERE project_id=NEW.id AND archived_at IS NULL);
END;
CREATE TRIGGER task_completed_person AFTER UPDATE OF status ON tasks WHEN OLD.status!='done' AND NEW.status='done' BEGIN
 INSERT INTO task_completion_people(task_id,user_id,completed_at)
 VALUES(NEW.id,COALESCE((SELECT submitted_by FROM task_submissions WHERE id=NEW.current_submission_id AND status='accept'),OLD.assignee_id),NEW.updated_at)
 ON CONFLICT(task_id) DO UPDATE SET user_id=excluded.user_id,completed_at=excluded.completed_at;
END;
CREATE TRIGGER task_readiness_changed AFTER UPDATE OF status,assignee_id ON tasks BEGIN
 -- Changing who owns a task establishes a new baseline, without notifying on claim.
 UPDATE task_readiness SET assignee_id=NEW.assignee_id,ready=(SELECT ready FROM task_readiness_current WHERE task_id=NEW.id),generation=generation+1
 WHERE task_id=NEW.id AND assignee_id IS NOT NEW.assignee_id;
 UPDATE task_readiness SET ready=(SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id),
 generation=generation+CASE WHEN ready=0 AND (SELECT ready FROM task_readiness_current c WHERE c.task_id=task_readiness.task_id)=1 THEN 1 ELSE 0 END
 WHERE task_id=NEW.id OR task_id IN(SELECT task_id FROM task_dependencies WHERE depends_on_task_id=NEW.id AND project_id=NEW.project_id);
END;
CREATE TRIGGER task_readiness_created AFTER INSERT ON tasks BEGIN
 INSERT INTO task_readiness(task_id,assignee_id,ready) SELECT task_id,assignee_id,ready FROM task_readiness_current WHERE task_id=NEW.id;
END;
CREATE TRIGGER task_readiness_member_left AFTER DELETE ON project_members BEGIN
 UPDATE task_readiness SET ready=0 WHERE assignee_id=OLD.user_id AND task_id IN(SELECT id FROM tasks WHERE project_id=OLD.project_id);
END;
CREATE TRIGGER task_readiness_notify AFTER UPDATE OF ready ON task_readiness
 WHEN OLD.ready=0 AND NEW.ready=1 AND OLD.assignee_id IS NEW.assignee_id BEGIN
 INSERT OR IGNORE INTO notification_events(id,event_key,kind,scope,resource_id,actor_id,title,body,url,created_at)
 SELECT lower(hex(randomblob(4)))||'-'||lower(hex(randomblob(2)))||'-4'||substr(lower(hex(randomblob(2))),2)||'-8'||substr(lower(hex(randomblob(2))),2)||'-'||lower(hex(randomblob(6))),'task_ready:'||NEW.task_id||':'||NEW.generation,'task_ready','project',t.project_id,NULL,
 '领取的任务可以开始了','你领取的任务「'||t.title||'」的所有前置任务均已完成。',
 '/app/projects/'||t.project_id||'/tasks?task='||t.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM tasks t WHERE t.id=NEW.task_id;
 INSERT OR IGNORE INTO notification_inbox(event_id,user_id)
 SELECT e.id,NEW.assignee_id FROM notification_events e JOIN auth_accounts a ON a.user_id=NEW.assignee_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND a.password_hash IS NOT NULL;
 INSERT OR IGNORE INTO notification_push_outbox(event_id,subscription_id,available_at,created_at,updated_at)
 SELECT e.id,s.id,e.created_at,e.created_at,e.created_at FROM notification_events e
 JOIN notification_inbox n ON n.event_id=e.id JOIN push_subscriptions s ON s.user_id=n.user_id
 LEFT JOIN notification_settings p ON p.user_id=s.user_id
 WHERE e.event_key='task_ready:'||NEW.task_id||':'||NEW.generation AND s.disabled_at IS NULL AND s.created_at<=e.created_at AND COALESCE(p.push_enabled,1)=1;
END;
CREATE TRIGGER tasks_started_insert AFTER INSERT ON tasks WHEN NEW.assignee_id IS NOT NULL OR NEW.status IN ('doing','done') OR NEW.lifecycle_state IN ('in_progress','submitted','improve','rework','accepted') BEGIN UPDATE tasks SET started_at=COALESCE(NEW.started_at,NEW.updated_at) WHERE id=NEW.id; END;
CREATE TRIGGER tasks_started_update AFTER UPDATE OF assignee_id,status,lifecycle_state ON tasks WHEN OLD.started_at IS NOT NULL OR NEW.assignee_id IS NOT NULL OR NEW.status IN ('doing','done') OR NEW.lifecycle_state IN ('in_progress','submitted','improve','rework','accepted') BEGIN UPDATE tasks SET started_at=COALESCE(OLD.started_at,NEW.started_at,NEW.updated_at) WHERE id=NEW.id; END;
CREATE VIEW task_readiness_current AS
 SELECT t.id task_id,t.project_id,t.assignee_id,
 CASE WHEN t.status!='done' AND t.assignee_id IS NOT NULL
 AND EXISTS(SELECT 1 FROM project_members m WHERE m.project_id=t.project_id AND m.user_id=t.assignee_id)
 AND EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id)
 AND NOT EXISTS(SELECT 1 FROM task_dependencies d JOIN tasks upstream ON upstream.id=d.depends_on_task_id WHERE d.task_id=t.id AND upstream.status!='done')
 THEN 1 ELSE 0 END ready FROM tasks t;
```
<!-- help:database:end -->

<a id="ops-backend-docs-deploy-md"></a>

# 部署说明（DEPLOY.md）

> 负责人在本地执行以下步骤创建 Cloudflare 免费资源并部署。按实际资源与供应商计费，AI 调用及超出免费额度的资源会产生费用。

## 0. 前置

```bash
cd backend
npm install
npx wrangler login        # 浏览器授权
```

## 1. 创建资源（以 staging 为例，production 同理替换后缀）

```bash
# D1 数据库
npx wrangler d1 create ai-office-db-staging
# R2 存储桶
npx wrangler r2 bucket create ai-office-files-staging
```

**AI Gateway**：Cloudflare Dashboard → AI & AI Gateway → Create Gateway，名称建议 `ai-office-staging`，记下 **Gateway ID**。

**API Token**：Dashboard → My Profile → API Tokens → Create Token，权限勾选：
- `Workers AI` → Edit（经 Gateway 调 Workers AI 模型）
- `AI Gateway` → Edit

记下 Token（只显示一次）。Account ID 在 Dashboard 首页右侧可见。

## 2. 填写 wrangler.jsonc

在 `env.staging`（及 production）中替换：

| 字段 | 填入 |
|---|---|
| `d1_databases[0].database_id` | `wrangler d1 create` 输出的 database_id |
| `vars.CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID |
| `vars.AI_GATEWAY_ID` | Gateway ID |
| `vars.ALLOWED_ORIGINS` | 前端部署域名（逗号分隔，如 `https://ai-office.pages.dev`） |

## 3. 配置 Secrets（每个环境分别执行）

```bash
npx wrangler secret put AUTH_SECRET --env staging       # 随机长字符串：openssl rand -hex 32
npx wrangler secret put ADMIN_TOKEN --env staging       # 运维管理员令牌
npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging
npx wrangler secret put RESEND_API_KEY --env staging    # 必须配置并验证发信域名
# 在 env.staging.vars / env.production.vars 中设置 EMAIL_FROM
```

## 4. 应用迁移并部署

```bash
npx wrangler d1 migrations apply DB --env staging --remote
npx wrangler deploy --env staging
```

## 5. 验证部署

```bash
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/health
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/health/deps   # d1/r2 应均为 ok
curl https://ai-office-api-staging.<subdomain>.workers.dev/api/v1/capabilities
```

## 6. 启用 AI（模型能力验证后）

模型默认 `enabled=0`（种子配置）。启用流程（PLAN 要求：未通过能力验证的模型不启用）：

```bash
# 1) 探测（中文/JSON/图片/用量字段四项检查，会发起真实模型请求）
curl -X POST https://.../api/v1/admin/ai-config/probe \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"purpose": "textEconomy"}'
# purpose 可选 textEconomy / visionEconomy / review，三类均应探测通过

# 2) 若 passed=true，写入 enabled=true 的新版本（配置只增不改）
curl -X PUT https://.../api/v1/admin/ai-config \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{ ...与 GET 返回的 config 相同..., "enabled": true, "notes": "探测通过 2026-10-xx" }'
```

正式模型（GLM 等）Key 到位后：修改配置中对应用途的 `provider/model`，重复探测 → 启用。

## 7. 前端接入

生产前端沿用 `greenbp-team-office`（预期域名 `team.greenbp.dpdns.org`）；前端 Worker 通过 **Service Binding** 绑定本 Worker（staging 服务名 `ai-office-api-staging`，production 服务名 `greenbp-team-office-backend`），`/api/*` 转发由前端 Worker 配置；`ALLOWED_ORIGINS` 需包含前端域名。契约以 `backend/openapi/openapi.json` 为准。

## 8. 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入本地密钥
npx wrangler d1 migrations apply DB --local
npm run dev                      # wrangler dev（D1/R2 本地模拟）
npm test                         # vitest（workerd 内集成测试）
npm run typecheck && npm run export:openapi
```

## 9. 回滚、备份与恢复

### 9.1 代码回滚

- `npx wrangler rollback --env staging`（或重新部署上一 commit）。
- 迁移只增不改；回滚代码不自动回滚数据库结构（README.md 5.10）。

### 9.2 备份

- 生产环境在**每次迁移前**执行：`npx wrangler d1 export DB --env production --remote --output=backup-YYYY-MM-DD.sql`（文件名日期由执行人填写）
- 本地演练（零云费用，不接触云端）：`npm run backup:drill:local`
  该脚本导出本地 D1 → 校验导出完整性（27 张表建表语句、含 INSERT、结尾完整）→ 把建表语句重排到数据之前 → 导入一个独立的本地演练库 → 查询验证行数，最后清理临时文件。

### 9.3 恢复演练步骤（云端）

1. 新建目标 D1：`npx wrangler d1 create ai-office-db-restore`。
2. 临时把 `env.staging.d1_databases[0].database_id` 指向恢复库（或用独立配置），执行：
   `npx wrangler d1 execute DB --env staging --remote --file=backup-YYYY-MM-DD.sql`
3. 用 `--command` 抽查关键表行数与最近一条材料/账本记录，确认恢复完整。
4. 校验通过后再切换正式绑定；未验证前不要覆盖生产库。
5. 记录演练时间、备份文件、执行人、抽查结果。

**已知导入注意事项**：D1 的导出席按表名交错输出建表与数据，且表间存在循环外键（`materials.current_version_id` ↔ `material_versions.material_id`），`source_versions` 的外键目标 `ai_config_versions` 建表位置靠后。直接导入会报 `no such table` 或 `FOREIGN KEY constraint failed`。正确做法是：**先全部建表、再灌数据，并在事务内使用 `PRAGMA defer_foreign_keys=TRUE;`**（本地脚本已按此实现）。

## 10. 数据保留与清理

保留策略以「可审计数据不自动删除、衍生物按期限回收」为原则。

| 数据 | 保留策略 | 实现 |
|---|---|---|
| 会话 / 验证码挑战 | 到期即删 | `cron.ts`（每分钟） |
| 隔离文件（校验失败暂存） | 按 `files.gc_after`（默认 48 小时）删除 R2 对象并置 `discarded` | `cron.ts` |
| 孤儿 R2 对象 | 只删除**数据库无引用**且上传超过 7 天的受管对象；单轮最多 200 个 | `services/gc.ts`、`LIMITS.orphanObjectGraceDays` |
| 幂等回放记录 | 仅清理 `status='completed'` 且超过 30 天的记录；**`processing` 永不自动删除**（业务可能已成功，需人工核对） | `services/gc.ts`、`LIMITS.idempotencyCompletedRetentionDays` |
| 业务与账本数据（projects / tasks / materials / events / jobs 等） | **不自动删除**，属审计与比赛留痕数据 | 无（需人工决策） |
| 模型调用快照（R2 `ai-calls/…`） | 仅当 `ai_calls` 行不存在时按孤儿回收 | `services/gc.ts` |

受管对象键（其余键一律不处理）：`ai-calls/{callId}/input.json|output.json`、`sources/{sourceVersionId}/…`、`{projectId}/{fileId}{ext}`。

手动预演：`gcOrphanObjects(env, now, { dryRun: true })` 只报告将删除的对象，不落删；回归测试见 `backend/test/25-gc-retention.test.ts`（同时断言有效对象与非受管对象不受影响）。

### 10.1 滞留幂等记录的处理（运维）

幂等键在处理中（`processing`）不会被自动删除：业务可能已经成功，只是响应记录没写进去，自动删除会导致重复副作用。

```bash
# 1) 列出滞留记录（olderThanMinutes=0 表示不过滤时长；默认 10 分钟）
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://.../api/v1/admin/idempotency/stuck?olderThanMinutes=30&limit=50"

# 2) 人工核对业务状态：该次操作是否已产生效果（材料版本、账本事件等）
#    确认「未生效」或「重试本身幂等」后，释放该键
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"idempotencyKey":"<key>","userId":"<uuid>","operation":"agent-run.adopt"}' \
  https://.../api/v1/admin/idempotency/release
```

释放后客户端可用同一幂等键重试；业务侧的自然唯一键（材料 revision、运行状态、任务 outbox）保证不会重复产生正式结果。参考回归测试 `backend/test/27-idempotency-recovery.test.ts`。

## 11. 监控与告警阈值

健康检查（不触发付费调用）：`GET /api/v1/health`、`GET /api/v1/health/deps`（D1 一次查询、R2 一次头校验）。

| 指标 | 建议阈值 | 来源 |
|---|---|---|
| 5xx 错误率 | > 1% 持续 5 分钟告警 | Worker 观测 / 日志 |
| 任务失败率 | > 10% 持续 15 分钟告警 | `jobs` 表按 `status='failed'` 聚合 |
| 任务排队时长 | p95 > 60 秒告警 | `jobs.created_at` → 首次 running |
| 长期非终态任务 | 超过 5 分钟仍 `running` 需核对（cron 每轮处理并记录） | `cron.ts` 日志 `[cron] Workflow 状态核对失败` |
| 派发重试耗尽 | 任一 job `attempts >= 5` 立即关注 | `job_outbox.last_error='dispatch_exhausted'` |
| 项目 AI 并发 | 长期处于并发上限（2）说明排队积压 | `usage_reservations.status='reserved'` |
| 隔离文件 / 孤儿对象 | 单轮 GC 删除量异常升高（远大于日常）需排查 | `cron` 日志 `[cron] 孤儿对象回收` |
| 测试运行时告警 | workerd canceled request / RPC stub | 见架构文档 7.2，属测试池收尾现象，不隐藏日志 |

日志中可检索的关键前缀：`[cron]`（维护与恢复）、`[gc]`（孤儿回收失败）、`[events]`（账本写入失败）、`[email:resend]`（投递失败）。

## 12. 当前发布状态（2026-10-07，6a1deb8）

production 后端已原地部署 AI 续跑队列屏障（版本 `385082d0`，对应 main 提交 `6a1deb8`/`0f5f87d`）：Workflow N+1 不再由 Workflow N 同步创建，而是写入 D1 pending 行后经队列 `greenbp-team-office-ai-continuations` 异步唤醒（producer 与 consumer 均为 `greenbp-team-office-backend`），队列不可用时回退分钟级 cron。本次新增的唯一云端资源是该队列；未应用任何 D1 迁移，未改动 Secrets、D1、R2、vars、域名绑定与前端 Worker。部署前 `npm run preflight:deploy -- production` 通过；部署后 `/api/v1/health`、`/health/deps`（d1/r2 均 ok）、`/capabilities` 均 200。补丁背景、应用方法与生产验收标准见 [WORKFLOW-CONTINUATION-QUEUE](#operations)。

回滚：`npx wrangler rollback --env production` 回到上一版本（08309bd 内容）。队列资源残留无害——旧版本代码不引用该绑定；队列消费幂等（仅派发 pending 且 slice 匹配的行），重复投递安全；队列暂时不可用时业务任务停为 pending 等待 cron 派发，不会判为失败。

更早状态：2026-09-30（19dedbd）完成 production Worker 命名、Service Binding 与资源字段对齐，`npm run preflight:deploy -- production` 通过；当时 staging 仍缺 EMAIL_FROM、真实 D1 ID 与 HTTPS Origin。此后的实际部署、密码认证、Turnstile、邮件投递与模型/OCR 验收以仓库各验收记录为准。

## 13. 密码身份与一次性注册码

生产设置 `AUTH_MODE=password`。先备份 D1，应用 0012 密码身份迁移，再执行仓库根目录的 `npm run bootstrap:admin:production`，最后部署后端与前端。初始化使用特权 D1 操作，不提供公开创建管理员接口。迁移新增 auth_accounts、account_invitations、auth_password_rate_limits，并将原会话标记 legacy；旧会话不再通过认证。

脚本将管理员绑定到已有目标邮箱的 user ID，保留所有项目外键；遇到邮箱歧义或用户名已被其他身份占用立即停止。设置管理员密码同时撤销其旧会话。随机密码保存在 `.local-secrets/admin-credentials.json`，不可提交、公开或写入日志。重复初始化校验既有密码并复用，无法静默轮换。管理员登录后可生成 16 位单次注册码和管理 AI 设置；ADMIN_TOKEN 仍可作为运维方式，不可发给普通成员。

密码使用 scrypt（N=32768、r=8、p=3，32 MiB 内存工作集）、随机 16 字节盐。注册码只保存 SHA256 哈希，注册与消费原子提交。登录与注册均有持久化限流。邮箱可选且不自动验证或关联旧账号；现无自助密码找回，需要管理员通过可信途径处理旧账号密码配置。

RESEND_API_KEY 和原邮件域名配置保留供未来通知使用，密码认证不依赖邮件、Turnstile 或 AUTH_ALLOWED_EMAILS。不要恢复旧验证码认证路径。AUTH_SECRET 保持原值并继续使用 Worker Secret。私有 D1 备份位于 gitignored 的 `.local-backups/`。

## 14. 未来 VPS 迁移准备（未实际部署服务器）

目标是把前端静态资产和同源 `/api/*` 代理放到 VPS，后端、D1/R2 与现有用户 ID 继续复用，不进行数据库身份体系迁移。

文件：`deploy/vps/Caddyfile`、`deploy/vps/compose.yaml`、`deploy/vps/.env.example`。镜像固定为本轮验证过的官方 Caddy digest。`docker compose config --quiet` 与容器 `caddy validate`（network none）通过；已消除格式和冗余 Host header 告警。此验证不含实际域名 TLS 颁发或上游网络联通。

准备过程：

1. 提供 Linux VPS，开放 80/443 TCP（可选 443 UDP），安装 Docker/Compose；先用测试域名验收。
2. 在本仓库执行 `npm run build`，把 `frontend/dist` 和 `deploy/vps` 按相同目录关系复制到服务器。
3. 复制 `.env.example` 为 `.env`，填写 APP_HOST 与 API_UPSTREAM_HOST；密钥继续留在 Cloudflare，VPS 不保存 Resend 或模型 key。
4. 在 VPS 的 `deploy/vps` 执行 `docker compose config --quiet`，然后 `docker compose up -d`。
5. DNS-only 指向 VPS 并验证 HTTPS，再验收同源 API、Cookie、密码登录与邀请码注册、材料和导出，最后再切换正式域名；不要关闭整个 zone 的安全设置。若正式 hostname 绑定 Worker route/Custom Domain，切换时需按实际绑定解除该 hostname，保留其它资源。
6. 代码或 DNS 回滚使用保留的 Worker 和当前 DNS 记录，不能先删除旧服务。域名变化后需重新登录，项目和材料仍由同一 D1 保存。

**切换前的 IP 限流边界：**目前 Workers 用 `CF-Connecting-IP`；经过 VPS 代理后它会变为 VPS 出口 IP，所有用户共享密码登录与注册的 IP 额度。示例 Caddy 不信任客户端注入的 IP header。正式迁移前需要设计有认证的真实 IP 传递或调整受邀小团队限流策略，不能直接信任任意 `X-Forwarded-For`。这是未完成的迁移条件，不宣称该样例已经完成线上压力验收。

线上密码派生必须实际验收：本地运行时支持 PBKDF2 600000，但生产实测仍有 100000 次上限，因此使用原生 scrypt 的 OWASP 推荐等价参数，不降低 PBKDF2 迭代数。此前已初始化的管理员可用同一凭据文件加 `--upgrade-kdf` 更新存储哈希，原密码不变且会撤销旧会话；不要在无法校验原密码时覆盖账号。

---

<a id="ops-backend-docs-agent-bridges-md"></a>

# DSH bridge protocol v1

All endpoints live under `/api/v1/agent-bridges` and retain the normal `{data,requestId}` / structured error envelopes. Browser writes use password-session cookies and the existing Origin policy. Device requests use their own Bearer capability; that capability is never accepted by generic project, file, submission or administration endpoints.

## Pairing and authorization

The device creates a cryptographically random secret before POST `/pairings`; it sends only its SHA256 hash, name and versions. Anonymous pairing is limited to 20 requests per 600 seconds per Cloudflare connecting IP via the existing D1 rate limiter. The returned browser approval URL uses the first configured HTTPS website Origin. A logged-in member chooses project scopes within ten minutes. Project IDs, device ownership and current membership are validated server-side. `/device` reports pairing state; `/device/workspaces` registers a short display label only. Absolute local paths remain on the device. Browser `/devices` lists owned devices and DELETE `/devices/{id}` revokes the capability. Device POST `/device/disconnect` revokes only its own capability. Credentials are not sessions or model API keys.

## Handoff and execution

POST `/projects/{projectId}/tasks/{taskId}/handoffs` requires `Idempotency-Key`, `expectedRevision` and `targetDeviceId`. It creates one durable checking record and reuses the project's semantic AI eligibility checker. Pending, failed, disabled, negative or stale judgments cannot dispatch. GET/list and device claim advance a completed check without another model request.

Each run stores an immutable, hashed R2 snapshot of full task/criteria, goal, latest saved standard, recursively selected prerequisite submissions and their fixed material versions, current resource text and original attachments. D1 context stamps guard versions, assignment, goal, standards, graph, current resources, source processing and original file lifecycles before claim and reviewed adoption. Active runs retain results after an edit and expose `stale:true`; direct adoption is then disabled.

POST `/device/claim` atomically claims one run per device. Claimed runs are sticky and are never reassigned after a lease or network timeout. Repeated claim returns the same run; dispatch uncertainty stays blocked until cancellation/failure is explicitly acknowledged. Queue entries expire after 24 hours. Archived/AI-disabled project queues are blocked before dispatch; active runs retain stale drafts. Events use increasing sequence IDs and reject different payloads for a repeated sequence. A run cannot switch DSH session identity. Cancel returns `cancel_requested` until the actual device acknowledgment.

After revocation or membership removal, the known device secret retains one narrow operation: POST a `cancelled` event for the exact device/owner-bound active run, matching its persisted session ID (if created). It is permitted only when cancellation was requested or the original capability is no longer valid. Sequence numbers can skip earlier uncommitted progress events. Duplicate sequence/payload is acknowledged; a different payload conflicts. This terminal acknowledgment returns only `{acknowledged:true,state:'cancelled'}`, frees the sticky slot and exposes no draft/input DTO. Reads, downloads, uploads, other events and new claims remain denied. The plugin must stop local execution, disconnect/revoke as requested, acknowledge cancellation, then remove its local credential.

Device input download endpoints authorize both the bound run and the exact fixed file/lifecycle listed in the snapshot. They do not expose generic file URLs with reusable credentials.

## Results and human adoption

The snapshot includes `artifactPolicy`: at most 20 artifacts, **50 MiB per artifact in v1**, and the existing allowed upload extensions. The bounded single-PUT bridge transport has an explicit cap; it does not change unlimited generic document/multipart uploads. The device preflights these limits before transmitting.

Artifact UUIDs, size and SHA256 define an immutable manifest. Upload reuses normal file extension, magic-byte, UTF-8 and DOCX-package validation and contributor attribution, but **does not automatically start parsing, audio, resource-index or model work**. Repeated manifest/content transfer recovers stored files without replacing bytes. Completion requires every selected file to be available and match the manifest, plus the bound DSH session. Completion saves a draft only; it never updates task state.

POST `/handoffs/{id}/adopt-and-submit` requires cookie authentication, the initiating/current assigned member, `reviewed:true` and `expectedTaskRevision`. Admission checks current task, source context, saved standard and available artifact bytes. One D1 transaction creates an immutable `ai_adoption` material version and runs the same normal submission statements used by the browser. Normal AI evaluation is queued through the existing evaluation service. Repeated adoption returns the original submission, without creating extra material versions or evaluations. Stale results remain downloadable for manual reconciliation via existing project workflows.

Migration `0053_agent_bridges.sql` is additive. No credentials, account IDs, existing task/material identities or foreign-key relationships are reset. Referenced snapshot objects remain audit data; only unreferenced bridge snapshots are eligible for ordinary orphan GC after its existing grace period.

## Reproducible checks

```powershell
npm run typecheck --prefix backend
npm run test --prefix backend -- test/131-agent-bridges.test.ts test/85-collaboration.test.ts test/80-tasks-materials.test.ts test/127-automatic-task-evaluation.test.ts test/129-task-agent-eligibility.test.ts test/25-gc-retention.test.ts
```

Tests run actual Workers D1/R2 bindings and mocked model responses, including concurrent claim, capability revocation, safe upload/checksum, fixed-input deletion, current standard, atomic adoption races, shared submission regression and GC retention. They do not assert live-model execution or production deployment.

---

<a id="ops-backend-docs-frontend-integration-md"></a>

# 前端联调指南（FRONTEND-INTEGRATION.md）

> 面向前端 AI / 前端同学。说明如何接入「补位」AI 项目办公室后端。
> 契约唯一来源：[`backend/openapi/openapi.json`](backend/openapi/openapi.json)（当前 57 条路径、77 个操作）。契约由双方共同确认，不得单方面修改。
>
> 更新日期：2026-09-30 ｜ 本地代码覆盖 PLAN 后端 API 清单中的身份、项目协作、来源/要求、任务分工、材料、AI 补位、预审/答辩、过程记录及导出接口。生产模型、真实发信和部署链路尚未完成验证，详见第 8 节。

---

## 1. 联调方式总览

后端是 Cloudflare Worker（Hono），**不返回 CORS 头**。前端有两种接法：

| 场景 | 接法 |
|---|---|
| 本地开发 | Vite dev proxy 把 `/api/*` 代理到 `http://127.0.0.1:8787`（同源，Cookie 自动携带） |
| 生产/预览 | 前端 Worker 通过 **Service Binding** 转发 `/api/*`（同进程调用，无跨域问题） |

不要尝试跨域直连后端域名（会被 Origin 白名单拒绝，也没有 CORS 响应头）。

**后端本地启动**：

```bash
cd backend
npm install
cp .dev.vars.example .dev.vars   # 本地密钥（已被 gitignore）
npm run dev                      # wrangler dev，默认 http://127.0.0.1:8787
```

**前端 Vite 代理示例**：

```ts
// vite.config.ts
export default defineConfig({
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
```

**Service Binding（生产/预览，前端 Worker 的 wrangler 配置）**：

```jsonc
// 前端 Worker wrangler.jsonc
{
  "services": [{ "binding": "API", "service": "ai-office-api-staging" }]
}
```

前端 Worker 收到 `/api/*` 后用 `env.API.fetch(request)` 原样转发即可。同时**必须把前端真实域名告知后端**加入 `ALLOWED_ORIGINS`（写请求会校验 Origin）。后端 Worker 服务名：`ai-office-api`（生产）/ `ai-office-api-staging`。

---

## 2. 统一调用约定

- Base path：`/api/v1`。完整契约见 openapi.json（也可运行中访问 `GET /api/v1/openapi.json`）。
- 成功响应：`{ "data": ..., "requestId": "<uuid>" }`，响应头带 `X-Request-Id`（前端可自带合法 UUID 透传用于链路追踪）。
- 失败响应：`{ "error": { "code", "message", "retryable", "details?" }, "requestId" }`。**请按 `code` 分流，不要按 message 匹配。**
- 参数校验失败：`400 VALIDATION_FAILED`，`details.issues = [{ path: ["字段名"], message }]`。

主要错误码：

| code | HTTP | 前端处理建议 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 跳登录（会话 7 天有效） |
| `AUTH_CHALLENGE_INVALID` | 400 | 提示验证码错误 |
| `AUTH_CHALLENGE_EXPIRED` | 410 | 重新发送验证码 |
| `AUTH_ATTEMPTS_EXCEEDED` | 429 | 锁死，须重新发起挑战 |
| `RATE_LIMITED` | 429 | 按 `details.resendAfterSeconds` 倒计时 |
| `PERMISSION_DENIED` | 403 | 非成员/角色不足/Origin 不在白名单 |
| `NOT_FOUND` | 404 | 资源不存在（项目不对外泄露存在性，非成员访问项目也返回 403，不存在的项目返回 404） |
| `VERSION_CONFLICT` | 409 | **乐观锁冲突**：`details.currentRevision` 为服务器当前版本，展示差异后带新 revision 重试 |
| `IDEMPOTENCY_CONFLICT` | 409 | 同 Idempotency-Key 不同请求体（幂等在 M4 落地） |
| `INVALID_STATE` | 409 | 状态机违规（重复确认、重复上传等） |
| `FILE_TOO_LARGE` | 413 | 超过 10 MiB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | 文件头与扩展名不符 |
| `SOURCE_PARSE_FAILED` | 422 | 解析失败（加密 PDF/超页/白名单外域名等），`details` 有原因 |
| `QUOTA_EXCEEDED` | 429 | 人数已满 / AI 并发或单次调用次数达到上限 |
| `AI_OUTPUT_INVALID` | 502 | 模型输出不可用（含伪造引用） |
| `AI_UNAVAILABLE` | 503 | 模型/邮件服务不可用，可重试 |
| `EMAIL_UNAVAILABLE` | 503 | 验证码邮件发送失败 |

鉴权：Cookie `ai_office_session`（`HttpOnly; Secure; SameSite=Lax`）。经 dev proxy / service binding 转发时 Cookie 自动流转，前端无需读取。

---

## 3. 登录流程（本地回显；部署环境使用邮件）

```ts
// 1. 请求验证码
const res = await fetch('/api/v1/auth/challenges', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'user@example.com' }),
});
// 201 → { data: { challengeId, expiresAt, resendAfterSeconds, devCode? } }
// devCode 仅在 ENV_NAME=local 且 EMAIL_MODE=echo 时返回；staging/production 不允许 echo。

// 2. 验证码换会话（用户不存在会自动注册）
const login = await fetch('/api/v1/auth/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, challengeId, code }), // code 为 6 位数字
});
// 201 → Set-Cookie + { data: { user: { id, email, displayName } } }

// 3. 读取当前用户 / 退出
await fetch('/api/v1/auth/session');                    // GET → 当前用户
await fetch('/api/v1/auth/session', { method: 'DELETE' }); // 立即撤销会话
```

限制（429 触发条件）：同邮箱 60 秒内重复请求；同 IP 每小时 10 次；验证码错 5 次锁死（410/429 需重新发起挑战）。

---

## 4. 异步任务（202 + jobId 轮询）

`/parse`、`/page-images`、`/jobs/{id}/retry` 返回 `202 { data: { jobId } }`。轮询约定（与 PLAN 一.7 一致）：

```ts
// GET /api/v1/jobs/{jobId}
// { data: { jobId, kind, status, result, error, attempts, createdAt } }
// status: queued | running | waiting_input | succeeded | failed | cancelled
// 轮询间隔 2s 起步，逐次退避至 10s；页面不可见时暂停，恢复可见时立即查一次
```

- `succeeded` → `result` 为各 kind 的产物（如 parse 任务：`{ requirementSetId, count }`）。
- `waiting_input` → `result` 说明缺什么（如 `{ needsImages: 2, message: "存在扫描页…" }`），前端继续引导用户操作后由对应接口触发续跑。
- `failed` → `error = { code, message, details }`；可重试的任务 `POST /jobs/{id}/retry` 得到**新 jobId**（旧任务已终态）。

---

## 5. 文件与来源解析端到端

### 5.1 文件上传（两步）

```ts
// 1) 初始化（服务端分配 R2 key，客户端不能指定路径）
const init = await fetch(`/api/v1/projects/${projectId}/files`, {
  method: 'POST', headers: jsonHeaders,
  body: JSON.stringify({ fileName: '通知.pdf', contentType: 'application/pdf' }),
});
// 201 → { data: { fileId, upload: { method: 'PUT', url: '/api/v1/projects/{projectId}/files/{fileId}/content' } } }

// 2) 上传二进制（按实际上传字节校验 ≤10MiB）
await fetch(init.data.upload.url, { method: 'PUT', body: fileBlob });
// 201 → { data: { fileId, sizeBytes, sha256, mimeDetected } }
// 413/415 → 文件过大 / 类型不符；下载：GET upload.url（成员可读）
```

### 5.2 导入来源并发起解析

```ts
// 导入（kind: file | paste | web）
const src = await fetch(`/api/v1/projects/${projectId}/sources`, {
  method: 'POST', headers: jsonHeaders,
  body: JSON.stringify({ kind: 'file', fileId }),   // 或 {kind:'paste', text} / {kind:'web', url}
});
// 201 → { data: { sourceId, sourceVersionId, title, ... } }

// 发起解析
const job = await fetch(`/api/v1/projects/${projectId}/sources/${sourceId}/parse`, { method: 'POST', ... , body: '{}' });
// 202 → 轮询 jobId
```

解析成功后 `result.requirementSetId` 指向**草稿要求集**（重新解析产生新草稿，不覆盖已确认内容）。

### 5.3 扫描页（无文本层）的低成本识别配合

任务进入 `waiting_input`（`result.needsImages`）后：

```ts
// 1) 取待渲染页码
GET /api/v1/projects/{projectId}/sources/{sourceId}/render-requests
// → { data: { items: [{ pageNumber }] } }

// 2) 前端用 PDF.js 渲染这些页 → 图片（长边 ≤2000px，单张 ≤2MiB，PNG/JPEG/WEBP，
//    先走 5.1 两步上传得到 fileId）

// 3) 上传页面图（绑定 sourceVersionId + pageNumber）
POST /api/v1/projects/{projectId}/sources/{sourceId}/page-images
body: { sourceVersionId, images: [{ pageNumber: 1, fileId }, { pageNumber: 2, fileId }] }
// 202 → { data: { accepted, remaining, jobId? } }
// remaining=0 时返回 OCR jobId；OCR 完成后任务继续「要求提取」，产物同 5.2
```

OCR 片段带 `needs_review=true` 标记（识别方法和待确认状态会被保留，供人工核对）。

### 5.4 要求与评分标准

```ts
GET   /api/v1/projects/{projectId}/requirement-sets?sourceVersionId=...   // 列表（含草稿与已确认）
GET   /api/v1/projects/{projectId}/requirement-sets/{setId}               // 详情：requirements[] 每条带 citations[]
PATCH /api/v1/projects/{projectId}/requirements/{requirementId}           // 人工修改 → fieldState='edited'
POST  /api/v1/projects/{projectId}/requirement-sets/{setId}/confirm       // 仅负责人；重复确认 409

GET   /api/v1/projects/{projectId}/rubrics                                // 评分标准版本列表
POST  /api/v1/projects/{projectId}/rubrics                                // 新版本草稿 {source:'official'|'custom', weights:[{key,label,weight}], notes?}
PATCH /api/v1/projects/{projectId}/rubrics/{rubricId}                     // 改草稿（负责人）
POST  /api/v1/projects/{projectId}/rubrics/{rubricId}/confirm             // 确认（负责人）
```

引用结构（每条要求）：`citations: [{ sourceVersionId, fragmentId, pageNumber, quote }]`——`quote` 是来源原文逐字片段，前端可用于「依据跳转」高亮定位。

---

## 6. 项目 / 成员 / 邀请速查

```ts
POST   /api/v1/projects                                    // {name, description?, deadlineDate?} → 创建者即负责人
GET    /api/v1/projects?status=active|archived|all&cursor=&limit=   // 我参与的，游标分页 {items, nextCursor}
GET    /api/v1/projects/{projectId}                         // 详情（含 myRole、revision）
PATCH  /api/v1/projects/{projectId}                         // 负责人；必须带 expectedRevision，409 时按 details.currentRevision 重试

GET    /api/v1/projects/{projectId}/members                 // 成员列表（skills/hoursPerWeek 供分工建议）
GET|PATCH /api/v1/projects/{projectId}/members/me           // 我的信息 / 维护技能与投入时间
DELETE /api/v1/projects/{projectId}/members/{userId}       // 负责人移除成员（不可移除自己）
DELETE /api/v1/projects/{projectId}/members/me             // 成员退出（负责人不可退出）

POST   /api/v1/projects/{projectId}/invitations            // 负责人创建 {maxUses?, expiresInDays?} → code 仅返回一次
GET    /api/v1/projects/{projectId}/invitations            // 邀请列表（负责人）
DELETE /api/v1/projects/{projectId}/invitations/{iid}      // 撤销
POST   /api/v1/invitations/accept                          // {code} → 加入项目（人数满 429）
```

被移除成员的所有后续访问立即 403（前端应处理「成员被移出」的会话内提示）。

---

## 7. /capabilities 与能力协商

`GET /api/v1/capabilities`（公开）返回文件限制、分页上限、AI 并发数、比赛模板（如五人限制——仅是建议默认值，不硬编码）。**前端所有上限从这儿读，不要写死**：

```jsonc
{
  "data": {
    "apiVersion": "v1",
    "environment": "local",
    "features": { "aiEnabled": false, "webFetch": true, "emailMode": "echo" },
    "limits": {
      "maxFileBytes": 10485760, "maxPdfPages": 30,
      "pageImageMaxEdge": 2000, "pageImageMaxBytes": 2097152,
      "listDefaultPageSize": 20, "listMaxPageSize": 100,
      "concurrentAiTasksPerProject": 2
    },
    "competitionTemplate": { "teamSizeLimit": 5 }
  }
}
```

`features.aiEnabled=false` 表示模型尚未通过能力验证（当前默认），AI 相关界面应显示「模拟/未启用」。

---

## 8. 当前实现范围与剩余事项（2026-09-29 更新）

OpenAPI 当前包含 57 条路径、77 个 HTTP 操作。除了 PLAN 原有接口，还包括项目 AI 会话列表、异步任务分工建议和单任务人工应用分工建议。任务/项目/材料等主要列表支持游标分页；分页回归已覆盖 tasks、projects、materials 和 AI 会话。

分工建议接口：

```ts
// 不传 taskIds 时处理项目全部未完成任务，单次最多 20 项。
// requirementSetId 可省略；省略时使用最新的已确认要求集（如无则不附要求）。
const started = await fetch(`/api/v1/projects/${projectId}/assignment-suggestions`, {
  method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': requestKey },
  body: JSON.stringify({ requirementSetId, taskIds }),
}); // 202 → { data: { jobId } }

// GET /api/v1/jobs/{jobId} 成功时 result：
// { requirementSetId, assignments: [{ taskId, assigneeId, reason, expectedRevision }], considerations }
// 结果只包含建议，不会自动指派或更改任务状态。

await fetch(`/api/v1/projects/${projectId}/tasks/apply-assignment`, {
  method: 'POST', headers: jsonHeaders,
  body: JSON.stringify({ taskId, assigneeId, expectedRevision }),
}); // 200 → 更新后的 Task；409 时保留现有数据并刷新任务后再确认
```

人工应用一次只处理一个任务。服务端在写入时再次检查任务 revision 和负责人当前项目成员资格，任务状态保持不变。建议请求分工建议、AI 会话、预审等创建异步任务的关键 POST 时携带 `Idempotency-Key`。该头目前落在 AI 会话创建、采纳、预审和分工建议接口。

`GET /api/v1/projects/{projectId}/export-bundle` 除材料 Markdown、任务与过程记录外，还返回 `requirementSets[]`（要求集确认态/版本、逐条要求及原文 citations）和 `rubricVersions[]`（版本、确认态、权重和备注），供成果说明导出引用。`aiUsage` 只汇总调用次数与 token 用量。

当前后端与 PLAN 的实现对齐：

| PLAN 功能 | 当前后端实现 | 联调说明 |
|---|---|---|
| 验证码身份、会话、项目/成员/邀请 | 已实现 | 本地 echo 仅用于 local；部署环境要求 Resend |
| 文件、来源导入、PDF 文本/指定扫描页、要求与评分版本 | 已实现 | 真实 PDF 样本与模型准确率尚未做线上验证 |
| 任务/评论/材料版本/Markdown 导出 | 已实现 | 乐观锁和主要列表分页有后端回归覆盖 |
| 团队分工建议与人工应用 | 已实现 | 异步建议不写任务；应用需 `expectedRevision`，一次一项 |
| 三档 AI 会话、带做回合、人工复核采纳 | 已实现 | 依赖已配置并启用的模型；失败不会自动切到演示结果 |
| 预审、答辩演练、事件/贡献/资源账本、导出包 | 已实现 | 关联和访问以服务端项目权限为准 |
| Workflow 恢复、AI 并发控制 | 部分实现 | 有异步派发、并发槽位预占和过期释放 |

尚未完成、影响真实部署的事项：

| 事项 | 状态 | 影响 |
|---|---|---|
| 真实发信（Resend） | 待验证域名和部署密钥 | 部署环境 `EMAIL_MODE=echo` 会拒绝发信；不返回真实验证码 |
| 正式模型 | 待配置并验证 Gateway/model 密钥与模型能力 | `/capabilities.features.aiEnabled` 来自 D1 配置；禁用或未配置时异步 AI job 会进入 `failed` 并携带 `AI_UNAVAILABLE`，同步能力调用可能直接返回 503 |
| staging/production 部署 | 待创建/核验 Cloudflare 资源 | 生产联调与前端 Service Binding 仍待完成 |
| 长期任务核对/压测/监控 | 未完成 | B5 不应标记完成，需真实服务联调及恢复验证 |

三档 AI 与预审/答辩的接口行为提醒：

- `POST /agent-sessions`（冻结写请求 #1）返回 `{sessionId, runId, jobId}`；草稿在会话详情的 `turns[]`（`kind='draft'`，`payload.markdown/doc`）。
- 采纳（冻结 #2）`POST /agent-runs/{runId}/adopt`：`reviewed` 必须为 `true`，`doc` 为 Tiptap JSON；产生 `origin='ai_adoption'` 的新版本；同一 run 只能采纳一次（409）。
- 预审（冻结 #3）`POST /reviews` → 轮询 jobId → `GET /reviews/{id}` 的 `report` 绑定 `materialVersionIds`，材料更新后请提示「报告针对旧版本」。
- 答辩 `POST /rehearsals` → 第一问生成中 → `answers` 逐题 → `finish` 总结；演练结束后再答题返回 409。
- AI 产物均为**草稿语义**：AI 不会改任务状态或正式材料，一切以采纳/人工确认为准。

## 9. 联调验收清单（前端视角）

- [ ] 登录→会话恢复→退出全流程（回显模式）
- [ ] 创建项目→邀请→第二个账户接受→成员列表可见
- [ ] 两步文件上传；超限/伪造类型得到 413/415 并有清晰提示
- [ ] 粘贴文本导入→解析轮询→要求草稿渲染（引用可定位）→人工编辑→负责人确认
- [ ] 扫描 PDF 流程：waiting_input→render-requests→PDF.js 渲染上传→OCR 完成
- [ ] 项目 PATCH 乐观锁：人为制造 409 并按 currentRevision 恢复
- [ ] 未实现的产品流程保持明确演示状态（不出现裸 404，也不把模拟成功伪装成生产数据）
- [ ] 所有请求/响应 `requestId` 已接入前端日志

有任何契约问题：**先提出来双方确认，不要单方面改 openapi.json 的语义**（补充字段可协商）。

---

<a id="ops-backend-docs-native-push-md"></a>

# 原生 Android FCM 推送

原生设备与 Web Push 共用 `push_subscriptions`、`notification_push_outbox`、通知偏好、事件可见性和现有定时派发入口。迁移只增加设备传输类型和原生字段，不修改既有订阅或通知历史，不增加队列或 Cron。

## 配置与账户生命周期

- 服务端可选秘密：`FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY`。私钥使用服务账户的 PKCS#8 PEM，支持真实换行和 `\n`；不得提交仓库、写入日志或打包至客户端。
- 客户端提供对应 Firebase 项目的 Android 配置，并为 `cn.buwei.mobile.nativepreview` 注册应用。缺少配置或 Google Play 服务时，应用继续使用站内通知，前台和既有后台同步负责补查。
- 登录验证后及回到前台时获取当前 FCM token，调用 `POST /api/v1/notifications/native-devices`，正文为 `{installationId, platform:"android", token}`。`installationId` 为应用本地持久化随机 UUID，不能来自用户名或硬件标识。
- token 更新后重新注册；服务端保留本安装的订阅 ID，取消旧绑定待发送事件，重新绑定当前密码会话。同 token 切换到其他账户时，旧账户绑定被禁用。
- 注销会撤销该会话绑定的全部原生设备；主动关闭安装推送可调用 `DELETE /api/v1/notifications/native-devices/{installationId}`。只能删除当前账户且当前会话拥有的设备。离线退出需立即清空本地通知和账户状态，服务端会在派发时重新校验会话。
- 原生应用请求通知权限后才展示系统通知；权限拒绝不影响站内通知。

## 传递与打开

服务端通过 Workers Web Crypto 签署 RS256 服务账户断言，兑换短时 OAuth token，再调用 FCM HTTP v1。缓存只包含 OAuth 凭据，事件权限、会话和通知偏好每次派发都重新查询。网络调用各自限时 10 秒。

FCM 仅携带 `eventId`、`userId`，使用 data-only 消息和 60 秒 TTL；不携带标题、正文、资源链接或业务内容。冷进程先恢复本机账户，再在线验证当前会话与消息账户一致后显示固定通用文案，并保存最近 256 个事件 ID 去重。回调等待最多 8 秒，避免回调返回后服务停止取消验证；离线、验证超时和本机安全存储损坏均停止展示并记录明确的应用状态，不重置凭据或把缓存账户当成已验证会话。点击通过显式 MainActivity Intent 的 `notificationEventId` / `notificationAccountId` 进入；业务层必须先验证当前会话与通知列表中的事件访问权，才能打开具体资源。

无效 token 仅在 FCM 明确返回 `UNREGISTERED` 时停用。缺失 Firebase 项目不被当成设备过期；网络失败和 429/5xx 按现有 outbox 退避策略重试。

## 验证边界

`npm test --prefix backend -- native-push.test.ts 47-notifications.test.ts` 使用真实临时生成的 RSA 密钥、模拟 OAuth/FCM 响应和测试 D1，覆盖账户切换、轮换、会话撤销、配置缺失及错误分类。测试不发送真实推送。

真实凭据、发布后的服务端、Android Firebase 配置、Google Play 服务及允许通知权限的实机，是即时通知端到端验收的前提。FCM 的送达和后台调度不保证即时性；应始终保留站内通知补查。

---

<a id="ops-backend-docs-notifications-md"></a>

# Notifications

Apply additive D1 migration `0019_notifications.sql` before publishing this backend. It creates notification history, per-user read/dismiss receipts, settings, device subscriptions and a push outbox. Existing business records are not backfilled or deleted.

All routes use the standard `{ data, requestId }` envelope and require a current password session:

- `GET /api/v1/notifications?cursor=&limit=50`: visible history, including dismissed entries, with `nextCursor` and `unreadCount` (read/dismissed entries excluded from the count)
- `POST /api/v1/notifications/{id}/read` and `/dismiss`: idempotent per-user receipts
- `GET/PUT /api/v1/notifications/settings`: `{ inAppEnabled, pushEnabled }`, both default to true; PUT accepts one or both fields and preserves omitted fields atomically; in-app preference controls presentation, while history remains available
- `GET /api/v1/notifications/push/status`: `{ configured, publicKey }`; missing configuration returns `false` and an empty public key
- `POST /api/v1/notifications/push/subscriptions`: `{ endpoint, keys: { p256dh, auth } }` → `{ id }`
- `POST /api/v1/notifications/push/lookup`: `{ endpoint }` → own active `{ id }` or `{ id: null }` (revoked/expired subscriptions are not reported as active)
- `DELETE /api/v1/notifications/push/subscriptions/{id}`: recoverably disables the owned subscription

Notification mutations accept an optional `X-Notification-Account` header. A mismatch with the current authenticated user returns 409 before any state change, preventing delayed actions started under a different account. Logout honors the same guard. Requests without the header remain compatible.

Logout accepts the optional `X-Push-Subscription-Id` header. It disables that subscription only when both its account and session match. Dispatch also refuses expired or revoked sessions, so omitted headers cannot keep logged-out session delivery active. Other devices remain registered.

Source additions, completed requirement extraction, requirement confirmation/edits, and support replies/status changes create durable generic events in the same D1 transaction as their business changes. Events do not contain source text, requirement titles, ticket titles or replies. Project events go only to members present at creation. Ticket events go to the owner/current staff, excluding the actor. Current visibility is checked again on history/read/dismiss and before each push. Newly joined members/devices do not receive old queued pushes.

System push is optional. The deployment owner must supply `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` via the approved credential setup; this change neither generates nor configures credentials. `VAPID_SUBJECT` may supply a valid `mailto:` or HTTPS contact; otherwise the first HTTPS `ALLOWED_ORIGINS` entry is used. Without configuration, new system subscriptions are rejected and no push is queued or sent; in-app history works normally.

The existing cron dispatches bounded batches. Delivery uses RFC 8291 `aes128gcm` and RFC 8292 VAPID; the public RFC encryption vector is tested. Requests only target approved HTTPS browser push providers and never follow redirects. Outbox records deduplicate event/device pairs, use leases and bounded retries, and expire after 24 hours. Provider 404/410 responses disable endpoints without deleting subscription history; the same owner can re-register. Network ambiguity can still cause delivery retries; stable notification IDs/Topic plus the service worker's account check and notification tag prevent stale-account display and visible duplication.

## Client settings and platform acceptance

Settings has separate installation and notification tabs. The first configured, authenticated startup explains system notifications; only an explicit click calls `Notification.requestPermission()`. Denied/default permission never silently becomes a subscription; dismissal is remembered per account. Browser subscription payloads contain only endpoint and keys. Installation reuses the existing one-use prompt, and installing does not automatically authorize notifications.

The client silently hydrates existing server history, then coalesces new IDs into one top toast. It polls only while visible/online, reconnects on foreground/network recovery, supports read/dismiss receipts and older-history pagination, and does not replay old history as toast after refresh. Lock-screen notifications use a generic summary without source/ticket/profile bodies. Service Worker click handling permits only same-origin app paths and delegates open-page navigation to the normal unsaved-edit guard. A device owner ID is acknowledged and stored separately from user content; messages for a previous account are suppressed. Logout revokes the current device before browser unsubscribe and session deletion, with an expected-account guard for interrupted actions.

Official platform guidance: [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [permission user gesture](https://developer.mozilla.org/en-US/docs/Web/API/Notification/requestPermission_static), [WebKit iOS/iPadOS support](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/). iOS/iPadOS 16.4+ requires a Home Screen web app. Delivery when closed depends on browser/OS background support, network, focus and battery restrictions; it is not an unconditional real-time guarantee. Without VAPID setup, client settings explicitly report background system push unavailable, while in-app/history work.

## Owner-only VAPID setup

`node backend/scripts/prepare-vapid.mjs --plan` only prints the setup plan. It creates no credentials or files and makes no network requests. The owner may explicitly run its documented `--generate --output <new-private-directory>` mode. This writes a separate application's P-256 public key and private scalar to a newly created local directory without printing or uploading the private value. The helper refuses to overwrite a directory or key file.

The owner then enters the two file values as `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the existing production backend Worker `greenbp-team-office-backend`. The private value must be entered and submitted by the owner in Cloudflare's secure interface; never paste it into chat or tickets or commit/upload the files. `VAPID_PRIVATE_KEY` is the base64url 32-byte scalar, not the older P1 base64url JWK format. An optional `VAPID_SUBJECT` is an owner contact HTTPS URL or mailto; without it the existing allowed production origin is used. Keep the private directory outside the repository. This implementation has not run generation or configured either secret.

---

<a id="ops-docs-engineering-checks-md"></a>

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

---

<a id="ops-docs-ai-gateway-byok-md"></a>

# Cloudflare AI Gateway Provider Keys

AI Gateway BYOK applies only to features whose own configuration explicitly uses Cloudflare AI Gateway, such as realtime Google transcription and Gateway-backed speech generation. For those routes, add a default Google Provider Key under Cloudflare Dashboard → AI → AI Gateway → the configured gateway → Provider Keys. The application sends its Gateway authentication token and does not send a Google API key on those requests.

Ordinary AI model settings are independent: their API URL and provider API key are configured in the application settings, and requests go directly to that provider. Gemini media summaries and MiMo media summaries also use their separately configured API URL and encrypted provider key. Configuring a default key in AI Gateway does not change these routes.

Workers AI remains a Cloudflare account service and uses the server-side Cloudflare token plus the configured Gateway ID. Its authentication is separate from third-party Provider Keys.

The realtime Gateway token is an application credential for authorizing requests to Cloudflare AI Gateway. It is not the Google model API key; store it only in the dedicated Gateway token field. Provider keys for Gateway-backed requests stay in Cloudflare and are never submitted in the application form.

---

<a id="ops-docs-ai-providers-md"></a>

# AI 供应商、协议与参数

预设不是模型可用性或套餐资格保证。管理员保存有效配置后可手动启用 AI；能力测试是可选诊断，失败或未测试不阻止启用。

## 网页配置

入口：超级管理员的「系统设置 → AI 模型接入与测试」。原有运维令牌路径保留；普通管理员和项目成员不能管理系统配置。

- 每个用途独立选择供应商、模型、完整 API URL 和协议
- 协议可手选 `chat-completions`（OpenAI Compatible）、`responses`（OpenAI Responses）、`messages`（Anthropic）和 `gemini`（Google 原生）
- 预设填入官方地址和建议模型，不自动启用或发出网络请求。已知不兼容的协议/模型组合在保存和执行时均明确拒绝
- 未收录的 OpenCode 模型可以显式选择前三种协议，但不宣称已验证，也不发送未经核实的思考参数。原生 Gemini 使用独立预设
- 自定义接口保留完整 URL、模型和原有参数；代理请使用「自定义」。不因字符串中含有某个模型名称而自动推断能力
- 思考强度默认「不发送」，遵循供应商默认值。切换模型会清理不兼容的思考/采样参数；已保存的旧配置不会在读取时被改写
- 不再提供输出上限编辑项；常用参数包含 temperature、top_p、最大输入字符、超时、JSON 输出约束和图片能力声明。参数范围与供应商/模型/思考模式联动；不支持的值会被拒绝，不能绕过前端校验
- 保存配置默认停用；只有用户明确点击「测试」才会调用真实模型，可能产生费用。测试结果仅供诊断，不作为启用门槛

### 固定输出上限

系统不保存或暴露输出上限设置。请求适配器在相应协议字段中固定发送 `65535`：Messages 使用必填的 `max_tokens`，Chat Completions 使用 `max_tokens` 或 `max_completion_tokens`，Responses 使用 `max_output_tokens`，Gemini 使用 `generationConfig.maxOutputTokens`。读取历史配置时会丢弃 `enabledOutputLimit` 和 `maxOutputTokens`；单次任务不能覆盖。

供应商或模型自身的最大输出可能低于 `65535`；这时供应商仍可能拒绝请求或提前截断。模型思考 token 与正文共同占输出预算。固定上限不改变原有并发和重试保护。

## 已接入协议与预设

| 供应商 | 传输 | 鉴权/结构化输出 |
| --- | --- | --- |
| OpenAI | Chat Completions 或 Responses，独立手选 | Bearer；Chat `response_format`，Responses `text.format` |
| Anthropic Claude | Messages | `x-api-key` + `anthropic-version: 2023-06-01`；当前使用 JSON 提示及业务 schema 验证，不伪造 OpenAI response_format |
| Google Gemini | `models/{model}:generateContent` | `x-goog-api-key`；`generationConfig.responseMimeType` |
| DeepSeek | Chat Completions | Bearer；JSON 模式可选 |
| OpenRouter | Chat Completions | Bearer；请求 `provider.require_parameters=true`，防止供应商静默忽略指定参数 |
| OpenCode Zen | 根据模型支持 Chat / Responses / Messages | Chat/Responses 为 Bearer，Messages 为 x-api-key |
| OpenCode Go | 根据模型支持 Chat / Responses / Messages | 专用请求头配置及用途确认，详见下节 |
| Workers AI | 保留原 Chat Completions 路径 | 保留 Cloudflare Gateway 头、现有绑定与运维密钥 |
| 自定义 | 默认保留原 Chat；可显式选其他已实现协议 | 按所选协议构造鉴权，不提供任意 header/body 穿透 |

Go 与 Zen 的模型协议不能混用。例如 MiniMax M3 和 Qwen3.8 Max 在 Go 使用 Messages，在 Zen 使用 Chat；Go GPT 6 Luna 使用 Responses，GLM-5.2 使用 Chat。模型 ID/协议表集中在 `shared/ai-providers.ts`，供前后端共同使用。模型列表是截至 2026-10-01 核对的提示列表，不是账户实际拥有的目录。

## 思考参数覆盖

- OpenAI：精确识别 GPT-5/mini/nano、GPT-5.1、GPT-5.2、GPT-5.4、o3/o4-mini 的已核实取值；不把 Codex 或未知后缀盲目归入同一类
- OpenAI Chat 使用 `reasoning_effort` 和 `max_completion_tokens`；Responses 使用 `reasoning.effort` 和 `max_output_tokens`
- GPT-5.1/5.2/5.4 仅在显式 `none` 时开放采样参数；GPT-5 原版和 o 系列不发送这些采样参数
- DeepSeek `deepseek-flash`、V4 Pro、V4.1 Flash、V4 Flash、V4 Flash Vision Exp：Chat `none/low/high/max`，`none` 映射为 `thinking: {type: "disabled"}`，其余档位发送 `reasoning_effort`；Anthropic Messages 的 V4 Pro 与 `deepseek-flash` 提供 `low/high/max` 并映射 `output_config.effort`。默认不发送时沿用供应商默认开启的 high 思考。非思考模式才允许 temperature；思考模式才允许 `top_p ≥ 0.95`
- DeepSeek 思考 token 和正文共同占用最大输出 token。达到 `finish_reason=length` 时提示精简任务或降低思考强度，不自动重放失败请求。超时与未收到 HTTP 响应的网络失败分别显示，不把它们误报成密钥或模型不支持
- OpenRouter：只对公开模型元数据明确列出档位的 `openai/gpt-5` 暴露 `minimal/low/medium/high`，映射为嵌套 `reasoning.effort`。o3/o4-mini 元数据未列出档位，保持省略
- Gemini `gemini-3.8-flash`：`low/medium/high` 映射为 `generationConfig.thinkingConfig.thinkingLevel`。2.5 的 numeric thinkingBudget 暂不开放。Gemini 3.x 采样参数依官方建议保持默认（并非 API 不接受这些字段）
- OpenCode Go/Zen 的 GPT-5.6 Luna、GPT-6 Luna：`none/low/medium/high/xhigh/max`；Grok 4.5：`low/medium/high`；Grok 4.6/4.7：`low/medium/high/xhigh`；DeepSeek V4 Pro：`none/low/high/max`。DeepSeek Chat 的 `none` 使用 `thinking.type=disabled`
- Claude `claude-sonnet-5-5`：`low/medium/high/xhigh/max` 映射 `output_config.effort`；默认 adaptive thinking，不发送猜测的 off/disabled 开关。其他未核实的 Claude/Go/Zen 模型参数保持默认，不猜测可用档位；仍可调整文本长度和超时

## OpenCode Go 请求头

官方说明 Go 面向编码代理请求。本应用同时包含非编码的项目写作、分工和验收；诚实协议/header 适配不等于套餐适用或官方认证。管理员需核对自己的套餐允许此用途，确认后才可保存 Go 配置。

独立面板仅允许配置：

- `User-Agent`：默认 `AI-Collaboration-Seminar/1.0`，可改为实际应用名称/版本；不允许控制字符或模拟 OpenCode、Codex、Claude 等客户端身份
- `x-opencode-session`：默认自动生成稳定的不透明会话标识；可加最多 32 位非敏感前缀。不能填写密钥或用户资料

稳定性：AI 引导使用原会话 ID；答辩使用答辩 ID；OCR/要求提取使用来源版本 ID；其他任务使用冻结 job ID；一次探测的多个请求共享同一个随机探测会话。所有修复重试保留原 ID，不通过轮换身份、改变认证或自动换供应商处理 401/403。

鉴权由后端从加密密钥构造，面板不接受 Authorization、x-api-key、Cookie、Host 或任意键值请求头。Go Messages 用 x-api-key，Chat/Responses 用 Bearer。专用头不流向其他供应商。没有自定义 session ID 输入框，避免多个用户误用同一个固定会话。

## 密钥、版本与请求边界

- 原有 AES-GCM 密钥加密保留；GET 仅返回 keyConfigured。明文 key 仅存在输入框和保存请求，保存成功即清空，不写浏览器存储
- 更换供应商或自定义 URL 时必须重填/清除密钥，不能自动将旧 key 发到新目标。相同已核实官方预设下的模型/协议路径可复用该供应商密钥
- 预设使用精确官方地址；自定义地址仍要求公开 HTTPS、无用户信息/查询/片段，禁止直接本机/内网主机名与 IP。仅 local 可用回环 HTTP，并同样禁止 URL 凭据/查询
- 禁止重定向；HTTP 错误只显示状态，不暴露供应商原始错误体。网络错误不返回底层 err.message，避免运行时泄露 URL/头
- 该策略是 URL 语法检查，不进行 DNS 固定/重绑定防护。自托管部署必须同时限制网络出口，不能把语法检查当作完整 SSRF 保护
- 新增字段为可选 JSON 属性，不需要数据库迁移。旧 provider 字符串、旧自定义地址和冻结配置仍走原 Chat 行为
- 新建的独立文件总结（包括手动单独重试）冻结创建时当前已启用的配置。来源正文和要求仍保留原冻结配置，摘要重试不重复解析正文或要求。已有摘要任务继续使用其创建时的冻结版本。
- 任务继续冻结配置版本（含协议、思考参数、输出开关和安全头）。修改任何参数都会使探测证据失效；已排队任务不读取新配置覆盖冻结版本
- 调用次数预占、并发限制与任务恢复语义独立工作。对 401/403 等不可重试服务错误不再发出无意义的修复请求；输出 schema 失败/可重试网络错误仍受调用次数上限限制
- 不能假设所有兼容接口的 `max_tokens` 都包含思考 token。协议适配器只记录可用的 token 用量
- 原生 OpenAI 输出 token 含思考；Claude 输入总量合并普通/缓存读/缓存写，输出不重复添加 thinking；Gemini 输出合并 candidates+thoughts，输入不重复加缓存
- 通用 Responses/Messages/Gemini 调用中，未完成、拒绝、工具调用或被过滤结果不会作为完成成果接受。项目工具流程另有明确白名单，服务器验证用户与项目权限后才执行文件工具或供应商原生搜索

## 验证与未验证

测试全部使用假密钥、本地 D1/R2 和模拟 fetch。`21-provider-adapters.test.ts` 断言实际发出 URL、header、body、OCR 转换、用量归一、拒绝/未完成输出、选项白名单、密钥屏蔽、冻结版本、Go 会话稳定性和两次调用上限。

来源解析（含 OCR）、AI do/guide/review、分工建议、预审、答辩、协作分解/自动分工/成果验收测试均额外使用 Go fixture，断言实际专用 header、JSON 开关和调用额度行为。原有 Workers/自定义配置另有回归测试。前端测试覆盖手动协议、请求头、保存/读取/密钥清空、能力切换与权限。

`scripts/verify-ai-provider-ui.cjs` 为仅 loopback、全部 API 拦截的浏览器场景。当前云容器 Chromium 在创建本地 socket 时遇到 EPERM（已在允许的提升模式重试，结果一致），因此本次未完成真实浏览器截图/布局验收，不能把 React 测试等同于视觉通过。

真实提供方授权、套餐资格、模型质量/OCR质量和线上部署均未验证，也未自动调用。

## 核对来源

- [OpenCode Go 使用与端点](https://opencode.ai/docs/go/)
- [OpenCode Zen 端点](https://opencode.ai/docs/zen/#endpoints)
- [Go Messages 官方路由](https://github.com/anomalyco/opencode/blob/dev/packages/console/app/src/routes/zen/go/v1/messages.ts)
- [OpenAI GPT-5 参数](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5)、[GPT-5.1](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.1)、[GPT-5.2](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)、[GPT-5.4](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.4)
- [GPT-5.6 Luna 思考等级](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[GPT-6 Luna 思考等级](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI Chat 输出参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses 输出参数](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Responses 类型](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/response.py)
- [Claude 思考强度](https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-sonnet-55)、[Claude Messages](https://platform.claude.com/docs/en/api/messages/create)、[模型 ID](https://platform.claude.com/docs/en/models/overview)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[思考参数](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[用量语义](https://ai.google.dev/api/generate-content#UsageMetadata)
- [DeepSeek Chat API](https://api-docs.deepseek.com/api/create-chat-completion/)、[DeepSeek 思考模式与 effort 映射](https://api-docs.deepseek.com/guides/thinking_mode/)、[V4 模型与别名](https://api-docs.deepseek.com/news/news260424/)、[V4.1 Flash](https://api-docs.deepseek.com/news/news260910/)
- [DeepSeek 思考模式与 effort 映射](https://api-docs.deepseek.com/guides/thinking_mode/)、[Grok 思考参数](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [OpenRouter 思考参数](https://github.com/OpenRouterTeam/docs/blob/main/guides/best-practices/reasoning-tokens.mdx)、[公开模型元数据](https://openrouter.ai/api/v1/models)


## P2 项目文件工具与原生搜索

项目助手和负责人任务拆分/调整可使用 `list_project_files` 与 `read_project_file`。服务器限定当前项目和当前用户权限，文件列表每页20项，读取正文或已保存总结每次最多6000字符；无已提取正文或已保存总结时明确返回不可用，不自动创建 OCR/总结付费任务。工具返回均视为不可信数据，记录有界元数据和来源，不返回 R2 对象路径或凭据。文件工具排除回收状态，动态读取冻结文件/来源生命周期到任务输入，后续请求、写回与任务建议采纳使用同一原子校验；删除再恢复不能复用旧快照，恢复也不会自动调用模型。最多4轮模型请求、8次本地工具执行，原生搜索最多增加1次请求；无自动整轮修复重试，调用前预占最多5次模型调用。

搜索默认使用已配置模型提供方的服务。用户本轮必须开启搜索并填写可公开查询，工具仅接受与该查询逐字相同的参数。提供商的搜索请求单独构造，不传项目正文、成员资料或工具历史。未收到供应商搜索执行证据及可核对的 HTTPS 来源时，不接受“已联网”结果；不回落新搜索供应商，不安装服务或增加密钥。

| 预设/协议 | 当前适配策略 |
| --- | --- |
| OpenAI Responses | `web_search`，单次 hosted tool 上限，记录来源；排除已知不支持的 nano 模型 |
| Anthropic Messages | 基础 `web_search_20250305`，`max_uses: 1`；不启用动态过滤/代码执行工具 |
| Gemini | 单独 Google Search grounding 请求后返回本地工具结果，不混合 function 与 Google Search 的协议约束；实际查询数按用量记录 |
| OpenRouter Chat | 强制 `engine: native`，不使用默认第三方回落；不支持时失败 |
| DeepSeek Anthropic 兼容 | 预设完整 URL `https://api.deepseek.com/anthropic/v1/messages`；基础 Web Search 请求与返回只通过 fixtures，真实参数兼容性/引用格式尚未验证，界面明确标注 |
| DeepSeek Chat/Responses、Workers AI、OpenCode Go/Zen、自定义 | 没有已核实的原生服务适配，明确不可用 |

供应商模型/协议仍可手动选择；错误或未知能力不会被猜测成联网成功。DeepSeek 兼容预设不修改任何已保存配置，不自动测试。保留供应商返回的 token 和搜索用量字段。

模拟契约覆盖四种协议、本地工具继续对话、权限变化、跨项目拒绝、公开查询授权、供应商搜索证据/错误和实际来源链接。真实供应商请求尚未验证。

参考官方文档：[OpenAI Web Search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Anthropic Web Search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool)、[Gemini Google Search](https://ai.google.dev/gemini-api/docs/google-search)、[OpenRouter native search](https://openrouter.ai/docs/guides/features/plugins/web-search)、[DeepSeek Anthropic 兼容](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api/)、[DeepSeek Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/)。

---

<a id="ops-docs-file-recycle-lifecycle-md"></a>

# 项目资料回收站与处理生命周期

## 使用与权限

“项目资料”中的文件库显示已保存、校验失败以及尚未完成上传的文件。文件移入回收站前有确认提示；负责人可管理项目文件，成员仅可删除/恢复自己上传的文件。普通/超级管理员的账户等级不扩大项目成员权限。粘贴与网页来源由负责人或创建者管理。

删除是可恢复的状态变更，不删除 D1 原行、R2 原文件、正文片段、要求集、材料版本、附件与引用历史，也没有永久清空入口。文件或来源恢复不会发起解析、OCR、要求提取或总结；已取消任务保持终态。人工再次开始处理会重新检查 AI 能力和项目权限。

相关来源当前及历史版本使用的原文件或 OCR 页图被回收时，来源一并隐藏。恢复依赖文件时，只有全部关联原文件/页图均退出回收站才恢复来源。已有引用仍展示原句/历史，并标记来源不可用；材料历史保留附件名称与 ID。

## API 和并发契约

- GET /api/v1/projects/{projectId}/files?deleted=false|true：分页文件库/回收站，包含 pending 上传，服务端返回 canDelete 与 lifecycleVersion
- DELETE files/{fileId}、POST files/{fileId}/restore：JSON {expectedLifecycleVersion}，返回受影响 source IDs
- GET sources?deleted=false|true：活动/回收来源；文件来源通过文件库管理
- DELETE sources/{sourceId}、POST sources/{sourceId}/restore：同一 CAS，只适用于粘贴/网页
- 删除与恢复分别递增 files.lifecycle_version 和所有受影响 sources.lifecycle_version，过期操作返回 409，原文件下载与来源操作在回收状态返回 404

0022_file_recycle.sql 仅添加软删除与生命周期字段/索引，无生产删除或现有内容改写。迁移后先发布后端，再发布前端。现有垃圾回收保留带数据库引用的回收对象；回收文件清空 gc_after，避免校验失败的原文件随后被既有隔离回收删除。

## 与其他来源工具的接入契约

来源版本 UUID 标识内容版本，不能独自证明资料仍可使用。新的工具读取、模型请求、异步结果和采纳应冻结 sourceLifecycleVersion，并在真正调用前/写入时核对：项目范围、sources.deleted_at IS NULL、来源生命周期一致、原文件 available 且未删除。可复用 backend/src/services/source-lifecycle.ts 及 source-inputs.ts。

createJobAndDispatch 冻结生命周期并在同一 D1 batch 中条件创建 job/outbox。删除原子取消 queued/running/waiting_input 任务并终止 outbox 派发；已开始的外部请求无法撤回。token 用量和调用状态保留为审计记录。所有解析、OCR、要求/总结阶段在调用与写入两端有生命周期及任务终态防线。解析输出采用生命周期版本化 R2 key，旧在途输出不覆盖恢复后的正文；历史片段不删除。

协作/项目 AI、要求驱动的分工与评审冻结来源生命周期；删除后禁止作为新输入，删除再恢复也不能复活原快照。已有材料正文和已确认人工工作继续保留。今后合入本地项目创建向导/文件工具草稿时应使用同一契约，不能只查版本 UUID 或客户端 canDelete。

## 验证边界

自动化验证使用本地 D1/R2 和受控模型 fixture，不创建生产测试项目、不删除生产资料、不调用付费模型。已有 in-flight 供应商调用仍可能产生费用，这是无法撤销的外部事实。

2026-10-02 本轮最终验证：后端 54 文件 / 537 测试、前端 60 文件 / 325 测试通过；双端类型检查、前端 lint/生产构建、Service Binding 验证、production 静态预检通过。后端全量测试以 --maxWorkers=2 重跑，默认并行曾被内存限制终止；既有 workerd/Workflow 收尾 RPC、DNS 告警仍在。提供 scripts/verify-file-recycle-ui.cjs 的 loopback-only 页面 fixture，但当前云端 Chromium 因 socket EPERM 无法启动，浏览器截图/视觉验收未完成。测试与脚本不调用生产业务或真实付费模型。

---

<a id="ops-docs-dsh-bridge-md"></a>

# 本地 DSH 桥接器

桥接器是独立的 DSH 官方插件格式包，网站使用现有 Workers、D1 和 R2。无需修改 DSH 本体、开放本机端口或另行配置模型密钥。

## 用户操作

1. 在 DSH 插件管理器安装 `https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.1.tgz`，启用补位桥接器。
2. 在下方“已安装”区域点击 `@greenbeanpie/dsh-team-office-bridge` 条目，在详情页点击“连接网站”，登录并确认设备及授权项目，然后返回 DSH 为项目选择一次本地目录。
3. 正确配置后保持 DSH 打开，启动及网络恢复时会自动连接，无需在任务页面连接。任务保存后网站自动检查 AI 适用性，在网站任务的“AI 辅助 → 代实施”中主动点击执行；不适合、判断失效或失败时禁止投递。成果自动回传为草稿，用户核对后点击“采纳并提交验收”。DSH 的原生权限审批仍需按其配置确认。

网站“设置 → 本地 Agent”可以查看安装方法、连接及目录绑定状态、管理项目授权、设定当前账号的项目默认设备和撤销连接。修改本地目录需在 DSH 桥接器设置中重新打开原生目录选择器。自动连接不会自行派发任务，多个设备未设默认时在“代实施”中选择。取消项目授权会阻止排队交接并要求活动交接停止；回传和读取接口立即重新检查授权。关闭 DSH 时任务等待设备上线；目录只在本机保存，网站只接收显示名称。

## 执行与恢复

设备主动 HTTPS 轮询，默认 5 秒，故障退避至 60 秒。每台设备串行执行，服务端还限制一个任务只能有一个活动执行。固定上下文快照包含任务、目标、当前标准、前置任务的固定成果版本、资料正文和原始附件。原始附件流式下载并核对声明大小与 SHA256。

插件在投递前持久化执行日志，使用固定会话及请求 ID。受理状态无法确认时停止并显示执行状态不确定，不自动重放。取消与撤销必须等本地执行实际停止后才能释放活动执行位置。重启不能自动恢复或重投未结束的旧会话。

只上传执行目录 `outputs` 内显式登记的成果，拒绝越界、链接、密钥文件和不允许的扩展名。v1 回传最多 20 个成果，每个 50 MiB；这个限制不影响项目原始附件的流式下载或既有通用上传。成果不自动触发解析、音频或索引任务。采纳时重新核对任务和上下文版本，变化后保留草稿但禁用直接采纳。重复采纳返回同一份提交。

## 验证与兼容

2026-10-04 核对官方源码 HEAD `5badb15009ae1756c3afe0ae0cef1faafc290ccc`，公开 API 比较版本为 `0.2.1-alpha.1`。实际启动验证使用安装的 Desktop `0.2.0-rc.2`。缺少必要公开服务时插件拒绝连接。DSH 尚处开发预览，升级应重新进行宿主验收。

```powershell
npm run typecheck
npm run lint
npm run test:backend
npm run test:frontend
npm run build
npm test --prefix packages/dsh-team-office-bridge
npm run smoke:host --prefix packages/dsh-team-office-bridge
```

`scripts/verify-dsh-bridge-local.mjs` 使用独立本地 Wrangler D1/R2 状态和真实插件 runner，DSH adapter 与适用性判定为显式 fixture。`smoke:host` 使用真实 RC2 会话、内置 DeepSeek provider 连接本地 SSE fixture，验证 prompt、专属成果工具、正常结束和草稿状态，不调用付费模型。原生目录选择点击、真实模型的任务完成质量和最新版源码的完整运行兼容性需另外验收。

协议、授权与迁移说明见 `README.md`；插件源码、安装方法与宿主测试位于 `packages/dsh-team-office-bridge`。迁移 `0053_agent_bridges.sql` 只增加桥接表与索引。部署先记录 D1 Time Travel 恢复点，再仅应用未执行的新增迁移，依次发布后端与含固定版本插件包的前端。

---

<a id="ops-desktop-readme-md"></a>

# 补位客户端

## Windows

客户端使用系统 Evergreen WebView2，连接既有线上服务。安装包为 Windows 10/11 x64 的当前用户 NSIS 安装，无开机启动。安装器在缺少 WebView2 时安装共享运行时。

Windows 和 Android 0.1.1 起先显示随安装包携带的启动页，再打开既有服务地址。服务地址、WebView 数据目录、Cookie 和 IndexedDB 均延续原版本。启动始终尝试原地址，允许其 Service Worker 在离线时提供已缓存页面；不以网络预检阻挡离线启动。20 秒内没有完成网页客户端握手时，返回本机恢复页，提供重试和恢复网络后的自动重试。首次安装离线时可看到恢复说明，但尚未下载的项目和首次登录仍需网络。本机启动页仅能调用固定地址的打开命令，不能读取账号、附件或录制数据。

## 可复现构建

启动参数 `--tray` 可直接进入托盘，网页完成兼容性和保存握手后再挂起 WebView2。它不会启用开机启动。资源与验收边界见 [Windows 客户端验收记录](#operations)。

Windows 上安装 Node.js 22+、稳定版 Rust MSVC 工具链、Visual Studio C++ Build Tools 和 Windows SDK。桌面工程使用 `npm ci` 和 Cargo.lock 固定依赖。

```powershell
./desktop/scripts/build.ps1 -SigningKeyPath C:/private/desktop-updater.key
# 仅用于本机调试、不生成可发布更新：
./desktop/scripts/build.ps1 -Unsigned
```

产物位于 `desktop/src-tauri/target/release/bundle/nsis/`。更新版本须同时更新 Tauri 配置、Cargo 包及 lockfile、desktop npm 包及 lockfile 版本；Android versionCode 由 Tauri 版本派生。发布前运行 `cargo test --locked`、`cargo clippy -- -D warnings`、前端 typecheck/lint/test/build，以及 `node --test desktop/scripts/bootstrap.test.mjs desktop/scripts/release-manifest.test.mjs`。

## 密钥与草稿发布

第一次生成：`npm run tauri -- signer generate -w C:/private/desktop-updater.key`。只把 `.pub` 公钥写入 updater 配置。私钥及密码存安全保管库；本机仓库内仅允许忽略的 `.local-secrets/`，用 `git check-ignore` 验证，永不输出或提交私钥。丢失密钥会导致既有安装无法接受后续更新。

```powershell
./desktop/scripts/publish-draft.ps1 -Installer ./desktop/src-tauri/target/release/bundle/nsis/补位_0.1.0_x64-setup.exe -NotesFile ./release-notes.md
```

脚本生成 `latest.json`，仅创建 `desktop-vVERSION` 草稿 Release。公开仓库 `greenbeanpie/AI-Collaboration-Seminar` 的正式 Release 发布后才会被 `releases/latest/download/latest.json` 发现；仅标为 prerelease 的版本不会进入该更新通道。不要将其他产品 Release 设为 latest 而缺少该清单。0.1.1 更新清单的安装器 URL 保留旧仓库名称的 GitHub 重定向，以兼容 0.1.0 的 URL 校验；新版接受新旧仓库名称，配置与发布 API 使用当前名称。

GitHub Actions 手动运行 `Windows desktop draft release`。配置受保护的 `desktop-release` environment，添加 `TAURI_SIGNING_PRIVATE_KEY`（私钥内容）、`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，限制可发布分支并设置审阅者。首次本机密钥的公钥必须与 CI 私钥匹配。CI 永远仅生成草稿；验收后再由维护者发布。

更新签名保证产物完整性；它与 Windows Authenticode 证书不同。未配置 Authenticode 时 Windows 可能显示未知发布者，本项目不得将更新签名称为 Windows 发布者签名。

## 更新行为与验收

原生启动和每 6 小时检查固定 GitHub HTTPS 地址；下载使用插件验签，验证后的安装包缓存于应用数据目录，等待期间释放下载缓冲。应用重启后重新检查版本和签名匹配的缓存；执行安装前再次验签。网页无 updater 插件直接权限。手动和自动安装均由桌面壳检查版本握手、保存确认与传输状态。自动重启偏好跨重启保留，默认启用。

两版本验收必须在可恢复的 Windows 测试用户或虚拟机中完成：安装版本 A，登录并保存离线编辑及待上传附件；构建版本 B（相同公钥）；用受控测试更新端点或发布候选版本检查 B；验证使用中不重启、托盘安全空闲 5 分钟才重启、关闭自动重启后仅手动重启。检查升级后 Cookie、IndexedDB、附件清单与文件完整保留。分别篡改签名、缓存安装包以及断网，确认失败不运行安装器、原版本仍可启动。更新下载后重启 A，重新检查后应复用完整缓存。未执行这些实机步骤时不得宣称升级验收通过。

### 独立测试安装的双版本升级

`update-smoke-build.ps1` 生成名称为「补位测试」、数据标识为 `cn.buwei.desktop.smoke` 的 Debug NSIS 安装包，避免覆盖正式客户端。仅 Debug 编译且编译时 `BUWEI_DESKTOP_SMOKE=1` 才接受固定 `http://127.0.0.1:5173/latest.json` 与该端口 `/updates/*.exe`，仍验证相同公钥和每份安装包签名。Release 编译始终只接受正式 GitHub 地址。

```powershell
./desktop/scripts/update-smoke-build.ps1 -Version 0.1.0 -SigningKeyPath ./.local-secrets/desktop-updater.key
# 将 A 的安装包、签名复制到私有验收输出目录，安装并保存测试数据后再构建 B。
./desktop/scripts/update-smoke-build.ps1 -Version 0.1.1 -SigningKeyPath ./.local-secrets/desktop-updater.key
node ./desktop/scripts/update-smoke-server.mjs ./desktop/src-tauri/target/debug/bundle/nsis/补位测试_0.1.1_x64-setup.exe
```

独立更新服务器只提供更新路由；完整界面验收应在附件 smoke server 挂载 `createUpdateSmokeHandler`，通过 `BUWEI_SMOKE_INSTALLER` 指定 B 安装包、`BUWEI_SMOKE_UPDATE_VERSION=0.1.1` 指定版本，以及可选 `BUWEI_SMOKE_SIGNATURE` 指定故意损坏的签名。不能同时启动两个占用 5173 的服务器。

验收顺序：安装 A，保存登录 Cookie、离线编辑及附件缓存清单；启动共享 fixture，确认状态 `ready`/版本 B；先篡改缓存 `updates/installer.bin`，手动“重启更新”必须拒绝安装；再次检查会重新下载完整签名包；恢复安全保存握手后手动“重启更新”执行实际 B NSIS 安装。重新打开客户端后检查版本 B，及原 Cookie、IndexedDB 编辑和缓存文件哈希保持一致。手动安装复用自动安装同一保存握手，但不能替代托盘 5 分钟自动触发测试。

已安装 A 并启动共享 fixture 后，可以仅通过 CLI 与原始 CDP `Runtime`/`Network` API 执行上述安装验收：`node desktop/scripts/update-smoke-verify.mjs`。脚本没有点击、截图或系统窗口控制；断开调试连接后等待 NSIS 自动安装并重启 B，输出 `output/desktop-smoke/update-smoke-report.json`。先运行附件缓存测试准备真实缓存文件。升级检测包含签名篡改拒绝、脏数据保存拒绝、账号 B 的持久 HttpOnly Cookie、localStorage/IndexedDB 标记、缓存清单及文件哈希、自动重启偏好。测试 fixture 的 IndexedDB 标记不能代替正式前端离线业务队列的完整验收。

## 资源测量

在相同测试用户、项目和 WebView2 版本下，分别测量启动耗时、安装包大小和前台空闲/项目页面/托盘/单文件传输。每个场景稳定 30 秒后采样 60 秒：

```powershell
./desktop/scripts/measure-resources.ps1 -RootProcessId 1234 -Scenario tray -Seconds 60 -OutputPath tray.csv
```

脚本每秒重新发现完整进程树，将宿主与所有 WebView2 子进程的工作集、私有内存及机器总 CPU 百分比累加。CPU 第一帧无基线，不参与汇总。Edge PWA 应在独立 Edge 会话中运行，用该会话浏览器根 PID 测量，避免遗漏兄弟进程或纳入日常浏览页面。工作集可能包含共享页，私有内存同时报告。报告记录硬件、系统/运行时版本、场景和观测值，不承诺固定内存上限。

## Android

Android 8+ 的 ARM64 与 x86_64 APK 构建及签名：`pwsh -File desktop/scripts/build-android.ps1`（从仓库根目录运行）。环境和稳定版本见 [ANDROID-DEPENDENCIES.md](#ops-desktop-android-dependencies-md)，功能、验证和限制见 [Android 验收报告](#operations)。

原生启动页和传输代码的更新必须重建安装包；网页 Worker 部署只能更新共享网页与 PWA。Windows 发布签名安装器、签名文件与 `latest.json` 后，旧客户端由 updater 获取新版本。Android 暂无自动安装更新，需分发具有同一 application ID、同一签名密钥、更高 versionCode 的 APK，由用户安装覆盖更新。独立 worktree 构建务必显式指定既有的 `-SigningKeyPath` / `-SigningDirectory`，不能生成替代密钥。

### 启动恢复验收

`desktop/scripts/startup-smoke.mjs` 通过真实 Windows WebView2 / Tauri 桥接验证无服务时的 20 秒恢复、本机页无法读取附件状态、恢复后重试、远程页无法调用启动命令，以及远程 Service Worker 缓存启动不会误回退。测试只使用 Debug 固定 loopback；运行前以独立标识构建和启动 Debug exe（不需安装）：

```powershell
$env:BUWEI_DESKTOP_SMOKE = '1'
$env:BUWEI_DESKTOP_DEV_ORIGIN = '1'
$env:TAURI_CONFIG = '{"identifier":"cn.buwei.desktop.startup-audit","app":{"security":{"capabilities":["bootstrap",{"identifier":"main-startup-audit","windows":["main"],"local":false,"remote":{"urls":["http://127.0.0.1:5173/*"]},"permissions":["desktop-commands"]}]}}}'
# 每次使用新的测试标识，以真实覆盖尚未缓存页面的首次启动，不清除既有数据。
$env:TAURI_CONFIG = $env:TAURI_CONFIG.Replace('cn.buwei.desktop.startup-audit', 'cn.buwei.desktop.startup-audit-' + [Guid]::NewGuid().ToString('N'))
cargo build --locked --manifest-path desktop/src-tauri/Cargo.toml --features tauri/custom-protocol
Start-Process desktop/src-tauri/target/debug/buwei-desktop.exe -WindowStyle Hidden
node desktop/scripts/startup-smoke.mjs
# 构建正式包前恢复上述三个进程环境变量。
```

运行时端口 5173、9223 必须空闲。报告和截图写入忽略的 `output/native-startup/`。此测试不替代正式安装/升级、真实账号登录、Android 设备或完整业务离线数据验收。

---

<a id="ops-desktop-android-dependencies-md"></a>

# Android 构建依赖（2026-10-06）

复用 `D:\Android\Sdk` 的 Command-line Tools 23、Platform 37.0 revision 2、Build Tools 37.0.0、NDK r30 `30.0.16248370`，以及 Android Studio JBR 25.0.3。所有脚本只设置进程环境，结束后恢复；不改变全局默认值。

稳定版固定：Tauri CLI / Rust 2.12.1（Cargo.lock）、AGP 9.4.1、Gradle 9.8.0（wrapper 下载 SHA256 校验）、Kotlin 2.4.20。AndroidX WebKit 1.17.1、Activity 1.13.0、AppCompat 1.7.1、Lifecycle 2.10.0、Material 1.14.0。版本来源：Google Maven metadata、Kotlin 官方版本记录、Gradle 官方 current API；排除预发布版本。

- [AGP 9.4 官方兼容表](https://developer.android.com/build/releases/agp-9-4-0-release-notes)：SDK37、Gradle 最低9.6。
- [Gradle 官方稳定版信息](https://services.gradle.org/versions/current)：9.8.0，Java25 可运行。
- [Kotlin 官方版本记录](https://kotlinlang.org/docs/releases.html)：2.4.20 稳定版。

Tauri 2.12.1 Android 模板仍依赖旧 DSL 和独立 Kotlin 插件，所以保留其 `android.newDsl=false` 与 `android.builtInKotlin=false` 兼容配置。它们是框架兼容要求，不是忽略编译告警；AGP10 移除旧 DSL 后需重新适配。

`tauri android init --ci` 自动安装了 ARM64、ARMv7、x86、x86_64 四个 Rust 目标；交付只构建 ARM64 与 x86_64。生成工程中可复现源码提交，机器相关 `.tauri`、local.properties、JniLibs、assets、tauri.settings.gradle、tauri.build.gradle.kts 不提交，由 CLI 重建。

执行：`pwsh -File desktop/scripts/check-android.ps1`，随后 `pwsh -File desktop/scripts/build-android.ps1`。输出为 `output/android-client/` 的 APK、签名校验文本和 SHA256 清单。Windows 的 updater 和 tray 依赖限定 Windows；Android 不包含它们。

签名密钥与随机密码在 `.local-secrets/android-signing/` 自动生成，并应用当前用户专有 NTFS ACL。必须备份该目录；后续覆盖升级用同一密钥。可传 `-SigningDirectory` 指向受保护的现有目录。不将签名密码打印、提交或包含在交付包中。APK 最低 Android8，使用 zipalign 16KiB native library 页对齐。

构建在没有 Windows Developer Mode 的系统采用 portable 流程：同样的 Cargo/NDK 参数编译，普通文件复制 JNI .so，Gradle 排除已执行的 Rust 子任务。无需符号链接权限或系统设置修改；Tauri build.rs 仍生成插件依赖。

仅在自动验收时使用 `build-android.ps1 -Debug -Smoke -Targets x86_64`；脚本在当前进程生成 loopback 权限和测试入口配置，结束恢复环境，不修改生产能力。`-Smoke` 与 Release 不兼容。

---

<a id="ops-desktop-android-plugin-recording-md"></a>

# Android native recording

The internal Rust-only adapter exposes recordingCapabilities, recordingStart,
recordingAction, recordingList, recordingExport and recordingRemove. Public
commands continue to validate the main window, origin, account and project in
Rust. Kotlin revalidates the private root and account/session identifiers.

Start receives root, id, accountId, projectId, kind (audio/video/photo), optional
inputDeviceId and cameraDeviceId. Rust injects the current account epoch. The
root must resolve to the app data directory's recordings folder. Files reside
at root/accountId/id/segment-N.m4a, mp4 or jpg; manifest.json is an AtomicFile.
createdAt is ISO UTC, sequence starts at one, times are monotonic milliseconds
relative to session start. Pauses remain explicit timeline interruptions.
Tauri's Android PathPlugin getDataDir returns activity.dataDir, matching the
strict private-root check (it does not return filesDir).

AudioRecord feeds a persistent AAC MediaCodec. Camera2 feeds an AVC encoder
surface. MediaMuxer rotates at AVC keyframes, requested before 5 minutes or
32 MiB. Each finished muxer is independently playable. A late keyframe causes
a stop with a preserved segment rather than an oversized upload. Encoding and
muxing run on one worker; initialization buffers are bounded to 2 MiB.
The same bounded buffer orders packets using the minimum audio/video delivered
timestamp, places video keyframes before equal-time audio, and fully drains on
pause/stop. Adjacent rotation metadata shares the actual keyframe boundary;
device-start and pause/recovery gaps are explicitly recorded as interruptions.
Camera REALTIME timestamps share elapsedRealtime. UNKNOWN timestamp clocks are
aligned once at first encoder output; this includes encoder latency and must be
checked for A/V offset and long-run drift on physical devices. A camera stall
over 15 seconds stops recording. Finalized files must remain at most 32 MiB.

Only a visible activity can acquire permissions and launch the non-sticky
foreground service. A stop notification and partial wake lock support
background/lock recording. Account epoch changes stop capture. No boot receiver
or automatic capture restart is present. Removing the activity does not destroy
the service. Pause releases active microphone capture and stops camera requests;
resume may switch selected devices. Unsupported codecs/devices return errors.

Recovery keeps completed files, validates any finalized orphan with
MediaExtractor, lists .partial tails for explicit export, and marks an interrupted
session instead of restarting it. Export uses SAF, streams files, and cancels on
identity change. Only explicit remove deletes a stopped draft.

Verification: SDK 37/JBR 25 Gradle compileX86_64DebugKotlin and
compileX86_64DebugAndroidTestKotlin passed. FixtureInstrumentation operation
recording-store checks path/account isolation, SHA-256, recovery and tail retention.
No ADB device was connected during implementation: the fixture is compiled but
not executed. Camera/microphone capture, lock/background continuity, codec timing,
force-kill recovery and 4-hour runs require device acceptance. Existing AGP legacy
DSL and generated Wry deprecation warnings remain upstream.

Primary platform references:
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/reference/android/media/MediaMuxer

---

<a id="ops-android-native-readme-md"></a>

# 补位原生 Android 预览客户端

独立 Kotlin / Jetpack Compose / Material 3 应用，当前源码版本为 `0.2.1-preview`（versionCode `3`）。业务界面、文档预览和导出使用原生组件，认证及账户恢复中的浏览器步骤使用系统浏览器。包名为 `cn.buwei.mobile.nativepreview`，Debug 为 `cn.buwei.mobile.nativepreview.debug`；与旧 Tauri Android 版并存，不读取或覆盖旧版私有草稿和未同步录制。

当前业务入口已接入专用原生工作区，`FeatureScreen` 不再提供通用 API 操作表单作为业务入口。项目概览、创建向导、任务与团队、资料与成果 AI、标准评分、答辩、账户、通知、工单和管理等界面复用现有后端的权限、版本及数据体系。**这些源码实现不等于已经完成全量真实业务与生产验收。** 当前覆盖见 [功能说明](#ops-android-native-features-md) 和 [迁移矩阵](#ops-android-native-docs-migration-matrix-md)，最新测试与构建结果见 [验证报告](#operations)。

## 架构

- `MainActivity.kt`、`NativeViewModel.kt`：手机底部导航、平板侧栏、项目分区和深链接；录制、暂停或上传期间的导航保护；绿色品牌主题和 DataStore 外观偏好。
- `data/`：OkHttp 同源 Cookie 请求、AndroidKeyStore 加密会话、Room 账户隔离快照和离线操作队列、账户私有原子草稿。只有服务端允许的幂等写入可以离线排队；AI、费用和权限操作不自动重放。材料冲突需人工核对新版本后再保存。
- `features/`：专用 Compose 业务工作区。富文档支持文字格式、内容块、列表、表格、草稿恢复与版本冲突处理，保存时保留引用、未知节点、marks、attrs 和附件。OpenAPI 契约作为 assets 用于校验与一致性检查，不作为通用业务表单导航。
- `media/`、`cn/buwei/mobile/`：SAF 私有原件、按用途与贡献者区分的分片续传、原生录制前台服务、PdfRenderer/Media3 预览、PDF/Office 正文读取，以及 JSON/Markdown/PDF 分享。页面图片准备与后续 OCR 分开确认。
- `voice/`：显式开启的实时语音、原生 PCM 麦克风与 WebSocket、字幕核对、本地朗读和文字回退。离开页面或账户变化时释放资源。
- `push/`：FCM data 消息仅作提示，点击后重新读取授权收件箱。无 GMS 或配置时使用站内收件箱与 WorkManager 补查；系统不保证按精确的 15 分钟间隔执行。
- `baselineprofile/`：未登录启动路径采集；不包含真实账号业务负载。

## 构建与检查

需要 JDK 17 或以上、Android SDK 37、Build Tools 37.0.0；最低运行版本为 Android 8（API 26），目标 API 为 37。项目使用 Gradle Wrapper。Windows 默认工具位置为 Android Studio JBR 与 `D:/Android/Sdk`，可通过参数覆盖。不要提交 `local.properties`、签名文件或 Firebase 服务账户私钥。

```powershell
node android-native/scripts/generate-contracts.mjs --check
node android-native/scripts/check-feature-routes.mjs
./android-native/scripts/build.ps1 -Debug

# 只使用已有签名，不自动生成或替换密钥
./android-native/scripts/build.ps1 -SigningDirectory 'C:/path/to/existing/signing'
```

构建脚本从 APK 的 `output-metadata.json` 读取实际版本，输出至 `output/android-native/`。当前版本的命名为 `buwei-native-0.2.5-preview-debug.apk` 或 `buwei-native-0.2.5-preview-release.apk`，同时写入签名验证记录及 `debug-artifact.json` / `release-artifact.json`。元数据包含版本、包名、字节数、SHA-256、`sourceCommit` 和 `sourceTreeDirty`；后者记录受跟踪文件是否有未提交改动，不能用提交号代替对该标志的核对。

Release 启用 R8 和资源压缩，禁止明文网络。Debug 允许本机 MockWebServer 测试；服务源固定为现有后端。

```powershell
$env:JAVA_HOME='C:/Program Files/Android/Android Studio/jbr'
$env:ANDROID_HOME='D:/Android/Sdk'
./android-native/gradlew.bat -p android-native :app:testDebugUnitTest :app:lintDebug :app:assembleDebugAndroidTest
# 安装对应 Debug 和 androidTest APK 后，在独立测试设备上运行：
adb -s emulator-5556 shell am instrument -w -r cn.buwei.mobile.nativepreview.debug.test/androidx.test.runner.AndroidJUnitRunner
./android-native/scripts/native-smoke.ps1
./android-native/scripts/measure-native.ps1 -Serial emulator-5556
```

不要将旧版 `0.1` 的测试数量或安装包结果当作本轮证据。每轮实际通过、失败、未运行数量及设备信息以 [VERIFICATION.md](#operations) 为准。

性能脚本记录冷启动、PSS、可归属进程 CPU 和启动/空闲帧的逐轮数据。只有同设备、同认证状态和可比构建类型才适合比较；无法归属 WebView 独立进程时不推测总量。模拟器未登录页面不能证明真实项目工作负载的耗电与长期后台表现。

未登录启动的 Baseline Profile 已有历史采集。需要重新采集时运行 `./android-native/scripts/generate-baseline.ps1 -Serial emulator-5556`，随后重建并核对最终 Release。脚本使用短目标路径规避 Windows 长路径问题，只操作预览包，不卸载、清除旧应用数据或替换签名；正式签名预览包不能被测试签名覆盖，应使用独立测试设备。

## 配套服务与配置

后端包含 `0079_native_auth.sql`、`0080_native_push.sql` 增量迁移、PKCE 授权和设备通知接口，Web 端包含受保护的浏览器授权确认页。S256 verifier 与一次性授权码换取独立会话，不从 WebView 导出 Cookie。2026-10-19 经用户授权，生产已备份、应用 0078–0080 并部署配套服务；新增路由已上线。线上自动验收停在需人工完成的 Turnstile，尚未完成真实授权码交换与 Android 回调，详见验证报告。

FCM 公共客户端参数通过 Gradle 属性 `firebaseAppId`、`firebaseApiKey`、`firebaseProjectId`、`firebaseSenderId` 提供。服务端仅在配置 `FCM_PROJECT_ID`、`FCM_CLIENT_EMAIL`、`FCM_PRIVATE_KEY` 后发送；私钥只属于服务端 secret，绝不放入 APK。缺少配置时显示降级状态，不承诺即时推送。

更新契约时先运行 `npm run export:openapi --prefix backend` 和 `npm run typegen --prefix frontend`，再运行 `node android-native/scripts/generate-contracts.mjs`。当前资产包含 311 个操作；服务端始终负责权限、生命周期、版本和幂等判定。

## 验收边界

专用原生页面已接入现有后端接口，配套服务已部署；真实生产授权、FCM 投递、付费模型、实时语音、四小时物理设备录制与可比 Release 业务负载仍需独立验收。手机、平板、厂商后台限制、外设切换、无障碍及长文性能也应按 [验收清单](#operations) 记录实际结果，不能用接口数量或模拟数据代替。

PDFBox 的可选旧 JPEG2000 解码器未打包，图片渲染使用系统 PdfRenderer。BouncyCastle 中未使用的 EST 辅助类会触发依赖 Lint 告警；Release 配置使用 `-checkdiscard` 要求移除整个 EST 包，未放宽应用 TLS 校验。Gradle 弃用堆栈实际定位到 AGP 的 `BasePlugin.createAndroidJdkImageConfiguration`；不能归因于 Baseline Profile 插件。

媒体使用 ExoPlayer 解码、系统 SurfaceView 和 Compose 控制，没有引入 `media3-ui` 的备用 WebView 字幕组件。最终 APK 的 DEX 扫描结果以对应构建的验证报告为准；当前未提供内嵌字幕专用绘制。

## 外观主题

登录后进入「我的 → 外观 → 主题设计」，可选择「经典绿」或「舒展蓝」。舒展蓝提取自 `windows-native/Tests/Fixtures/prototype-theme.css` 移动端的蓝色强调、冷灰底色、白色卡片和 15dp 圆角，提供深色藏蓝配色；明暗模式独立选择跟随系统、浅色或深色。选择即时应用并保存在设备本机，重启恢复，不影响账号、业务数据或 AI 引用偏好。保留安卓系统字体与字号缩放，不加载 HTML、字体包、模糊层或图片背景。

---

<a id="ops-android-native-features-md"></a>

# 原生前端迁移状态

当前源码版本为 `0.2.5-preview`（versionCode `7`）。业务导航已接入专用 Compose 工作区，通用 API 操作表单已从 `FeatureScreen` 移除；原生客户端沿用现有后端接口、账号、项目数据、权限和版本规则。

| 业务入口 | 当前原生交互 |
|---|---|
| 项目首页、概览、活动 | 项目搜索分页、进度与待响应事项、项目概览、活动记录及项目分区导航 |
| 创建项目 | 模板与草稿、草稿专用附件、手动/AI 预览、澄清回答、固定预览确认提交 |
| 任务与团队 | 筛选分页、任务设置与依赖、领取分工、附件与固定版本提交、验收重开、问询、成员权限、邀请审批与加入 |
| DSH 与 AI 协作 | 设备配对和项目绑定、任务交接与成果复核；AI 对话及起草/引导/审阅三模式、历史与人工复核采纳；失败作业经确认恢复并跟踪后续作业 |
| 资料与成果 | 单一新增入口、资料用途、贡献者、归档和回收恢复、固定版本比较、目录搜索和原文定位、正文/OCR/总结处理 |
| 富文档编辑与展示 | 格式、内容块、列表、表格、撤销重做、本机暂存恢复、人工核对版本冲突；直接渲染 JSON 的标记、单元格、合并信息与固定引用；长文分批完整展开 |
| 标准、评分与演练 | 标准编辑与版本、固定依据评分、人工修正与历史、追问、预审、文字/原生语音排练 |
| 账户与协作支持 | 资料、安全、隐私和恢复邮箱、通知设置与收件箱、工单及附件、People 人员资料、帮助文档；按账户保存 AI 内容引用标识的显示偏好 |
| 管理、录制与导出 | 管理专用工作区、原生拍照录音录像及恢复、分片传输、原文件预览与系统分享、成果导出 |
| 任务建议与反馈依据 | 按任务/调整/分工逐条采纳、修订过期或拒绝建议、编辑依赖、冲突核对、重新反馈；持续反馈历史与每次作业实际冻结的反馈 |

私密问询的已读操作只处理点击时已加载展示的消息快照，去重后每批最多 200 条；失败停止并提示已确认与新增已读数量，由用户继续剩余批次。导出预览可完整浏览并手动刷新；仅有富文档 JSON 时也保留可读正文。聊天输入区在短窗口中可滚动访问；待完成对话的刷新不依赖消息卡可见性，页面后台暂停轮询。

完整能力、限制及代码实现与外部验收的区别见 [迁移矩阵](#ops-android-native-docs-migration-matrix-md)。当前 311 个生成的 API 契约用于一致性与校验，不表示测试覆盖率或完整业务验收率。

请同时阅读 [架构与构建说明](#ops-android-native-readme-md)、[最新验证报告](#operations) 和 [验收边界](#operations)。专用界面的接入不代表真实生产授权、推送、模型、四小时录制或资源占用目标已经通过，也不能据此宣称全目标完成。

本轮补齐材料讨论，并让任务与材料讨论共用分页、账户隔离草稿及待同步核对、资料当前/历史 canonical doc 展示及纯格式版本差异，首页全部已加载事项与归档任务直达；资料与通用分页明确拒权时清除内存，普通读取失败保留并提示旧内容。实际验证以 VERIFICATION.md 为准。

0.2.4 补齐处理中状态的前台轮询、音频质量与部分总结、独立失败阶段重试；扫描页上传携带原文件派生归属，旧资料恢复保留上传身份。录制增加可观察暂停状态、标题和贡献人、云端片段分页及重试；旧录制沿用原分片 manifest，详情刷新已加载页并拒绝旧会话响应。设备验证范围以 VERIFICATION.md 为准。

来源原文件预览按文件 ID 读取服务端真实文件名；自定义来源标题不参与格式分派。中文长文件名按 UTF-8 字节限额截断并保留扩展名，元信息拒权或文件身份不匹配时停止下载并清除旧导出入口。

外观新增「舒展蓝」原型主题：蓝色强调、冷灰背景、白色/藏蓝卡片、15dp 圆角；在「我的 → 外观」与经典绿切换，明暗模式独立保存，失败可重试，旧设置保持经典绿。

---

<a id="ops-android-native-docs-migration-matrix-md"></a>

# 安卓原生迁移矩阵

记录日期：2026-10-20。依据本轮集成工作区源码核对，版本为 `0.2.5-preview`（versionCode `7`）。本表记录已接入的原生业务能力与待验收边界，不代替 [最新验证报告](#operations)。

应用使用 Kotlin、Jetpack Compose 和 Material 3，业务界面不依赖 WebView。`FeatureScreen` 已按业务分派至专用 Workspace；通用 API 操作表单已从业务导航移除。所有业务继续对接现有后端，权限、固定版本、生命周期及幂等规则由服务端判定。源码具备入口、自动化路径通过和真实业务验收通过是不同状态，不能据此直接宣称全量迁移目标完成。

## 基础架构与兼容

| 领域 | 当前实现 | 验收边界 |
|---|---|---|
| 工程与版本 | 独立 `android-native/`；最低 API 26，编译/目标 API 37；`0.2.5-preview`、code `7`；预览包 `cn.buwei.mobile.nativepreview`，Debug 带 `.debug` | 与旧 `cn.buwei.mobile` 并存；不自动读取旧应用私有草稿或录制目录；最低版本物理设备未验收 |
| 界面与导航 | Compose、Material 3、绿色品牌主题；经典绿/原型舒展蓝两套设计，明暗独立选择浅色/深色/跟随系统；本机保存并恢复；按账户保存 AI 引用标识显隐；输入标签与徽标位于输入框上方独立布局；手机底部导航和平板侧栏；授权后深链接定位 | 280dp/2 倍字体已纳入本轮布局回归，其他缩放、键盘、无障碍、厂商系统及大数据交互仍需验收；模拟器截图不能代表全部设备 |
| 网络与状态 | ViewModel、StateFlow、Repository；OkHttp 同源会话；响应正文读取与解析在 IO 调度器执行；项目/账户变化检查 | 真实弱网、切网、长时间后台与跨设备恢复需独立验证 |
| 本机数据 | Room 快照及有序待同步队列、账户私有原子草稿和原文件、加密会话、DataStore 外观偏好 | 缓存不代表持续授权；资料和通用分页在明确拒权后清内存，普通失败保留并标记旧内容；其他权限撤销、账号切换与首次离线深链接需按真实场景验收 |
| 后台与资源 | WorkManager 同步及通知补查；原生录制前台服务；Release 配置 R8 和资源压缩 | 系统及厂商后台策略影响时机；四小时物理录制、耗电和可比 Release 业务负载尚待验收 |

## 原生业务工作区

| 功能 | 当前专用交互与后端对接 | 尚需真实验证的范围 |
|---|---|---|
| 项目首页、概览与活动 | 项目搜索、筛选、分页、任务进度与待响应事项；项目概览、成员/任务/资料分区；分页活动记录；全部已加载待响应事项惰性呈现，直接定位指定任务；归档任务可直接查看 | 大规模项目、完整角色组合、实时变更和长期使用的准确性 |
| 登录、账户与隐私 | 系统浏览器授权与 PKCE 回调、独立会话；原生账户资料、密码、安全、隐私、恢复邮箱绑定/验证/解绑；注册与找回中的浏览器认证步骤 | 配套服务已发布；真实 Turnstile/回调/邮件、失效与退出撤销、真实账号切换 |
| People 与帮助 | 完整用户名精确查找、按公开字段呈现个人资料；帮助章节目录、搜索、文档内定位、Markdown 下载及支持入口 | 真实隐私配置、不可搜索账户、不同语言/字体和帮助资源版本更新 |
| 项目创建 | 模板与创建草稿、本机恢复、信息编辑、草稿专用附件上传/状态；手动或 AI 预览、澄清回答、继续/输出/取消；按草稿修订与固定预览确认提交 | 真实附件及模型处理、澄清长流程、费用不确定状态与生产创建结果 |
| 任务协作 | 服务端分页与生命周期/负责人筛选、创建编辑、工时和期限、成员选择、领取/指派、可读依赖与依赖编辑；服务端负责防环；版本冲突保留输入 | 真实多成员同时修改、权限撤销、完整生命周期组合和大任务图 |
| 成果提交与验收 | 任务文件上传、更新、归档、原生预览；提交前读取有效文件固定版本；提交、人工验收、重开、历史及原始依据；辅助分数复核 | 真实文件传输、并发提交/审阅、评分标准变更与跨设备历史一致性 |
| 私密问询与讨论 | 任务内一对一收件人选择、会话/回复和分页；点击时固定已展示消息快照，去重后按 200 条分批已读；失败停止、明确继续，并分别显示已确认处理数与后端新增已读数；任务与材料讨论共用分页、4000 字账户隔离本机草稿、明确发送与待同步核对；queued 不清稿、不重复创建 | 真实成员可见范围、撤权和跨设备未读状态 |
| AI 任务建议与反馈依据 | 新任务/调整/分工逐条选择；显式空数组区别于省略选择字段；依赖与过期建议修订、保存后应用、409 人工核对、重新反馈；持续反馈历史和作业实际冻结版本 | 真实并发任务图、模型和多成员协作仍待验收；重新反馈不会被客户端自动转为模型调用 |
| 团队与邀请 | 成员分页/搜索及任务负荷、负责人管理成员权限、移除/退出；邀请申请审批、邀请码生成/撤销、用户名邀请、预览与明确加入 | 真实邮箱/账户通知、权限竞争、失效邀请及多角色交互 |
| DSH / Agent Bridge | 原生设备配对、项目绑定、交接状态、任务适用性、交给 DSH 代实施、取消、成果与附件核对后采纳；手动上下文导出 | 真实 DSH 安装、设备连接、会话审批、断连恢复、成果上传和采纳端到端 |
| 项目资料 | 单一“新增资料”入口选择成果、粘贴、网页、文件或录制；用途、贡献者、处理状态；归档、回收站与恢复；原文件原生预览 | 真实来源全生命周期、复杂文件、低存储与服务器资源限制；恢复不自动启动模型 |
| 版本与引用定位 | 成果固定版本查看及正文/附件差异比较；资料目录、分页搜索、片段与实际原文定位；历史引用保持原版本身份 | 真实长文、索引建立、不可用历史附件与多设备版本变化 |
| 富文档编辑与展示 | 选区格式与链接、内容块移动/添加/删除、列表和表格行列、撤销重做；本机恢复；409 人工核对；当前资料及历史版本均优先渲染 canonical doc，版本比较识别纯格式变化；只读直接渲染 JSON 的 marks、单元格及合并信息、固定引用和安全链接，按有限文本块继续展开；保留未知节点及附件 | 表格以手机可折行的逐行单元格展示，非 Office 版式复刻；未知节点保持原样并提示；复杂排版、长文性能、真实冲突与进程恢复仍需验收 |
| PDF 与 Office | SAF 私有原件、用途/贡献者/派生父文件隔离的分片续传、下载；PdfRenderer 原生预览；PDF/DOCX/XLSX/PPTX 正文流式读取、位置与警告 | 正文提取不等于 Office 版式、公式计算或可编辑图表；复杂对象与实际样本需核对 |
| 扫描页、解析与总结 | 页面图片准备使用独立 `/page-images/prepare`，携带来源版本/生命周期和 `analyze:false`，页文件用 derivedFromFileId 保留原文件归属；专用页面提供原文提取、选定页空白确认、显式 OCR、要求提取、独立总结、媒体回退、音频质量及部分总结、独立失败阶段重试；活动处理仅前台轮询，撤权清理状态 | prepare 本身不调用模型；OCR/总结需另行确认。真实扫描件、付费 OCR 与音视频整链未验收；旧服务缺接口时不回退到会自动识别的接口 |
| 成果 AI 协作 | 起草、引导完成、仅审阅三模式；任务与固定参考版本选择、会话/回合历史、回答与任务状态；人工编辑、复核与按材料修订采纳；保留原始富文档 | 真实模型、供应商异常、用量与长运行验收；历史运行是否允许采纳仍按现有后端判定 |
| 项目 AI 对话 | 专用历史/操作分页和项目内引用；作业继续/输出/取消及经确认恢复失败作业，跟踪后续 ID；短窗口中可滚动访问输入；页面级待完成历史刷新，后台暂停轮询；撤权清空服务端消息并保留未发送草稿；工具次数含失败尝试 | 原生行内样式、表格、引用、代码和安全链接已接入；真实长对话、计费、不确定请求结果及更多设备仍需验收 |
| 标准与评分 | 标准维度编辑、版本与生效、固定依据评分、预审；报告、原始 AI 建议、人工分数修正及版本历史、追问；标准变化时限制历史写入 | 真实模型评分、人工保留规则、并发修订和完整业务材料验收 |
| 答辩与实时语音 | 演练创建/历史、文字问答、原生 PCM/WebSocket、字幕核对后提交、设备本地朗读及文字回退 | 真实语音服务、TTS 资源、麦克风/蓝牙、网络和权限中断；协议测试不证明付费语音连通 |
| 拍照与录制 | 原生前台服务与恢复存储、设备选择、音频/视频/拍照、可观察暂停/恢复/停止、标题与贡献人、预览与确认上传；首次上传冻结参数、旧录制沿用原分片身份；当前材料的云端会话和片段分页、固定来源与原文件入口、确认后重试，刷新全部已加载页；活动期间导航保护 | 四小时物理录制、锁屏/来电/进程终止、低电量低存储、相机/麦克风切换与人工听看 |
| 通知与推送 | 原生通知设置、收件箱、已读/收起、按授权解析点击；FCM 注册/注销、账号绑定和去重；无 GMS/配置时补查 | 真实 FCM 凭据/部署、令牌轮换、杀进程与撤权投递；WorkManager 不保证即时或精确间隔 |
| 工单与管理 | 工单创建、图片附件、会话/状态；失败图片可继续上传、不重复创建文字；账户、注册码、AI 配置、资源策略/用量、重试和诊断等管理工作区 | 真实支持流程、管理权限撤销及生产操作；服务端不支持幂等的操作需先核对结果，不能自动重试 |
| 导出与离线 | 按服务端权限导出 JSON/Markdown/PDF 和原文件分享；完整惰性预览、手动刷新与失败恢复；仅有 doc 时导出可读正文；账户隔离缓存、白名单持久写入、同键同步及冲突保留 | 实际导出脱敏、长文和分享目标；首次离线深入口、跨设备同步。AI/计费/权限操作不静默排队重放 |

## 契约与证据的解释

当前集成资产包含 311 个 OpenAPI 操作。生成契约用于类型、输入校验和接口一致性；业务操作由上述专用工作区组织，二进制接口由文件传输工具处理。不能把契约数量换算为功能完成率、测试覆盖率或真实业务成功率。

本轮 API 33 / 37 自动化的实际通过、失败与未运行结果，以及最终签名、APK、来源提交和 dirty 标志，由 [VERIFICATION.md](#operations) 记录。本表不沿用 `0.1` 的 20 项历史结果，也不预先认定新增测试通过。

配套后端、网页授权页和 0078–0080 迁移已按用户授权部署。真实生产授权、FCM/模型/语音、四小时物理录制和可比 Release 业务负载仍按 [验收清单](#operations) 独立闭环；这些条件未完成之前，不宣称全目标验收完成。

---

<a id="ops-windows-native-readme-md"></a>

# 补位 Windows 原生客户端

独立的 C# / .NET 10 / WinUI 3 客户端。业务界面由 XAML 控件原生绘制，不使用 WebView、本地网页服务器或浏览器业务界面。系统浏览器仅用于既有账号的 PKCE 授权。

本工程提供专用原生工作区和安装产物；当前不宣称全部业务对等或真实生产验收完成。能力与差距见 [迁移矩阵](#ops-windows-native-docs-migration-matrix-md)、[界面覆盖说明](#operations)、[验证记录](#operations)。API 清单不是业务覆盖率。

## 外观设置

窗口顶部 **外观设置**，或 **账户与安全 → 外观与主题设置**，可选择：

- **经典 · 翠绿**：默认沿用现有绿色强调色。
- **澄蓝 · 舒展（界面原型）**：依据 `windows-native/Tests/Fixtures/prototype-theme.css` 的蓝色、冷灰导航、圆角卡片与宽松留白，提供深浅两套配色。
- 明暗模式独立选择 **跟随 Windows / 浅色 / 深色**，配置保存到本机 `appearance.json`，登录前亦可调整。高对比度使用系统对比色。

切换使用共享画刷和布局属性绑定，保留业务页面对象与编辑控件。详细映射、自动检查和实机验收边界见 [外观验证](#ops-windows-native-docs-appearance-md)。

## 架构与兼容

- App：Fluent 工作区、MVVM 通知模型、原生文件/媒体/语音/托盘/通知/签名更新。
- Core：固定服务源 HTTP、DPAPI 会话、账户隔离 SQLite 快照/草稿/有序同步队列、Office 读取及语义导出。
- Windows App SDK 使用 **2.5.1 稳定版对应的锁定组件集**：WinUI 2.3.9、Foundation 2.3.12、InteractiveExperiences 2.1.9、Runtime 2.5.1。按组件引用避免部署未使用的 AI/ML/Widgets；显式排除 WebView2 资产。
- .NET SDK 固定 10.0.402；Windows API 编译目标 26100，最低声明版本 17763。系统可使用已安装的完整 Windows SDK 28000；具体旧系统与硬件需单独验收。
- 普通 Release/ReadyToRun，未启用 Native AOT 或裁剪。尚无证据证明全部 Windows 互操作和动态绑定能在 AOT 下保持行为一致。

## 本机构建

在仓库根目录运行：

    ./windows-native/scripts/verify.ps1
    ./windows-native/scripts/build.ps1
    ./windows-native/scripts/build.ps1 -Debug

需要 Visual Studio 的 C# Windows App SDK 支持、.NET 10 SDK、MSVC 和完整 Windows SDK。NuGet 使用项目 lockfile 还原；不要忽略依赖漏洞或裁剪告警。

默认发布目录为 windows-native/artifacts/final/。首次恢复依赖需要网络；客户端依赖共享 Windows App Runtime，.NET 随客户端部署。

    ./windows-native/scripts/build.ps1 -Package -RuntimeInstaller 'C:/path/WindowsAppRuntimeInstall-x64.exe'

打包脚本验证 Runtime 安装器具有有效微软签名，并拒绝发布目录里的 WebView2 文件。当前用户 NSIS 安装器随附共享运行时安装器，应用使用独立版本目录。便携 ZIP 仍需要预装兼容的 Windows App Runtime。

运行时安装器使用[微软固定 2.5.1 x64 下载地址](https://aka.ms/windowsappsdk/2.5/2.5.1/windowsappruntimeinstall-x64.exe)。打包同时检查应用 PRI/XBF 的存在和文件头；资源发布缺失会导致构建产物无法启动，不能只验证编译返回码。

## 数据与授权

新版数据目录为 %LOCALAPPDATA%/Buwei.Windows.Native/；不会读取旧版的 Cookie、IndexedDB、附件或录制目录。卸载保留该目录；重新授权相同账号后可继续使用本机数据。

后端增量迁移 0081_native_auth_client_type.sql 支持固定 Windows 回调 buwei-windows-native://auth/callback，省略类型的旧请求仍使用 Android。必须配套发布后端及授权网页后，生产浏览器登录才可使用；本次未部署或应用生产迁移。

离线编辑只允许既有白名单，通过 offline-sync wrapper 与持久幂等键发送。冲突保留本机和服务端内容，由用户核对后处理。AI、付费及结果不明的非白名单写入不自动重试。服务端始终负责权限、版本及生命周期判定。

## 媒体与文件

录制先保存在账号目录，支持暂停恢复和五分钟分段，无业务总时长限制；分段切换存在短暂间隙，不宣称无缝录制。原文件与恢复日志保留，上传需明确确认。

实时语音沿用服务端现有协议：原生 PCM 输入、文字转录、字幕核对及手动提交，问题由本地中文 TTS 朗读；不宣称服务端返回双向合成音频。未执行真实麦克风或付费语音验收。

DOCX/XLSX/PPTX 使用原生 ZIP/XML 有界提取，保留原文件，正文可导入现有版本绑定接口。它不模拟 Office 排版、计算公式或执行宏。PDF、图片、媒体使用原生预览。

## 更新与测试隔离

更新入口为独立 windows-native.json 及其签名，复用原有 Minisign 公钥；不复用旧 Tauri 清单。下载及安装前验签，未保存、录制、传输和忙碌时拒绝重启。未配置 Authenticode 的安装器不能称为已通过 Windows 发布者签名。

Debug 下 BUWEI_WINDOWS_SMOKE=1 才使用固定 127.0.0.1:5188 和合成账号/独立临时目录，Release 无此入口。--benchmark 使用独立空临时目录和实例，仅用于匿名资源测试，不读取正式会话。

依赖许可：项目延续 GPL-3.0；PDFsharp 固定 6.2.4 MIT 版本，不使用 6.5 的 AGPL 激活方式。字体来自运行设备，不随安装包再分发；导出器检查嵌入限制。Minisign 使用 Sodium.Core，安装包须随附对应第三方许可。

---

<a id="ops-windows-native-docs-migration-matrix-md"></a>

# Windows 原生迁移验收矩阵

此表是交付门槛。API 清单、路由检查、页面存在均不能代替真实角色、完整操作和界面验收。当前仅记录源码观察，尚无全量原生验收证据；不声明完整迁移完成。

状态：**待验收**表示已有实现入口但缺少真实窗口/服务闭环证据；**待实现**表示当前未发现完整专用界面；**局部**表示部分流程已有源码。所有行在正式验收前均保持未完成。

| 功能 | 源码观察状态 | 必须验证的操作闭环 |
| --- | --- | --- |
| 原生登录、登出及账户隔离 | 待验收 | 浏览器 PKCE、固定 Windows 回调、取消/过期/重放、服务端撤销、本地清理、切换账户无旧页数据 |
| 项目列表、详情、目标及创建向导 | 局部 | 翻页、创建草稿、模板选择、预览、确认创建及失败恢复；非通用 JSON 表单 |
| 邀请与团队权限 | 局部 | 收件箱、详情、接受/拒绝、成员与角色修改、邀请撤销、无权限操作 |
| 任务图、任务编辑、认领与提交 | 局部 | 依赖与负责人、版本冲突、认领、附件、提交、审阅、返工、刷新结果 |
| 私密问询与协作评论 | 局部 | 已有专用提问、授权列表、回复、草稿；批量已读及完整成员分页未实现，需角色验收 |
| 资料、成果、文件与版本 | 局部 | 选择、上传、断点恢复、预览、引用、版本比较、归档与权限 |
| 富文档 | 局部 | 块编辑、表格、引用、附件及未知节点无损往返、草稿、冲突人工处理 |
| 标准与评估 | 局部 | 已有标准编辑、人工分数及版本草稿；要求复核合并、评分比较及发布冲突对照未完整实现 |
| AI 与后台任务 | 局部 | 已有专用聊天、工具累计次数、后台状态及结构化采纳；完整执行控制、引用跳转及会话设置未完成 |
| 演练与实时语音 | 局部 | 已有原生演练及 PCM/转录/本机 TTS；真实麦克风、断线、授权及付费语音未验收 |
| Agent Bridge / DSH | 待验收 | 已有配对、授权调整/撤销、适用性、派发、取消、文件核对及采纳提交；审批/输入在 DSH，真实设备/原生界面与并发授权窗口尚未验收 |
| 个人资料、安全与账户管理 | 局部 | 已有资料、密码、邮箱及账户管理；恢复邮箱 token/恢复代码及完整安全流程未覆盖 |
| 通知、工单、帮助、管理、活动与导出 | 局部 | 已有专用界面及中文 Markdown/PDF/JSON 导出；帮助、工单图片和若干管理策略未实现 |
| 离线与同步 | 待验收 | 首次离线入口、持久化意图、重启恢复、稳定幂等键及 wrapper、409、撤权、跨账户隔离 |
| 托盘、系统通知、录制、传输 | 待验收 | 单实例、点击定位、空闲资源、设备中断、低磁盘、传输恢复及取消 |
| 安装、签名更新及性能 | 待验收 | 独立安装目录/数据、签名失败、忙碌不重启、两版本升级、三轮同场景实测 |

## 可复现检查

- `node windows-native/scripts/generate-contracts.mjs --check`：对比当前 OpenAPI 清单及路由族常量，无业务界面覆盖声明。
- `node windows-native/scripts/check-feature-routes.mjs`：保守检查 App 内完整字面量 method/path；变量、字符串拼接和插值保持 unresolved。返回 0 只表示已识别字面量无错误，不表示所有调用或业务完成。
- `node --test windows-native/scripts/contracts.test.mjs`：验证生成可重复、过期清单失败、错误路由失败、动态调用不误计以及实际登出契约。

验收记录需追加实际构建 SHA、角色、场景、结果、截图/日志位置和限制。若仅本地 mock 通过，不能改记为真实生产验收。后续界面新增后逐项更新本表；功能状态不得由脚本按 API 数量自动提升。

## 本轮源码及自动验证边界

各领域具体已实现与缺口见 [界面覆盖审计](#operations)。离线准备缓存项目概览、任务、成果/历史版本、资料元信息及固定原文目录、分节和续读页，默认限制 128 MiB 文本、2,000 次接口读取及每条分页链 200 页。未就绪、不可访问的原文明确标记部分准备；问询、评估、任意全文搜索和其他次级路由尚未全部主动准备，仍未满足全量首次离线深链接验收。文件另行下载。详见 [离线准备验证](#operations)。任务成果离线入口保存固定版本并等待人工发送确认，发送前持久标记，异常/进程中断后停止后台重试，仅允许核对后用原键恢复，详见 [离线成果提交验证](#operations)。Bridge 和上述成果队列之外的普通在线请求尚非完整持久化在线意图协议。

任务文件新增与替换、原上传恢复和登记结果核对见 [任务文件验证](#operations)。新增可切换原型主题与验证见 [客户端外观](#ops-windows-native-docs-appearance-md)。当前源码完成 Core 50 项、回归 68 项、Office 17 项、导出 8 项及平台签名/传输、语音协议纯本机检查；Release 构建零警告、零错误。Bridge 相关服务端协议 63 项通过，新增源码记录见 [Bridge 验证](#operations)。真实业务角色、高 DPI/中文输入/无障碍、低磁盘及升级失败恢复尚未验收。用户按 Escape 后已停止界面自动化，未继续进行原生 GUI 检查。已交付的 0.1.0 安装包与性能记录仍固定在 8225036c，不包含后续 0.1.1 源码。

---

<a id="ops-windows-native-docs-appearance-md"></a>

# 原型视觉主题与设置

## 范围及使用

0.1.3 新增「澄蓝 · 舒展（界面原型）」，参考 `windows-native/Tests/Fixtures/prototype-theme.css`（本轮依据 main `edf2d516` 的版本）。本次实现原生客户端视觉主题；业务页面和流程沿用当前 WinUI 工作区。

入口：窗口顶部「外观设置」（登录前可用），或「账户与安全 → 外观与主题设置」。原有主题命名为「经典 · 翠绿」并作为缺省；主题与「跟随 Windows / 浅色 / 深色」分别选择、即时应用，关闭设置框即结束调整。

## 视觉映射

| 项目 | 原型主题浅色 | 原型主题深色 |
| --- | --- | --- |
| 窗口背景 | `#F5F7FB` | `#161B26` |
| 导航分区 | `#ECF0F7` | `#10141D` |
| 卡片 | `#FFFFFF` | `#222A3B` |
| 正文 / 次要文字 | `#141824` / `#4E586E` | `#F1F5F9` / `#94A3B8` |
| 主按钮 / 悬浮 | `#2563EB` / `#1D4ED8` | `#2563EB` / `#1D4ED8` |
| AI 提示及导航图标 | `#6D28D9` | `#A78BFA` |

导航展开宽 236、卡片圆角 10、控件圆角 7、卡片内边距 24×20、正文区内边距 30×26、通用纵向间距 16（Windows 逻辑像素）。原型透明叠层转成不透明原生表面，使用共享画刷，未引入 WebView、网页运行时、额外图片/字体依赖、模糊层或持续动画。

深色填充按钮保留蓝 `#2563EB` 配白字，链接/提示用更亮的蓝；相较原型较亮的深色按钮，该调整使普通小字号对比度达到 4.5:1。经典浅色的提示文字使用较深绿 `#12704F`，保留原绿色主按钮。

## 实现与存储

- `Core/AppearancePreferences.cs`：两种主题、三种模式、配色及版本化设备偏好；不依赖服务端或登录账户。
- `%LOCALAPPDATA%/Buwei.Windows.Native/appearance.json`：小型本机配置。先写同目录唯一临时文件，再替换；保存失败不应用新主题，界面回到原选择。无效或未知版本配置回退默认并保留原文件，在设置内说明原因。测试/基准目录沿用各自独立配置。
- `App/AppearanceTheme.cs`：共享画刷原位更新、布局属性绑定、系统明暗与高对比度事件、原生标题栏和弹窗同步。资源键按固定 WinUI 版本的 `generic.xaml` 核对。`App/Platform/DesktopAppearance.cs` 使用 HWND 子类接收 `WM_SETTINGCHANGE`、`WM_SYSCOLORCHANGE`、`WM_THEMECHANGED`，通过 `SystemParametersInfo(SPI_GETHIGHCONTRAST)` 和 `GetSysColor` 读取桌面无障碍配色，不订阅导致 0.1.3 启动失败的 `AccessibilitySettings.HighContrastChanged`。
- 设置更新不会调用业务导航、重新拉取数据或重建工作区；编辑控件对象和草稿处理链保留。系统事件订阅在窗口关闭时释放。

## 已执行验证

`scripts/verify.ps1` 通过：Core **50/50**（原 23 项 + 外观 27 项）、业务回归 **68/68**、Office 17、导出 8、契约 7、平台/语音及资源门禁，Release x64 **0 警告、0 错误**。

外观检查覆盖六种选项组合重载、取消保存、无效选项、锁定目标模拟替换失败且保留原文件/清理临时文件、损坏/未知版本/过大配置回退、深浅正文/次要文字/按钮/提示的数值对比度、与指定 HTML 的双套主色映射，以及覆盖的资源键确实存在于锁定的 WinUI 控件模板。

整合工作区日志：`windows-native/artifacts/verification/appearance-full.log`；main 复验日志：主仓库 `output/windows-native/verification/appearance-main.log`。

## 待实机验收

本轮未操作 GUI 自动化、安装新版或切换真实 Windows 高对比度；此前停止 GUI 自动化的约束仍保留。尚未取得原生窗口截图，也未实测输入法、缩放、键盘焦点、屏幕阅读器、编辑中切换或实际系统色变化。代码层面的实时绑定和数值对比度检查不能代替以上实机验收。未重新测量 CPU/内存；旧包性能结果仅适用于其冻结版本。

## 0.1.4 启动修复与发布门禁

0.1.3 在本机实际启动时，主题构造函数订阅 WinRT 高对比度事件抛出 `COMException 0x80070490`，窗口未显示；编译和原有测试未发现这个运行时问题。0.1.4 改用桌面设置消息，保留高对比度支持；启动异常会记录并退出释放单实例句柄，避免后续启动持续等待失败实例。

`scripts/build.ps1 -Package` 现在必须先执行 `scripts/verify-startup.ps1`：实际启动同一份 Release 发布目录，检查 30 秒内创建原生窗口、持续 10 秒存活及响应、第二次启动转交后正常退出、没有新增启动诊断。检查仅使用隔离 benchmark 配置和本次创建的进程，不操作界面；结束后终止自有测试进程。已有 benchmark 实例时拒绝运行。主目录、账户数据与旧客户端不变。此门禁要求交互式 Windows 桌面，不能以构建成功代替启动验证。

本机对照：0.1.3 被该门禁拒绝，0.1.4 通过；可复现命令：

```powershell
./windows-native/scripts/verify-startup.ps1 -PublishDirectory ./output/windows-native/0.1.4/payload -ReportPath ./output/windows-native/0.1.4/startup-verification.json
```

高对比度实现依据：[Microsoft 桌面高对比度参数](https://learn.microsoft.com/en-us/windows/win32/winauto/high-contrast-parameter)。上述启动证据不代表登录、业务角色、主题切换视觉或真实系统高对比度验收通过。

---

<a id="ops-windows-native-docs-third-party-licenses-md"></a>

# 发布许可收集

构建发布完成后运行 PowerShell 7：

```powershell
pwsh -NoProfile -File windows-native/scripts/collect-licenses.ps1 -PublishDirectory C:\path\to\publish
```

默认读取 App restore 后的 `obj/project.assets.json`；可用 `-AssetsFile` 指定其他 restore 输出。脚本不升级依赖，不联网，不复制 NuGet 二进制、SDK 或 Windows 字体，只收集选定 win-x64 依赖图中的 nuspec、LICENSE/COPYING/NOTICE 和来源元数据。发布目录实际存在的 runtime/native/resource 文件名匹配单独标记；其余条目标记为 restore/build-only-or-not-published，不以此宣称发布 WebView2 等构建依赖。

输出项目原始 GPLv3 `LICENSE`、`THIRD-PARTY-NOTICES.txt`、机器可读 JSON，以及 `licenses/<package>/<version>/`。包名、版本、源地址（移除凭据与查询参数）、NuGet SHA512、版权和许可声明均来自实际本机缓存，不推测许可。无本地许可全文的包使用脚本同目录固定上游快照，来源/版本/SHA256 记录于 `licenses/provenance.json`。PDFsharp 固定 6.2.4 MIT，不能替换为具有新许可要求的 6.5。SQLitePCLRaw 2.1.13 未公开对应上游 tag，采用该包 nuspec 声明的官方 Apache 2.0 全文，来源清楚标明，不伪造 tag。

自包含 .NET 运行库不属于普通 `assets.libraries`，脚本额外读取 restore 的 `downloadDependencies` 精确版本，并以发布目录 `coreclr.dll` 等文件确认实际发布。对 .NETCore/WindowsDesktop/AspNetCore 运行库包收集其 `LICENSE.TXT`、`THIRD-PARTY-NOTICES.TXT`、nuspec 与来源/hash，标记 `self-contained-framework-runtime-pack`；不把 Crossgen/引用包当作已发布运行库。若 restore 信息缺少 .NETCore 版本，仅使用实际 `coreclr.dll` 的 ProductVersion 回退，绝不选择缓存中的最高版本；识别失败明确列为缺失。

缺失缓存、nuspec、声明文件或完整许可会写入清单并警告；加 `-Strict` 使任何缺失阻止发布。无法取得完整许可时只能作为明确标记的本地预览产物，不应宣称已完成第三方许可发布检查。Windows SDK 构建工具可能仅有旧版许可 URL，须保留该限制；它的构建工具不会因收集脚本进入客户端。

---

<a id="ops-packages-dsh-team-office-bridge-readme-md"></a>

# 补位 DSH 桥接器

标准 DSH 外部插件，不改动 DSH 本体、不开放本地端口。DSH 保持运行时，插件每 5 秒从网站主动领取任务；网络故障按 10–60 秒退避。使用 DSH 自己的模型及权限审批。

## 安装与首次连接

1. 在 DSH 的“插件 → 安装插件”输入固定版本发布包 URL，或选择本地 `.tgz`：`https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.1.tgz`。开发验收用 `npm pack` 产出的本地文件。
2. 在下方“已安装”区域启用 `@greenbeanpie/dsh-team-office-bridge`，必要时重启 DSH；点击这个插件条目，直接在其详情页点击“连接网站”（自动打开授权网页；弹窗被拦截时点击“打开网站确认连接”），在已登录网站选择项目并确认。
3. 返回 DSH，为获授权项目点击“选择本地目录”；每个项目只需选择一次。

网站任务保存后自动检查 AI 适用性，通过后在“AI 辅助 → 代实施”中明确派发才排队。DSH 自动接收完整快照、将原始材料流式下载到磁盘（按声明大小和哈希核对，不施加成果的 50 MiB 限制）、执行并上传登记成果。网站保存草稿，用户核对后采纳与提交验收。DSH 原生审批继续由用户确认。

连接密钥仅写入 DSH 官方 credentials record；插件自己的 journal 不包含密钥。目录映射仅保存在 `$DSH_HOME/team-office-bridge/state.json`。DSH 会话工作目录就是用户选择的项目目录，可读取和编辑已有项目；运行输入与输出位于该目录的 `.team-office-bridge/<handoffId>/inputs|outputs`。断开连接先在网站撤销设备，再等待本地任务停止并确认取消，最后删除凭据；网络中断时保留原凭据和日志供重试。执行状态不确定时阻止重新连接或切换端点。断开连接保留输入、成果文件与历史会话。

## 配置入口与升级

0.1.1 使用 DSH 的 `plugins.bundle.config`，以插件包名注册配置页。上方的独立“补位桥接器”入口已移除；连接、刷新、断开以及各项目的目录选择都在下方已安装插件的详情页。已核查 Desktop 0.2.0-rc.2 支持该入口，未修改 DSH 本体。

0.1.0 用户需通过 DSH 的官方插件管理器卸载旧包，再使用 0.1.1 链接安装并启用新包；不要点击插件内“断开连接”。版本升级保留原凭据记录、目录映射和执行日志，安装前请等待当前执行结束。旧固定版本发布包继续保留。

## 稳定性约束

每设备串行执行；固定会话 ID 和 prompt requestId。投递前持久化记录；投递响应丢失时核对持久日志，无法证明受理则停止并显示 `dispatch_uncertain`，不自动重新执行。上传与完成请求可重复，按成果 ID 和哈希去重。只有 DSH 正常 turn end 且调用本会话专属 `team_office_complete` 登记成果后才能回传完成。

回传只允许 outputs 内明确登记的普通文件，拒绝越界、符号链接、密钥文件、超限文件。默认每文件 50 MiB、最多 20 个文件，并执行网站快照声明的扩展名限制；网站另行执行其上传限制。不上传原始会话或工具记录。连接 origin 与密钥一起保存，改变端点必须重新配对。

## 开发验证

在本目录运行 `npm test`、`npm run check`、`npm pack`。Windows 已安装官方 Desktop 时，可运行 `npm run smoke:host`：在隔离 DSH_HOME 中将内置 DeepSeek 适配器连接本地 SSE fixture，验证实际 prompt、scoped completion、正常 turn end 与草稿回传；不调用付费模型、不读取个人密钥。不安装本地依赖、不复制 Cordis；宿主服务均来自 DSH。插件只依赖已有官方 API：`sessionController`、`credentials`、`connection.fetch`、scoped `agent.ctx.tools`、native directory picker。浏览器端按官方 `__ModuleLoader__` 工厂格式提供构建文件，React 使用宿主 module table。

兼容门禁检查这些公开接口；缺少任意必要服务时拒绝连接和接收。参考源码 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` / `0.2.1-alpha.1`；Desktop `0.2.0-rc.2` 须单独真实启动验收。不能将 mock 测试等同于真实模型、原生目录选择或生产完整链路验收。

---
