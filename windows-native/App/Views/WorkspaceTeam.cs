using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private static readonly (string Id, string Label)[] PermissionLabels = [("teamManage", "团队管理"), ("taskManage", "任务管理"), ("resourceManage", "资料管理"), ("scoreInitiate", "评分发起"), ("scoreCorrect", "历史评分修正")];
    private async Task<UIElement> TeamAsync(CancellationToken token)
    {
        membership = await repository.GetAsync(Base + "/members/me", token);
        var panel = Page("团队成员", "项目权限以当前成员身份为准，系统管理员身份不自动获得项目权限。");
        await AddPagedAsync(panel, Base + "/members?limit=100", member =>
        {
            var box = Ui.Stack(Ui.Label(member.Text("displayName"), 20), Ui.Label(member.Text("username")), Ui.Label(member.Text("role") == "owner" ? "项目负责人" : "项目成员"));
            var permissions = new Dictionary<string, CheckBox>();
            foreach (var (key, label) in PermissionLabels)
            {
                var check = new CheckBox { Content = label, IsChecked = member?["permissions"].Flag(key) == true || member.Text("role") == "owner", IsEnabled = membership.Text("role") == "owner" && member.Text("role") != "owner" };
                permissions[key] = check; box.Children.Add(check);
            }
            if (membership.Text("role") == "owner" && member.Text("role") != "owner") box.Children.Add(Action("保存成员权限", async () =>
            { var body = new JsonObject(); foreach (var item in permissions) body[item.Key] = item.Value.IsChecked == true; await WriteAsync("PATCH", Base + "/members/" + Escape(member.Text("userId")) + "/permissions", new JsonObject { ["expectedRevision"] = member?["permissionsRevision"].Copy(), ["permissions"] = body }); await NavigateAsync("team"); }, "确认调整此成员的项目权限？"));
            if (Can("teamManage") && member.Text("role") != "owner" && member.Text("userId") != repository.AccountId) box.Children.Add(Action("移除成员", async () => { await WriteAsync("DELETE", Base + "/members/" + Escape(member.Text("userId"))); await NavigateAsync("team"); }, "移除后对方将失去此项目访问权限。"));
            return Ui.Card(box);
        }, token);
        var username = Ui.Field("对方用户名", max: 64);
        panel.Children.Add(Ui.Card(Ui.Label("邀请成员", 20), username, Action("提交邀请申请", async () => { if (username.Text.Trim().Length == 0) return; await WriteAsync("POST", Base + "/invitation-requests", new JsonObject { ["username"] = username.Text.Trim() }); await NavigateAsync("team"); })));
        await AddPagedAsync(panel, Base + "/invitation-requests?limit=50", row =>
        {
            var box = Ui.Stack(Ui.Label(row.Text("username"), 18), Ui.Label(Ui.Status(row.Text("status"))));
            if (Can("teamManage") && row.Text("status") == "pending") foreach (var (action, title) in new[] { ("approve", "批准申请"), ("reject", "拒绝申请") }) box.Children.Add(Action(title, async () => { await WriteAsync("POST", Base + "/invitation-requests/" + Escape(row.Text("id")) + "/decide", new JsonObject { ["expectedRevision"] = row["revision"].Copy(), ["action"] = action }); await NavigateAsync("team"); }, "确认" + title + "？"));
            return Ui.Card(box);
        }, token);
        if (Can("teamManage"))
        {
            var maxUses = Ui.Field("邀请码使用次数（留空不限，1–100）", max: 3); var days = Ui.Field("有效天数（1–30）", "7", max: 2); var result = Ui.Label("");
            panel.Children.Add(Ui.Card(Ui.Label("创建邀请码", 20), maxUses, days, result, Action("创建邀请码", async () =>
            {
                if (!int.TryParse(days.Text, out var duration) || duration < 1 || duration > 30) throw new InvalidOperationException("有效天数应为 1–30。");
                int? uses = null; if (maxUses.Text.Length > 0) { if (!int.TryParse(maxUses.Text, out var count) || count < 1 || count > 100) throw new InvalidOperationException("使用次数应为 1–100，或留空不限。"); uses = count; }
                var value = await WriteAsync("POST", Base + "/invitations", new JsonObject { ["maxUses"] = uses, ["expiresInDays"] = duration }); result.Text = "请保存仅显示一次的邀请码：" + value.Text("code");
            })));
        }
        return panel;
    }
}
