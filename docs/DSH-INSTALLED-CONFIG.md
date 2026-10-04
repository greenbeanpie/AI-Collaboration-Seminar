# 已安装插件的配置入口（0.1.1）

配置表单已从上方的独立“补位桥接器”条目移至下方“已安装”的 `@greenbeanpie/dsh-team-office-bridge` 详情页。点击已安装插件的名称即可连接网站、刷新或断开连接，并为获授权项目选择、更换目录。

原因是旧实现只注册 `plugins.item`，DSH 会把它列入上方的官方配置区。新实现使用 `plugins.bundle.config`，以插件包名注册，不再产生上方重复条目。已直接核查本机 Desktop 0.2.0-rc.2 的文档与运行代码，也与[官方配置页接口](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md#configuration-pages)一致。宿主支持已安装插件的详情页配置，不能通过这个接口将完整表单直接嵌入插件列表行。

安装地址：`https://greenbp-team-office.hddhp.workers.dev/plugins/dsh-team-office-bridge-0.1.1.tgz`。

固定 SHA256：`a09630ab655f3322e7479ad09c92a75e1dc796795c0d4f6b70c7557322409844`。

旧固定包 0.1.0 保留。DSH 不自动更新已安装插件；请等待现有执行结束，通过官方插件管理器卸载旧包后安装并启用 0.1.1，不要使用桥接器内部的“断开连接”。桥接器凭据记录、目录映射及执行日志的存储位置未变，不执行凭据重置或日志清理。必要时重启 DSH。

验证：插件 43 项通过，1 项 Windows 符号链接测试跳过；前端 665 项通过；前端类型检查、lint、生产构建通过。`node scripts/verify-installed-plugin-config.mjs` 通过官方 CLI 在隔离 DSH_HOME 安装固定包并启动实际 RC2，用真实浏览器验证下方条目打开配置、上方重复入口消失、连接按钮启用、模拟授权跳转以及目录操作。实际宿主会话生命周期测试也通过。

验证未修改用户的个人 DSH profile，未创建生产设备授权，未调用付费模型。授权响应和目录动作使用明确测试替身，原生目录选择需在用户本机确认。
