using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private Task<UIElement> AccountAsync(CancellationToken token)
    {
        var panel = Page("账户与安全", "账户设置仅修改当前登录账户。");
        panel.Children.Add(Ui.Label(repository.User.Text("username"), 20));
        panel.Children.Add(Action("全局个人资料与隐私", () => ReplaceAsync(PersonalProfileAsync)));
        var name = Ui.Field("显示名称", repository.User.Text("displayName"), max: 64);
        panel.Children.Add(Ui.Card(name, Action("保存显示名称", async () => { if (string.IsNullOrWhiteSpace(name.Text)) return; await WriteAsync("PATCH", "/auth/profile", new JsonObject { ["displayName"] = name.Text.Trim() }); StatusChanged?.Invoke("显示名称已保存。"); })));
        var current = new PasswordBox { Header = "当前密码", MaxLength = 128 }; var password = new PasswordBox { Header = "新密码", MaxLength = 128 }; var repeat = new PasswordBox { Header = "确认新密码", MaxLength = 128 };
        current.PasswordChanged += (_, _) => sensitiveInput = current.Password.Length + password.Password.Length + repeat.Password.Length > 0;
        password.PasswordChanged += (_, _) => sensitiveInput = current.Password.Length + password.Password.Length + repeat.Password.Length > 0;
        repeat.PasswordChanged += (_, _) => sensitiveInput = current.Password.Length + password.Password.Length + repeat.Password.Length > 0;
        panel.Children.Add(Ui.Card(Ui.Label("修改密码", 20), current, password, repeat, Action("修改密码", async () =>
        { if (password.Password != repeat.Password) throw new InvalidOperationException("两次新密码不一致。"); if (password.Password.Length < 10) throw new InvalidOperationException("新密码至少需要 10 个字符。"); await WriteAsync("POST", "/auth/password", new JsonObject { ["currentPassword"] = current.Password, ["newPassword"] = password.Password }); current.Password = ""; password.Password = ""; repeat.Password = ""; }, "确认修改密码？修改后可能需要重新登录。")));
        var email = Ui.Field("恢复邮箱", max: 254); var emailPassword = new PasswordBox { Header = "当前密码", MaxLength = 128 };
        emailPassword.PasswordChanged += (_, _) => sensitiveInput = emailPassword.Password.Length > 0 || current.Password.Length + password.Password.Length + repeat.Password.Length > 0;
        panel.Children.Add(Ui.Card(Ui.Label("恢复邮箱", 20), email, emailPassword, Action("绑定或修改恢复邮箱", async () => { await WriteAsync("POST", "/auth/recovery-email", new JsonObject { ["email"] = email.Text.Trim(), ["currentPassword"] = emailPassword.Password }); emailPassword.Password = ""; StatusChanged?.Invoke("申请已受理，请检查新邮箱并核对验证链接。"); }), Action("解绑恢复邮箱", async () => { await WriteAsync("DELETE", "/auth/recovery-email", new JsonObject { ["currentPassword"] = emailPassword.Password }); emailPassword.Password = ""; }, "确认解绑当前恢复邮箱？")));
        return Task.FromResult<UIElement>(panel);
    }
    private async Task<UIElement> NotificationsAsync(CancellationToken token)
    {
        var panel = Page("通知", "通知可单独标为已读或收起；列表按服务端分页读取。");
        var settings = await repository.GetAsync("/notifications/settings", token);
        var inApp = new ToggleSwitch { Header = "站内通知", IsOn = settings.Flag("inAppEnabled") }; var push = new ToggleSwitch { Header = "系统通知", IsOn = settings.Flag("pushEnabled") };
        panel.Children.Add(Ui.Card(inApp, push, Action("保存通知设置", async () => { await WriteAsync("PUT", "/notifications/settings", new JsonObject { ["inAppEnabled"] = inApp.IsOn, ["pushEnabled"] = push.IsOn }); }), Action("全部标为已读", async () => { await WriteAsync("POST", "/notifications/read-all"); await NavigateAsync("notifications"); })));
        await AddPagedAsync(panel, "/notifications?limit=50", row =>
        {
            var box = Ui.Stack(Ui.Label(row.Text("title"), 18), Ui.Label(row.Text("body")), Ui.Label(row.Text("createdAt")));
            if (row.Text("readAt").Length == 0) box.Children.Add(Action("标为已读", async () => { await WriteAsync("POST", "/notifications/" + Escape(row.Text("id")) + "/read"); await NavigateAsync("notifications"); }));
            var href = row.Text("url");
            if (href.StartsWith("/app/projects/", StringComparison.Ordinal) && !href.Contains('\\')) box.Children.Add(Action("查看相关内容", () => NavigateAsync(href.Split('?', '#')[0])));
            box.Children.Add(Action("收起通知", async () => { await WriteAsync("POST", "/notifications/" + Escape(row.Text("id")) + "/dismiss"); await NavigateAsync("notifications"); })); return Ui.Card(box);
        }, token);
        return panel;
    }
    private async Task<UIElement> SupportAsync(CancellationToken token)
    {
        var panel = Page("帮助与工单", "提交问题或求助，与管理员沟通。请勿在内容或截图中提供密码、验证码和密钥。");
        var key = "support-create"; var draft = await repository.Store.LoadDraftAsync(key);
        var title = Ui.Field("问题标题", draft.Text("title"), max: 160); var body = Ui.Field("问题描述", draft.Text("body"), true, 8000);
        var urgency = Ui.Choice("紧急度", [("normal", "普通"), ("low", "低"), ("high", "高"), ("urgent", "紧急")]);
        var category = Ui.Choice("分类", [("interface", "界面"), ("functionality", "功能"), ("account", "账户"), ("performance", "性能"), ("other", "其他")]);
        var uncertain = draft.Flag("uncertain"); var warning = Ui.Label(uncertain ? "上次提交结果不明，请先核对列表避免重复提交。" : "");
        var submit = Action("提交工单", async () =>
        {
            if (uncertain) throw new InvalidOperationException("请先核对已有工单，再解锁再次提交。");
            if (string.IsNullOrWhiteSpace(title.Text) || string.IsNullOrWhiteSpace(body.Text)) throw new InvalidOperationException("请填写标题和问题描述。");
            await repository.Store.SaveDraftAsync(key, new JsonObject { ["title"] = title.Text, ["body"] = body.Text, ["uncertain"] = true }); uncertain = true; warning.Text = "已开始提交。结果不明时请先核对列表。";
            var result = await WriteAsync("POST", "/support/tickets", new JsonObject { ["title"] = title.Text.Trim(), ["body"] = body.Text.Trim(), ["urgency"] = urgency.Value(), ["category"] = category.Value() });
            await repository.Store.DeleteDraftAsync(key); await ReplaceAsync(ct => SupportConversationAsync(result?["ticket"].Text("id") ?? "", ct));
        }, "确认提交此工单？", true);
        panel.Children.Add(Ui.Card(title, body, urgency, category, warning, Action("暂存到本机", () => repository.Store.SaveDraftAsync(key, new JsonObject { ["title"] = title.Text, ["body"] = body.Text, ["uncertain"] = uncertain })), submit,
            Action("已核对列表，允许再次提交", async () => { uncertain = false; await repository.Store.SaveDraftAsync(key, new JsonObject { ["title"] = title.Text, ["body"] = body.Text, ["uncertain"] = false }); warning.Text = "已解锁再次提交。"; }, "确认已查看工单列表且没有重复工单？结果不明的重复提交可能创建两份工单。")));
        await AddPagedAsync(panel, "/support/tickets?limit=20", row => Ui.Card(Ui.Label(row.Text("title"), 18), Ui.Label(Ui.Status(row.Text("status")) + " · " + row.Text("updatedAt")), Action("查看工单对话", () => ReplaceAsync(ct => SupportConversationAsync(row.Text("id"), ct)))), token);
        return panel;
    }
    private async Task<UIElement> SupportConversationAsync(string id, CancellationToken token)
    {
        var path = "/support/tickets/" + Escape(id); var response = await repository.GetAsync(path, token); var ticket = response?["ticket"] ?? response;
        var panel = Page(ticket.Text("title"), Ui.Status(ticket.Text("status"))); panel.Children.Add(Ui.Label(ticket.Text("body")));
        await AddPagedAsync(panel, path + "/messages?limit=30", row => Ui.Card(Ui.Label(row.Id("authorName", "senderName")), Ui.Label(row.Text("body")), Ui.Label(row.Text("createdAt"))), token);
        var message = Ui.Field("回复内容", "", true, 8000);
        panel.Children.Add(Ui.Card(message, Action("发送回复", async () => { if (string.IsNullOrWhiteSpace(message.Text)) return; await repository.Store.SaveDraftAsync("support-reply:" + id, new JsonObject { ["body"] = message.Text }); await WriteAsync("POST", path + "/messages", new JsonObject { ["body"] = message.Text.Trim() }); await repository.Store.DeleteDraftAsync("support-reply:" + id); await ReplaceAsync(ct => SupportConversationAsync(id, ct)); })));
        if (repository.User.Text("role") is "admin" or "super_admin")
        {
            var status = Ui.Choice("处理状态", [("pending", "待处理"), ("in_progress", "处理中"), ("waiting_user", "待用户回复"), ("resolved", "已解决"), ("closed", "已关闭")], ticket.Text("status"));
            panel.Children.Add(Ui.Card(status, Action("更新工单状态", async () => { await WriteAsync("PATCH", path + "/status", new JsonObject { ["status"] = status.Value(), ["revision"] = ticket?["revision"].Copy() }); await ReplaceAsync(ct => SupportConversationAsync(id, ct)); })));
        }
        return panel;
    }
    private async Task<UIElement> BridgeAsync(CancellationToken token)
    {
        var panel = Page("Agent Bridge", "在 DSH 安装补位桥接器后选择连接网站。这里授权设备及项目；具体任务须在任务页明确发起。");
        var link = Ui.Field("粘贴 DSH 完整 HTTPS 连接授权链接", max: 2048); var pairingPanel = Ui.Stack();
        panel.Children.Add(Ui.Card(link, Action("读取设备连接请求", async () =>
        {
            if (!Uri.TryCreate(link.Text.Trim(), UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.AbsolutePath != "/app/agent-bridges/connect" || uri.UserInfo.Length > 0) throw new InvalidOperationException("请输入 DSH 生成的完整 HTTPS 连接授权链接。");
            var pairs = uri.Query.TrimStart('?').Split('&').Select(x => x.Split('=', 2)).Where(x => x.Length == 2 && x[0] == "pairing").ToArray();
            if (pairs.Length != 1 || !Guid.TryParse(Uri.UnescapeDataString(pairs[0][1]), out var id)) throw new InvalidOperationException("连接链接缺少有效配对请求。");
            var path = "/agent-bridges/pairings/" + id; var pairing = await repository.GetAsync(path, PageToken); var selections = new Dictionary<string, CheckBox>();
            pairingPanel.Children.Clear(); pairingPanel.Children.Add(Ui.Label("设备：" + pairing.Text("deviceName"), 20)); pairingPanel.Children.Add(Ui.Label("有效期至 " + pairing.Text("expiresAt")));
            foreach (var option in pairing.Rows("projects")) { var check = new CheckBox { Content = option.Text("name") }; selections[option.Text("projectId")] = check; pairingPanel.Children.Add(check); }
            pairingPanel.Children.Add(Action("确认连接并授权项目", async () => { var selected = selections.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray(); if (selected.Length == 0) throw new InvalidOperationException("请至少选择一个项目。"); await WriteAsync("POST", path + "/approve", new JsonObject { ["projectIds"] = new JsonArray(selected) }); await NavigateAsync("bridge"); }, "允许该设备读取所选项目任务输入并回传成果？连接不会自行执行任务。"));
        }), pairingPanel));
        await AddPagedAsync(panel, "/agent-bridges/devices", row => Ui.Card(Ui.Label(row.Text("deviceName"), 20), Ui.Label("DSH " + row.Text("dshVersion") + " · 桥接器 " + row.Text("bridgeVersion")), Ui.Label(row.Flag("revoked") ? "连接已撤销" : "最近在线 " + row.Text("lastSeenAt")), Action("撤销设备连接", async () => { await WriteAsync("DELETE", "/agent-bridges/devices/" + Escape(row.Text("deviceId"))); await NavigateAsync("bridge"); }, "撤销设备和项目授权，并停止其未结束交接？")), token);
        return panel;
    }
    private async Task<UIElement> AdminAsync(CancellationToken token)
    {
        if (repository.User.Text("role") is not ("admin" or "super_admin")) throw new InvalidOperationException("当前账户没有系统管理权限。");
        var panel = Page("系统管理", "管理操作使用服务端权限校验；不自动修改模型配置或真实凭据。");
        if (repository.User.Text("role") == "super_admin") panel.Children.Add(Action("AI 模型接入与语音配置", () => ReplaceAsync(AdminAiAsync)));
        await AddPagedAsync(panel, "/admin/accounts?limit=50", row =>
        {
            var name = Ui.Field("显示名称", row.Text("displayName"), max: 64); var box = Ui.Stack(Ui.Label(row.Text("username"), 20), Ui.Label("账户等级 " + row.Text("role")), name,
                Action("保存显示名称", async () => { await WriteAsync("PATCH", "/admin/accounts/" + Escape(row.Text("id")) + "/profile", new JsonObject { ["displayName"] = name.Text.Trim() }); await NavigateAsync("admin"); }));
            if (repository.User.Text("role") == "super_admin")
            {
                var role = Ui.Choice("账户等级", [("user", "一般用户"), ("admin", "普通管理员"), ("super_admin", "超级管理员")], row.Text("role")); box.Children.Add(role); box.Children.Add(Action("保存账户等级", async () => { await WriteAsync("PATCH", "/admin/accounts/" + Escape(row.Text("id")) + "/role", new JsonObject { ["role"] = role.Value() }); await NavigateAsync("admin"); }, "调整此账户等级？这会改变系统管理权限。"));
            }
            return Ui.Card(box);
        }, token);
        var retry = await repository.GetAsync("/admin/ai-retries", token);
        panel.Children.Add(Ui.Card(Ui.Label("AI 待重试", 20), Ui.Label("待重试 " + retry.Text("pendingRetryCount")), Action("清除待重试记录", async () => { await WriteAsync("DELETE", "/admin/ai-retries"); await NavigateAsync("admin"); }, "仅清除尚未领取的待重试记录。原日志、失败任务及正在处理和已排队条目保留。")));
        return panel;
    }
}
