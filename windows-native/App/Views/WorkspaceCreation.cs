using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    public Func<string, Task>? AddCreationFileRequested { get; set; }
    private async Task<UIElement> AdvancedCreationAsync(CancellationToken token)
    {
        var key = "advanced-project-create"; var saved = await repository.Store.LoadDraftAsync(key); var id = saved.Text("draftId");
        if (id.Length > 0) return await CreationDraftAsync(id, token);
        var panel = Page("项目创建向导", "先保存私有草稿，再上传资料、生成目标与任务并人工核对。创建确认前不会建立正式项目。");
        var name = Ui.Field("项目名称", saved.Text("name"), max: 100); var brief = Ui.Field("项目背景与要求", saved.Text("brief"), true); var description = Ui.Field("项目说明", saved.Text("description"), true, 2000);
        var teamSize = Ui.Field("预计团队人数（1–100）", saved.Text("teamSize") is { Length: > 0 } size ? size : "1", max: 3);
        JsonObject Draft() => new() { ["name"] = name.Text, ["brief"] = brief.Text, ["description"] = description.Text, ["teamSize"] = teamSize.Text };
        TrackDraft(key, Draft, name, brief, description, teamSize);
        panel.Children.Add(Ui.Card(name, description, brief, teamSize, Action("保存并进入创建草稿", async () =>
        {
            if (name.Text.Trim().Length == 0 || !int.TryParse(teamSize.Text, out var size) || size < 1 || size > 100) throw new InvalidOperationException("请填写项目名称和 1–100 的团队人数。");
            var draft = await WriteAsync("POST", "/creation-drafts", new JsonObject { ["name"] = name.Text.Trim(), ["description"] = description.Text, ["brief"] = brief.Text, ["teamSize"] = size, ["aiCollaborationEnabled"] = true, ["planningMode"] = "automatic", ["assignmentMode"] = "automatic", ["evaluationMode"] = "automatic", ["progressionMode"] = "automatic", ["inviteUsernames"] = new JsonArray(), ["inviteLabels"] = new JsonArray() });
            var createdId = draft.Text("id"); await repository.Store.SaveDraftAsync(key, new JsonObject { ["draftId"] = createdId }); draftDirty = false; saveCurrentDraft = null; await ReplaceAsync(ct => CreationDraftAsync(createdId, ct));
        }, primary: true)));
        return panel;
    }
    private async Task<UIElement> CreationDraftAsync(string id, CancellationToken token)
    {
        var path = "/creation-drafts/" + Escape(id); var draft = await repository.GetAsync(path, token); var payload = draft?["payload"]?.DeepClone() as JsonObject ?? throw new InvalidOperationException("创建草稿缺少内容。");
        if (draft.Text("status") == "committed") return Ui.Stack(Ui.Heading("项目已创建"), Action("进入项目", () => OpenProjectAsync(draft.Text("projectId"))));
        var panel = Ui.Stack(Ui.Heading("项目创建草稿"), Ui.Label("草稿版本 " + draft.Text("revision") + " · 预览 " + draft.Text("previewState")), Action("刷新服务端草稿与执行状态", () => ReplaceAsync(ct => CreationDraftAsync(id, ct))));
        var recovery = await repository.Store.LoadDraftAsync("creation-payload:" + id); var editable = recovery?["payload"] ?? payload; var expectedRevision = recovery?["expectedRevision"].Copy() ?? draft?["revision"].Copy();
        var name = Ui.Field("项目名称", editable.Text("name"), max: 100); var description = Ui.Field("项目说明", editable.Text("description"), true, 2000); var brief = Ui.Field("项目背景与要求", editable.Text("brief"), true); var due = Ui.Field("截止日期（YYYY-MM-DD，可留空）", editable.Text("deadlineDate"), max: 10); var teamSize = Ui.Field("团队人数（1–100）", editable.Text("teamSize"), max: 3);
        var inviteUsernames = Ui.Field("邀请用户名（每行一个，最多 99 个）", string.Join("\n", editable.Rows("inviteUsernames")), true);
        var inviteLabels = Ui.Field("为待定成员创建邀请标识（每行一个）", string.Join("\n", editable.Rows("inviteLabels")), true);
        var enabled = new ToggleSwitch { Header = "启用项目 AI 协作", IsOn = editable.Flag("aiCollaborationEnabled") };
        var choices = new Dictionary<string, ComboBox>(); var modes = Ui.Stack();
        foreach (var (key, label) in new[] { ("planningMode", "任务规划"), ("assignmentMode", "任务分工"), ("evaluationMode", "提交验收"), ("progressionMode", "项目推进") }) { var box = Ui.Choice(label, [("manual", "人工处理"), ("automatic", "AI 自动处理")], editable.Text(key)); choices[key] = box; modes.Children.Add(box); }
        JsonObject CurrentPayload()
        {
            var copy = (JsonObject)payload.DeepClone(); copy["name"] = name.Text.Trim(); copy["description"] = description.Text; copy["brief"] = brief.Text;
            if (due.Text.Length > 0) { if (!DateOnly.TryParseExact(due.Text, "yyyy-MM-dd", out _)) throw new InvalidOperationException("截止日期格式应为 YYYY-MM-DD。"); copy["deadlineDate"] = due.Text; } else copy.Remove("deadlineDate");
            if (!int.TryParse(teamSize.Text, out var size) || size < 1 || size > 100) throw new InvalidOperationException("团队人数应为 1–100。");
            copy["teamSize"] = size; copy["aiCollaborationEnabled"] = enabled.IsOn;
            foreach (var choice in choices) copy[choice.Key] = choice.Value.Value();
            var usernames = inviteUsernames.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries); var labels = inviteLabels.Text.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (usernames.Length > 99 || labels.Length > 99 || usernames.Any(x => x.Length > 64) || labels.Any(x => x.Length > 80) || labels.Distinct().Count() != labels.Length) throw new InvalidOperationException("邀请用户名和标识最多各 99 个；用户名最长 64 字，标识最长 80 字且不能重复。");
            copy["inviteUsernames"] = new JsonArray(usernames.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()); copy["inviteLabels"] = new JsonArray(labels.Select(x => (JsonNode?)JsonValue.Create(x)).ToArray()); return copy;
        }
        TrackDraft("creation-payload:" + id, () => new JsonObject { ["expectedRevision"] = expectedRevision.Copy(), ["payload"] = CurrentPayload() }, new Control[] { name, description, brief, due, teamSize, inviteUsernames, inviteLabels, enabled }.Concat(choices.Values).ToArray());
        panel.Children.Add(Ui.Card(name, description, brief, due, teamSize, enabled, modes, inviteUsernames, inviteLabels, Action("保存草稿配置", async () => { await WriteAsync("PATCH", path, new JsonObject { ["expectedRevision"] = expectedRevision.Copy(), ["payload"] = CurrentPayload() }); await repository.Store.DeleteDraftAsync("creation-payload:" + id); draftDirty = false; saveCurrentDraft = null; await ReplaceAsync(ct => CreationDraftAsync(id, ct)); }, "保存配置后旧任务预览将失效，需重新核对。")));
        panel.Children.Add(Ui.Label("创建资料", 20));
        foreach (var file in draft.Rows("files")) panel.Children.Add(Ui.Card(Ui.Label(file.Text("name"), 18), Ui.Label(file.Flag("textReady") ? "正文可用于 AI" : "正文尚未就绪"), Ui.Label(file.Text("textError")), Ui.Label(file.Text("mediaError"))));
        if (AddCreationFileRequested != null) panel.Children.Add(Action("上传创建资料", async () => { await AddCreationFileRequested(id); await ReplaceAsync(ct => CreationDraftAsync(id, ct)); }));
        var execution = draft?["execution"];
        if (execution != null)
        {
            panel.Children.Add(Ui.Label("模型调用：本窗口 " + execution.Text("windowCalls") + " / " + execution.Text("limit") + " · 累计 " + execution.Text("totalCalls") + " · " + execution.Text("state")));
            foreach (var (action, label) in new[] { ("continue", "继续处理"), ("output", "输出当前结果"), ("cancel", "取消当前执行") })
            {
                var button = Action(label, async () => { await WriteAsync("POST", path + "/execution/" + action, new JsonObject { ["expectedGeneration"] = execution["generation"].Copy() }); await ReplaceAsync(ct => CreationDraftAsync(id, ct)); }, action == "cancel" ? "停止当前 AI 执行？已保存草稿与文件保留。" : "继续处理可能调用模型并产生费用。请求结果未知时请先核对供应商记录。");
                button.IsEnabled = action == "cancel" || execution.Flag(action == "continue" ? "canContinue" : "canOutput"); panel.Children.Add(button);
            }
        }
        var question = draft?["clarification"];
        if (question != null && question.Text("status") == "pending")
        {
            var options = Ui.Choice("回答方式", new[] { ("", "自由填写回答") }.Concat(question.Rows("options").Select(x => (x.ToString(), x.ToString()))).Concat(question.Flag("allowUndecided") ? [("__undecided", "尚未决定")] : [])); var answer = Ui.Field("补充回答", "", true);
            panel.Children.Add(Ui.Card(Ui.Label(question.Text("question"), 20), Ui.Label(question.Text("reason")), options, answer, Action("提交回答并继续", async () =>
            {
                var body = new JsonObject { ["expectedRevision"] = question["revision"].Copy() }; if (options.Value() == "__undecided") body["undecided"] = true; else if (options.Value().Length > 0) body["option"] = options.Value(); else { if (answer.Text.Trim().Length == 0) throw new InvalidOperationException("请填写回答、选择选项或选择尚未决定。"); body["text"] = answer.Text.Trim(); }
                await WriteAsync("POST", path + "/clarifications/" + Escape(question.Text("id")) + "/answer", body); await ReplaceAsync(ct => CreationDraftAsync(id, ct));
            }, "保存回答并继续调用模型？"), Action("取消本次澄清", async () => { await WriteAsync("POST", path + "/clarifications/" + Escape(question.Text("id")) + "/cancel", new JsonObject { ["expectedRevision"] = question["revision"].Copy() }); await ReplaceAsync(ct => CreationDraftAsync(id, ct)); }, "取消澄清后可手动修改任务预览。")));
        }
        if (draft.Text("previewError").Length > 0) panel.Children.Add(Ui.Label(draft.Text("previewError")));
        var generate = Action("AI 生成目标与任务预览", async () => { await WriteAsync("POST", path + "/preview", new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["mode"] = "ai", ["background"] = true, ["regenerate"] = draft.Text("previewAttemptId").Length > 0, ["tasks"] = new JsonArray() }); await ReplaceAsync(ct => CreationDraftAsync(id, ct)); }, "调用配置模型读取草稿资料并生成目标及任务？结果需核对后才能创建项目。", true);
        generate.IsEnabled = draft.Text("previewState") is not ("running" or "waiting_input") && draft.Text("status") == "active"; panel.Children.Add(generate);
        panel.Children.Add(Action("人工编辑目标与任务预览", () => ReplaceAsync(ct => CreationPreviewEditorAsync(draft, ct))));
        if (draft.Text("previewState") == "ready" && draft.Text("previewRevision") == draft.Text("revision"))
        {
            panel.Children.Add(Ui.Card(Ui.Label("当前主目标", 20), Ui.Label(draft?["preview"]?["goal"].Text("title") ?? ""), Ui.Label(draft?["preview"]?["goal"].Text("detail") ?? "")));
            foreach (var task in draft?["preview"].Rows("tasks") ?? []) panel.Children.Add(Ui.Card(Ui.Label(task.Text("title"), 18), Ui.Label(task.Text("criteria")), Ui.Label("预计 " + task.Text("effortHours") + " 小时")));
            panel.Children.Add(Action("确认创建项目", async () =>
            {
                var latest = await repository.GetAsync(path, PageToken);
                if (latest.Text("revision") != draft.Text("revision") || latest.Text("previewAttemptId") != draft.Text("previewAttemptId") || latest?["preview"]?.ToJsonString() != draft?["preview"]?.ToJsonString() || latest.Text("previewState") != "ready") throw new InvalidOperationException("服务端草稿或任务预览已变化，请刷新后重新核对。");
                var result = await WriteAsync("POST", path + "/commit", new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["expectedPreviewAttemptId"] = draft?["previewAttemptId"].Copy(), ["confirmed"] = true });
                await repository.Store.DeleteDraftAsync("advanced-project-create"); await repository.Store.DeleteDraftAsync("creation-payload:" + id); draftDirty = false; saveCurrentDraft = null; await OpenProjectAsync(result.Text("projectId"));
            }, "确认以当前目标、任务及邀请配置创建正式项目？", true));
        }
        return panel;
    }
    private Task<UIElement> CreationPreviewEditorAsync(JsonNode? draft, CancellationToken token)
    {
        var id = draft.Text("id"); var path = "/creation-drafts/" + Escape(id); var preview = draft?["preview"]; var goal = preview?["goal"] ?? draft?["payload"]?["goal"];
        var panel = Ui.Stack(Ui.Heading("人工核对目标与任务预览"), Ui.Label("修改不会自动创建项目。保存预览后返回创建确认。"));
        var goalTitle = Ui.Field("项目主目标", goal.Text("title") is { Length: > 0 } title ? title : draft?["payload"].Text("name"), max: 200); var goalDetail = Ui.Field("目标说明", goal.Text("detail"), true, 12000); panel.Children.Add(Ui.Card(goalTitle, goalDetail));
        var tasks = new List<(JsonObject Original, TextBox Title, TextBox Detail, TextBox Criteria, TextBox Hours, Border Card)>(); var cards = Ui.Stack(); panel.Children.Add(cards);
        void Add(JsonNode? original)
        {
            if (tasks.Count >= 20) return;
            var item = original?.DeepClone() as JsonObject ?? new JsonObject { ["key"] = "t" + Guid.NewGuid().ToString("N")[..8], ["dependsOn"] = new JsonArray(), ["citations"] = new JsonArray() };
            var name = Ui.Field("任务名称", item.Text("title"), max: 200); var detail = Ui.Field("任务说明", item.Text("detail"), true); var criteria = Ui.Field("验收标准", item.Text("criteria"), true); var hours = Ui.Field("预计投入小时（0.25–200）", item.Text("effortHours") is { Length: > 0 } effort ? effort : "1", max: 8); var box = Ui.Stack(name, detail, criteria, hours); var card = Ui.Card(box); var entry = (item, name, detail, criteria, hours, card); tasks.Add(entry); cards.Children.Add(card);
            if (item.Rows("citations").Count > 0) box.Children.Add(Ui.Label("已保留 " + item.Rows("citations").Count + " 条固定来源引用。"));
            box.Children.Add(Action("删除此预览任务", () => { tasks.Remove(entry); cards.Children.Remove(card); return Task.CompletedTask; }, "从当前预览移除此任务？正式项目尚未创建。"));
        }
        foreach (var item in preview.Rows("tasks")) Add(item);
        panel.Children.Add(Action("添加预览任务", () => { Add(null); return Task.CompletedTask; }));
        panel.Children.Add(Action("保存人工核对的预览", async () =>
        {
            if (goalTitle.Text.Trim().Length == 0) throw new InvalidOperationException("请填写项目主目标。"); var items = new JsonArray(); var keys = tasks.Select(x => x.Original.Text("key")).ToHashSet();
            foreach (var task in tasks)
            {
                if (task.Title.Text.Trim().Length == 0 || task.Criteria.Text.Trim().Length == 0 || !double.TryParse(task.Hours.Text, out var hours) || !double.IsFinite(hours) || hours < .25 || hours > 200) throw new InvalidOperationException("每项任务需要名称、验收标准和 0.25–200 的投入小时。");
                var item = (JsonObject)task.Original.DeepClone(); item["title"] = task.Title.Text.Trim(); item["detail"] = task.Detail.Text; item["criteria"] = task.Criteria.Text.Trim(); item["effortHours"] = hours; item["dependsOn"] = new JsonArray(item.Rows("dependsOn").Where(x => keys.Contains(x.ToString())).Select(x => x.DeepClone()).ToArray()); items.Add(item);
            }
            await WriteAsync("POST", path + "/preview", new JsonObject { ["expectedRevision"] = draft?["revision"].Copy(), ["mode"] = "manual", ["goal"] = new JsonObject { ["title"] = goalTitle.Text.Trim(), ["detail"] = goalDetail.Text }, ["tasks"] = items, ["regenerate"] = true }); await ReplaceAsync(ct => CreationDraftAsync(id, ct));
        }, "保存此目标与任务预览？保留各项任务的原始来源引用。", true));
        return Task.FromResult<UIElement>(panel);
    }
}
