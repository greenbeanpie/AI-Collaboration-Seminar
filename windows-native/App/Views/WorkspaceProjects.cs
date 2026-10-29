using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> DashboardAsync(CancellationToken token)
    {
        var panel = Page("我的项目", "让每个项目有序向前，让下一步清晰可见。");
        panel.Children.Add(Action("新建项目", () => NavigateAsync("create-project"), primary: true));
        var search = Ui.Field("搜索项目名称或说明", "", max: 200);
        var state = Ui.Choice("项目状态", [("active", "当前项目"), ("archived", "已归档")]);
        var records = Ui.Stack();
        async Task SearchAsync()
        {
            records.Children.Clear();
            await AddPagedAsync(records, "/projects?limit=20&status=" + state.Value() + "&q=" + Escape(search.Text.Trim()), item =>
                Ui.Card(Ui.Label(item.Text("name"), 21), Ui.Label(item.Text("description")),
                    Ui.Label((item.Text("myRole") == "owner" ? "负责人" : "项目成员") + " · " + Ui.Status(item.Text("status")) + " · " + (item.Text("deadlineDate") is { Length: > 0 } date ? "截止 " + date : "截止待确认")),
                    Action("进入项目", () => OpenProjectAsync(item.Text("id")), primary: true)), token, virtualize: true);
        }
        panel.Children.Add(Ui.Card(search, state, Action("搜索", SearchAsync)));
        panel.Children.Add(records);
        await SearchAsync();
        return panel;
    }
    private async Task<UIElement> OverviewAsync(CancellationToken token)
    {
        var root = Base;
        var projectTask = repository.GetAsync(root, token); var goalTask = repository.GetAsync(root + "/goal", token); var graphTask = repository.GetAsync(root + "/tasks/graph", token);
        await Task.WhenAll(projectTask, goalTask, graphTask);
        project = projectTask.Result;
        var goal = goalTask.Result; var tasks = graphTask.Result.Rows();
        var panel = Page(project.Text("name"), project.Text("description"));
        var done = tasks.Count(x => x.Text("status") == "done");
        panel.Children.Add(Ui.Card(Ui.Label("项目主目标", 20), Ui.Label(goal.Text("title"), 18), Ui.Label(goal.Text("detail")), Ui.Label("目标版本 " + goal.Text("revision"))));
        panel.Children.Add(Ui.Card(Ui.Label("任务进度", 20), Ui.Label($"已完成 {done} / {tasks.Count} 项"), new ProgressBar { Minimum = 0, Maximum = Math.Max(tasks.Count, 1), Value = done }, Action("查看任务", () => NavigateAsync("tasks"))));
        await AddTaskFocusAsync(panel, token);
        return panel;
    }
    private async Task<UIElement> CreateProjectAsync(CancellationToken token)
    {
        var panel = Page("新建项目", "先保存项目草稿，再预览并确认创建。模板内容与服务端默认设置保持兼容。");
        panel.Children.Add(Action("项目创建向导（AI 规划、团队与资料）", () => ReplaceAsync(AdvancedCreationAsync)));
        var key = "project-create";
        var restored = await repository.Store.LoadDraftAsync(key);
        var draftId = restored.Text("draftId");
        JsonNode? draft = draftId.Length > 0 ? await repository.GetAsync("/creation-drafts/" + Escape(draftId), token) : null;
        var payload = draft?["payload"]?.DeepClone() as JsonObject;
        var name = Ui.Field("项目名称", restored.Text("name") is { Length: > 0 } n ? n : payload.Text("name"), max: 100);
        var description = Ui.Field("项目说明", restored.Text("description") is { Length: > 0 } d ? d : payload.Text("description"), true, 2000);
        var goal = Ui.Field("主目标", restored?["goalTitle"]?.ToString() ?? payload?["goal"].Text("title"), max: 200);
        var goalDetail = Ui.Field("目标说明", restored?["goalDetail"]?.ToString() ?? payload?["goal"].Text("detail"), true);
        var due = Ui.Field("截止日期（YYYY-MM-DD，可留空）", restored?["deadlineDate"]?.ToString() ?? payload.Text("deadlineDate"), max: 10);
        var status = Ui.Label(draft == null ? "尚未创建服务端草稿" : "服务端草稿已恢复 · 版本 " + draft.Text("revision"));
        TrackDraft(key, () => new JsonObject { ["draftId"] = draftId, ["name"] = name.Text, ["description"] = description.Text, ["goalTitle"] = goal.Text, ["goalDetail"] = goalDetail.Text, ["deadlineDate"] = due.Text }, name, description, goal, goalDetail, due);
        panel.Children.Add(Ui.Card(name, description, goal, goalDetail, due, status));
        panel.Children.Add(Action("保存本机草稿", async () => { await repository.Store.SaveDraftAsync(key, new JsonObject { ["draftId"] = draftId, ["name"] = name.Text, ["description"] = description.Text }); StatusChanged?.Invoke("本机草稿已保存。"); }));
        var preview = Ui.Stack(); panel.Children.Add(preview);
        panel.Children.Add(Action("保存并预览项目", async () =>
        {
            if (string.IsNullOrWhiteSpace(name.Text)) throw new InvalidOperationException("请输入项目名称。");
            if (due.Text.Length > 0 && !DateOnly.TryParseExact(due.Text, "yyyy-MM-dd", out _)) throw new InvalidOperationException("截止日期格式应为 YYYY-MM-DD。");
            if (draft == null) { draft = await WriteAsync("POST", "/creation-drafts/from-template", new JsonObject { ["templateId"] = "blank" }); draftId = draft.Text("id"); }
            await repository.Store.SaveDraftAsync(key, new JsonObject { ["draftId"] = draftId, ["name"] = name.Text, ["description"] = description.Text });
            payload = draft?["payload"]?.DeepClone() as JsonObject ?? throw new InvalidOperationException("草稿缺少项目内容，请刷新。");
            payload["name"] = name.Text.Trim(); payload["description"] = description.Text.Trim();
            payload["goal"] = new JsonObject { ["title"] = string.IsNullOrWhiteSpace(goal.Text) ? name.Text.Trim() : goal.Text.Trim(), ["detail"] = goalDetail.Text.Trim() };
            if (due.Text.Length > 0) payload["deadlineDate"] = due.Text; else payload.Remove("deadlineDate");
            draft = await WriteAsync("PATCH", "/creation-drafts/" + Escape(draftId), new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["payload"] = payload.DeepClone() });
            draft = await WriteAsync("POST", "/creation-drafts/" + Escape(draftId) + "/preview", new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["mode"] = "manual", ["goal"] = payload["goal"].Copy(), ["tasks"] = new JsonArray(), ["regenerate"] = true });
            preview.Children.Clear(); preview.Children.Add(Ui.Card(Ui.Label("创建前核对", 20), Ui.Label(name.Text), Ui.Label(goal.Text), Ui.Label(description.Text), Ui.Label("此项目初始任务为空；创建后可在任务协作中添加。"),
                Action("确认创建项目", async () => { var result = await WriteAsync("POST", "/creation-drafts/" + Escape(draftId) + "/commit", new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["confirmed"] = true }); await repository.Store.DeleteDraftAsync(key); await OpenProjectAsync(result.Id("projectId", "id")); }, "确认以刚刚预览的内容创建项目？", true)));
            status.Text = "预览已更新 · 草稿版本 " + draft.Text("revision");
        }, primary: true));
        return panel;
    }
    private async Task<UIElement> JoinAsync(CancellationToken token)
    {
        var panel = Page("加入团队", "核对项目后再接受邀请。"); var code = Ui.Field("项目邀请码", max: 200); var preview = Ui.Stack();
        panel.Children.Add(Ui.Card(code, Action("预览邀请项目", async () =>
        {
            var value = code.Text.Trim(); var item = await WriteAsync("POST", "/invitations/preview", new JsonObject { ["code"] = value });
            preview.Children.Clear(); preview.Children.Add(Ui.Card(Ui.Label(item.Id("name", "projectName"), 20), Ui.Label(item.Text("description")),
                Action("确认加入", async () => { var result = await WriteAsync("POST", "/invitations/accept", new JsonObject { ["code"] = value }); await OpenProjectAsync(result.Text("projectId")); }, "确定加入预览中的项目？")));
        }), preview));
        var inbox = await repository.GetAsync("/invitations/inbox?offset=0", token);
        foreach (var invite in inbox.Rows()) panel.Children.Add(Ui.Card(Ui.Label(invite.Text("projectName"), 18), Ui.Label(Ui.Status(invite.Text("status"))), Ui.Label("邀请人 " + invite.Text("inviterName")),
            Action("核对邀请详情", async () => { var value = await repository.GetAsync("/invitations/inbox/" + Escape(invite.Text("id")) + "/preview", PageToken); preview.Children.Clear(); preview.Children.Add(Ui.Card(Ui.Label(value.Text("description")), Action("接受邀请", async () => { var result = await WriteAsync("POST", "/invitations/inbox/" + Escape(invite.Text("id")), new JsonObject { ["action"] = "accept" }); await OpenProjectAsync(result.Text("projectId")); }, "确认加入此项目？"))); })));
        return panel;
    }
    private async Task<UIElement> ActivityAsync(CancellationToken token)
    {
        var panel = Page("项目活动", "按服务端时间展示项目操作历史。");
        await AddPagedAsync(panel, Base + "/events?limit=30", row => Ui.Card(Ui.Label(row.Id("summary", "action", "type"), 18), Ui.Label(row.Id("actorName", "displayName")), Ui.Label(row.Id("occurredAt", "createdAt"))), token);
        return panel;
    }
    private async Task<UIElement> ProjectSettingsAsync(CancellationToken token)
    {
        var current = await repository.GetAsync(Base, token); var goal = await repository.GetAsync(Base + "/goal", token); var collaboration = await repository.GetAsync(Base + "/collaboration/settings", token);
        var panel = Page("项目设置", "本机草稿保留原始版本；服务端变化时拒绝覆盖并保留输入。"); var edit = membership.Text("role") == "owner";
        var name = Ui.Field("项目名称", current.Text("name"), max: 100); var description = Ui.Field("项目说明", current.Text("description"), true, 2000);
        var basic = await TrackFormAsync("project-basic:" + projectId, new() { ["name"] = name, ["description"] = description }, current?["revision"]);
        var save = Action("保存项目信息", async () => { var submitted = basic.Snapshot(); await WriteAsync("PATCH", Base, new JsonObject { ["expectedRevision"] = basic.Identity.Copy(), ["name"] = name.Text.Trim(), ["description"] = description.Text.Trim() }); await FinishFormAsync(basic, submitted); draftDirty = false; saveCurrentDraft = null; await NavigateAsync("project-settings"); }); save.IsEnabled = edit; panel.Children.Add(Ui.Card(name, description, save));
        var title = Ui.Field("项目主目标", goal.Text("title"), max: 200); var detail = Ui.Field("目标说明", goal.Text("detail"), true,12000);
        var target = await TrackFormAsync("project-goal:" + projectId, new() { ["title"] = title, ["detail"] = detail }, goal?["revision"]);
        var saveGoal = Action("保存主目标", async () => { var submitted = target.Snapshot(); await WriteAsync("PATCH", Base + "/goal", new JsonObject { ["expectedRevision"] = target.Identity.Copy(), ["title"] = title.Text.Trim(), ["detail"] = detail.Text.Trim() }); await FinishFormAsync(target, submitted); draftDirty = false; saveCurrentDraft = null; await NavigateAsync("project-settings"); }); saveGoal.IsEnabled = edit; panel.Children.Add(Ui.Card(title, detail, saveGoal));
        var enabled = new ToggleSwitch { Header = "启用本项目 AI 协作", IsOn = collaboration.Flag("aiCollaborationEnabled"), IsEnabled = edit }; var options = new Dictionary<string, Control> { ["aiCollaborationEnabled"] = enabled }; var settings = Ui.Stack(Ui.Label("AI 协作规则", 20), enabled);
        foreach (var (key,label) in new[] { ("planningMode","任务规划"),("assignmentMode","任务分工"),("evaluationMode","提交验收"),("progressionMode","项目推进") }) { var box = Ui.Choice(label,[("manual","负责人事先确认"),("automatic","允许 AI 自动应用")],collaboration.Text(key)); box.IsEnabled=edit; options[key]=box; settings.Children.Add(box); }
        var rules = await TrackFormAsync("project-collaboration:" + projectId, options, collaboration?["revision"]);
        var saveRules=Action("保存 AI 协作规则",async()=>{var submitted=rules.Snapshot();var body=submitted["fields"]!.DeepClone().AsObject();body["expectedRevision"]=rules.Identity.Copy();await WriteAsync("PATCH",Base+"/collaboration/settings",body);await FinishFormAsync(rules,submitted);draftDirty=false;saveCurrentDraft=null;await NavigateAsync("project-settings");},"自动模式可能使后续 AI 规划、分工、验收或推进自动生效。确认保存？");saveRules.IsEnabled=edit;settings.Children.Add(saveRules);panel.Children.Add(Ui.Card(settings));
        if(!edit)panel.Children.Add(Action("退出项目",async()=>{await WriteAsync("DELETE",Base+"/members/me");projectId=null;project=null;membership=null;BuildNavigation();await NavigateAsync("projects");},"退出后失去此项目访问权限，原项目数据保留。本机未同步内容不会提交。"));
        if(edit)panel.Children.Add(Action(current.Text("status")=="archived"?"恢复项目":"归档项目",async()=>{await WriteAsync("PATCH",Base,new JsonObject{["expectedRevision"]=current?["revision"].Copy(),["status"]=current.Text("status")=="archived"?"active":"archived"});await NavigateAsync("project-settings");},"更新项目归档状态？项目数据和历史记录保留。"));
        return panel;
    }
}
