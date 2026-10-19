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

FCM 仅携带 `eventId`、`userId`，使用 data-only 消息和 60 秒 TTL；不携带标题、正文、资源链接或业务内容。应用检查当前本地账户后显示固定通用文案，并保存最近 256 个事件 ID 去重。点击通过显式 MainActivity Intent 的 `notificationEventId` / `notificationAccountId` 进入；业务层必须先验证当前会话与通知列表中的事件访问权，才能打开具体资源。

无效 token 仅在 FCM 明确返回 `UNREGISTERED` 时停用。缺失 Firebase 项目不被当成设备过期；网络失败和 429/5xx 按现有 outbox 退避策略重试。

## 验证边界

`npm test --prefix backend -- native-push.test.ts 47-notifications.test.ts` 使用真实临时生成的 RSA 密钥、模拟 OAuth/FCM 响应和测试 D1，覆盖账户切换、轮换、会话撤销、配置缺失及错误分类。测试不发送真实推送。

真实凭据、发布后的服务端、Android Firebase 配置、Google Play 服务及允许通知权限的实机，是即时通知端到端验收的前提。FCM 的送达和后台调度不保证即时性；应始终保留站内通知补查。
