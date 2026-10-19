using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> PersonalProfileAsync(CancellationToken token)
    {
        var saved = await repository.GetAsync("/auth/personal-profile", token);
        var recovery = await repository.Store.LoadDraftAsync("personal-profile");
        var profile = recovery?["profile"] ?? saved;
        var imports = recovery?["legacyImports"]?.DeepClone() as JsonArray ?? new JsonArray();
        var panel = Page("全局个人资料与隐私", "公开展示和项目 AI 使用分别授权。导入旧资料时默认不公开，并关闭相关 AI 授权。");
        var fields = new Dictionary<string, TextBox>(); var visibility = new Dictionary<string, CheckBox>();
        foreach (var (key, label, max) in new[] { ("bio", "自我介绍（Markdown）", 4000), ("major", "专业", 160), ("specialties", "技能与特长", 800), ("preferredRoles", "倾向项目职位", 400) })
        {
            var input = Ui.Field(label, profile.Text(key), key == "bio", max); var check = new CheckBox { Content = "公开" + label, IsChecked = profile?["visibility"].Flag(key) == true };
            fields[key] = input; visibility[key] = check; panel.Children.Add(Ui.Card(input, check));
        }
        var hours = Ui.Field("每周可投入小时（0–168，可留空）", profile.Text("weeklyAvailableHours"), max: 8);
        var searchable = new CheckBox { Content = "允许按完整用户名找到我", IsChecked = profile.Flag("searchable") };
        var aiUse = new CheckBox { Content = "允许项目 AI 使用个人资料", IsChecked = profile.Flag("aiUseAllowed") };
        var expected = profile?["revision"].Copy();
        JsonObject Body()
        {
            double? number = null;
            if (hours.Text.Trim().Length > 0) { if (!double.TryParse(hours.Text, out var parsed) || !double.IsFinite(parsed) || parsed < 0 || parsed > 168) throw new InvalidOperationException("每周可投入小时应为 0–168，或留空。"); number = parsed; }
            var body = new JsonObject { ["searchable"] = searchable.IsChecked == true, ["aiUseAllowed"] = aiUse.IsChecked == true, ["weeklyAvailableHours"] = number, ["expectedRevision"] = expected.Copy(), ["legacyImports"] = imports.DeepClone() }; var visible = new JsonObject();
            foreach (var item in fields) { body[item.Key] = item.Value.Text; visible[item.Key] = visibility[item.Key].IsChecked == true; }
            body["visibility"] = visible; return body;
        }
        JsonObject Draft() { var body = Body(); body["revision"] = expected.Copy(); body.Remove("expectedRevision"); body.Remove("legacyImports"); return new JsonObject { ["profile"] = body, ["legacyImports"] = imports.DeepClone() }; }
        TrackDraft("personal-profile", Draft, fields.Values.Cast<Control>().Concat(visibility.Values).Concat([hours, searchable, aiUse]).ToArray());
        panel.Children.Add(Ui.Card(hours, searchable, aiUse, Ui.Label("草稿依据版本 " + expected), Action("保存资料与隐私设置", async () => { var body = Body(); await repository.Store.SaveDraftAsync("personal-profile", Draft()); await WriteAsync("PUT", "/auth/personal-profile", body); await repository.Store.DeleteDraftAsync("personal-profile"); draftDirty = false; await ReplaceAsync(PersonalProfileAsync); }, "按当前版本保存资料、公开范围及 AI 使用授权？", true)));
        var candidates = Ui.Stack(); panel.Children.Add(Action("读取旧项目资料导入候选", async () =>
        {
            candidates.Children.Clear(); await AddPagedAsync(candidates, "/auth/personal-profile/import-candidates?limit=50", candidate =>
            {
                var major = new CheckBox { Content = "导入专业：" + candidate.Text("major") }; var skills = new CheckBox { Content = "导入技能：" + string.Join("、", candidate.Rows("skills")) }; var time = new CheckBox { Content = "导入每周时长：" + candidate.Text("weeklyAvailableHours") };
                return Ui.Card(Ui.Label(candidate.Text("sourceProjectName"), 18), major, skills, time, Action("复制所选字段到草稿", async () =>
                {
                    var chosen = new JsonArray();
                    if (major.IsChecked == true) { fields["major"].Text = candidate.Text("major"); visibility["major"].IsChecked = false; chosen.Add("major"); }
                    if (skills.IsChecked == true) { fields["specialties"].Text = string.Join("、", candidate.Rows("skills")); visibility["specialties"].IsChecked = false; chosen.Add("specialties"); }
                    if (time.IsChecked == true) { hours.Text = candidate.Text("weeklyAvailableHours"); chosen.Add("weeklyAvailableHours"); }
                    if (chosen.Count == 0) return;
                    if (major.IsChecked == true || skills.IsChecked == true) aiUse.IsChecked = false;
                    var previous = imports.FirstOrDefault(x => x.Text("candidateId") == candidate.Text("candidateId")); if (previous != null) imports.Remove(previous);
                    imports.Add(new JsonObject { ["candidateId"] = candidate.Text("candidateId"), ["fields"] = chosen }); await repository.Store.SaveDraftAsync("personal-profile", Draft());
                }, "所选字段替换当前草稿；导入的专业和技能暂不公开，并关闭 AI 授权。保存后才生效。"));
            }, token);
        })); panel.Children.Add(candidates);
        var username = Ui.Field("查找公开资料：完整用户名", max: 32); var publicResult = Ui.Stack();
        panel.Children.Add(Ui.Card(username, Action("精确查找", async () =>
        {
            if (!Regex.IsMatch(username.Text.Trim(), "^[A-Za-z0-9_-]{3,32}$")) throw new InvalidOperationException("请填写 3–32 位完整用户名。");
            var result = await repository.GetAsync("/profiles/search?username=" + Escape(username.Text.Trim()), PageToken); var found = result.Rows().FirstOrDefault(); publicResult.Children.Clear();
            if (found == null) { publicResult.Children.Add(Ui.Label("未找到可公开显示的个人资料。")); return; }
            var response = await repository.GetAsync("/profiles/" + Escape(found.Text("username")), PageToken); var person = response?["profile"];
            if (person == null) { publicResult.Children.Add(Ui.Label("该个人资料当前不可公开查看。")); return; }
            publicResult.Children.Add(Ui.Label(person.Text("displayName"), 20)); foreach (var (key, label) in new[] { ("bio", "自我介绍"), ("major", "专业"), ("specialties", "技能"), ("preferredRoles", "倾向职位") }) if (person[key] != null) publicResult.Children.Add(Ui.Label(label + "：" + person.Text(key)));
        }), publicResult));
        return panel;
    }
}
