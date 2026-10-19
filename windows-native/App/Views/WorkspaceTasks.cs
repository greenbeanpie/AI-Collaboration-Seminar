using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> TasksAsync(CancellationToken token)
    {
        var panel = Page("任务协作", "前置依赖用于提示，可以提前领取、执行和提交。权限由当前项目成员身份决定。");
        var graph = await repository.GetAsync(Base + "/tasks/graph", token);
        if (Can("taskManage")) panel.Children.Add(Action("新建任务", () => ReplaceAsync(ct => TaskEditorAsync(null, graph, ct)), primary: true));
        var query = Ui.Field("搜索任务", max: 200);
        var filter = Ui.Choice("任务状态", [("", "全部"), ("open", "待领取"), ("in_progress", "执行中"), ("submitted", "待验收"), ("accepted", "已完成"), ("improve", "需改进"), ("rework", "需重做")]);
        var mine = new CheckBox { Content = "只看分配给我的任务" }; var records = Ui.Stack();
        async Task SearchAsync()
        {
            records.Children.Clear();
            var path = Base + "/tasks?limit=50&q=" + Escape(query.Text.Trim()) + (filter.Value().Length > 0 ? "&lifecycleState=" + filter.Value() : "") + (mine.IsChecked == true ? "&assigneeId=" + Escape(repository.AccountId!) : "");
            await AddPagedAsync(records, path, task => Ui.Card(Ui.Label(task.Text("title"), 20), Ui.Label(Ui.Status(task.Text("lifecycleState"))), Ui.Label("截止 " + (task.Text("dueDate") is { Length: > 0 } due ? due : "待确认")), Action("查看与处理", () => ReplaceAsync(ct => TaskDetailAsync(task.Text("taskId"), ct)))), token);
        }
        panel.Children.Add(Ui.Card(query, filter, mine, Action("搜索", SearchAsync))); panel.Children.Add(records); await SearchAsync();
        return panel;
    }
    private async Task<UIElement> TaskEditorAsync(JsonNode? task, JsonNode? graph, CancellationToken token)
    {
        var panel = Page(task == null ? "新建任务" : "任务设置", "保存前会按最新任务版本和依赖图版本核对。");
        var key = "task-editor:" + projectId + ":" + task.Id("taskId", "id");
        var draft = await repository.Store.LoadDraftAsync(key);
        var title = Ui.Field("任务名称", draft?.Text("title") ?? task.Text("title"), max: 200);
        var detail = Ui.Field("任务说明", draft?.Text("detail") ?? task.Text("detail"), true);
        var criteria = Ui.Field("验收标准", draft?.Text("criteria") ?? task.Text("criteria"), true);
        var effort = Ui.Field("预计投入（小时，0.25–200）", draft?.Text("effortHours") ?? (task.Text("effortHours") is { Length: > 0 } h ? h : "1"), max: 8);
        var due = Ui.Field("截止日期（YYYY-MM-DD，留空未知）", draft?.Text("dueDate") ?? task.Text("dueDate"), max: 10);
        var members = (await repository.GetAsync(Base + "/members?limit=100", token)).Rows();
        var assignee = Ui.Choice("负责人", new[] { ("", "暂不分配") }.Concat(members.Select(m => (m.Text("userId"), m.Text("displayName")))), task.Text("assigneeId"));
        var dependencies = new Dictionary<string, CheckBox>(); var dependencyPanel = Ui.Stack(Ui.Label("前置任务"));
        foreach (var row in graph.Rows().Where(x => x.Text("taskId") != task.Text("taskId")))
        { var box = new CheckBox { Content = row.Text("title"), IsChecked = task.Rows("dependsOnTaskIds").Any(x => x.ToString() == row.Text("taskId")) }; dependencies[row.Text("taskId")] = box; dependencyPanel.Children.Add(box); }
        JsonObject ContentBody() => new() { ["title"] = title.Text.Trim(), ["detail"] = detail.Text.Trim(), ["criteria"] = criteria.Text.Trim(), ["effortHours"] = effort.Text, ["dueDate"] = due.Text };
        panel.Children.Add(Ui.Card(title, detail, criteria, effort, due, Action("暂存到本机", async () => { await repository.Store.SaveDraftAsync(key, ContentBody()); StatusChanged?.Invoke("当前账户的任务草稿已保存。"); })));
        if (task == null) panel.Children.Add(Ui.Card(assignee, dependencyPanel));
        panel.Children.Add(Action(task == null ? "创建任务" : "保存任务内容", async () =>
        {
            if (title.Text.Trim().Length == 0 || criteria.Text.Trim().Length == 0) throw new InvalidOperationException("请填写任务名称和验收标准。");
            if (!double.TryParse(effort.Text, out var hours) || hours < .25 || hours > 200) throw new InvalidOperationException("预计投入应为 0.25–200 小时。");
            if (due.Text.Length > 0 && !DateOnly.TryParseExact(due.Text, "yyyy-MM-dd", out _)) throw new InvalidOperationException("请填写 YYYY-MM-DD 日期。");
            var body = ContentBody(); await repository.Store.SaveDraftAsync(key, body.DeepClone()); body["effortHours"] = hours; body["dueDate"] = due.Text.Length == 0 ? null : JsonValue.Create(due.Text); body["duePrecision"] = due.Text.Length == 0 ? "unknown" : "date";
            if (task == null) { body["assigneeId"] = assignee.Value().Length == 0 ? null : JsonValue.Create(assignee.Value()); body["expectedGraphRevision"] = graph?["graphRevision"].Copy(); body["dependsOnTaskIds"] = new JsonArray(dependencies.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray()); }
            else body["expectedRevision"] = task["revision"].Copy();
            var result = await WriteAsync(task == null ? "POST" : "PATCH", Base + "/tasks" + (task == null ? "" : "/" + Escape(task.Text("taskId"))), body, true);
            if (result.Flag("queued") || result.Flag("offlinePending")) { StatusChanged?.Invoke("任务修改已保存到本机等待同步；服务端状态尚未更新。"); return; }
            await repository.Store.DeleteDraftAsync(key);
            await NavigateAsync("tasks");
        }, primary: true));
        return panel;
    }
    private async Task<UIElement> TaskDetailAsync(string id, CancellationToken token)
    {
        var path = Base + "/tasks/" + Escape(id); var task = await repository.GetAsync(path, token);
        var panel = Page(task.Text("title"), Ui.Status(task.Text("lifecycleState")) + " · 版本 " + task.Text("revision"));
        panel.Children.Add(Action("返回任务列表", () => NavigateAsync("tasks")));
        panel.Children.Add(Ui.Card(Ui.Label("任务说明", 20), Ui.Label(task.Text("detail")), Ui.Label("验收标准", 20), Ui.Label(task.Text("criteria"))));
        if (Can("taskManage")) panel.Children.Add(Action("编辑任务", async () => { var graph = await repository.GetAsync(Base + "/tasks/graph", PageToken); await ReplaceAsync(ct => TaskEditorAsync(task, graph, ct)); }));
        if (task.Text("assigneeId").Length == 0 && task.Text("lifecycleState") == "open") panel.Children.Add(Action("领取任务", async () => { await WriteAsync("POST", path + "/claim", new JsonObject { ["expectedRevision"] = task?["revision"].Copy() }); await ReplaceAsync(ct => TaskDetailAsync(id, ct)); }, "确认领取此任务？", true));
        var filesPanel = Ui.Stack(Ui.Label("本轮成果文件", 20));
        var files = (await repository.GetAsync(path + "/files?limit=100", token)).Rows();
        foreach (var file in files) filesPanel.Children.Add(Ui.Label(file.Id("name", "title") + (file.Text("archivedAt").Length > 0 ? " · 已归档" : "")));
        panel.Children.Add(Ui.Card(filesPanel));
        if (task.Text("assigneeId") == repository.AccountId && task.Text("lifecycleState") is "in_progress" or "improve" or "rework")
        {
            var key = "submission:" + projectId + ":" + id; var draft = await repository.Store.LoadDraftAsync(key);
            var text = Ui.Field("本轮成果说明", draft.Text("body"), true, 12000);
            panel.Children.Add(Ui.Card(text, Action("暂存成果说明", () => repository.Store.SaveDraftAsync(key, new JsonObject { ["body"] = text.Text, ["expectedRevision"] = task?["revision"].Copy() })), Action("提交本轮成果", async () =>
            {
                if (string.IsNullOrWhiteSpace(text.Text)) throw new InvalidOperationException("请输入成果说明。");
                await repository.Store.SaveDraftAsync(key, new JsonObject { ["body"] = text.Text, ["expectedRevision"] = task?["revision"].Copy() });
                var latestFiles = (await repository.GetAsync(path + "/files?limit=100", PageToken)).Rows().Where(f => f.Text("archivedAt").Length == 0 && f.Text("materialArchivedAt").Length == 0 && f.Text("deletedAt").Length == 0).ToList();
                if (latestFiles.Count > 10) throw new InvalidOperationException("当前成果文件超过 10 个，请先归档不参与本轮的文件。");
                await WriteAsync("POST", path + "/submissions", new JsonObject { ["expectedRevision"] = task?["revision"].Copy(), ["body"] = text.Text.Trim(), ["materialVersionIds"] = new JsonArray(latestFiles.Select(x => x["versionId"].Copy()).ToArray()) });
                await repository.Store.DeleteDraftAsync(key); await ReplaceAsync(ct => TaskDetailAsync(id, ct));
            }, "将固定当前文件版本并提交成果。项目启用 AI 时可能自动触发评价。", true)));
        }
        panel.Children.Add(Ui.Label("提交与验收历史", 20));
        await AddPagedAsync(panel, path + "/submissions?limit=30", row =>
        {
            var box = Ui.Stack(Ui.Label(row.Text("body")), Ui.Label(Ui.Status(row.Text("status")) + " · " + row.Text("createdAt")));
            if (Can("taskManage") && row.Text("submissionId") == task.Text("currentSubmissionId"))
            {
                var decision = Ui.Choice("人工验收", [("accept", "通过"), ("improve", "需改进"), ("rework", "需重做")]); var feedback = Ui.Field("验收理由", "", true);
                box.Children.Add(decision); box.Children.Add(feedback); box.Children.Add(Action("提交人工验收", async () => { if (string.IsNullOrWhiteSpace(feedback.Text)) throw new InvalidOperationException("请输入验收理由。"); await WriteAsync("POST", Base + "/collaboration/submissions/" + Escape(row.Text("submissionId")) + "/decide", new JsonObject { ["expectedRevision"] = row["revision"].Copy(), ["decision"] = decision.Value(), ["feedback"] = feedback.Text.Trim() }); await ReplaceAsync(ct => TaskDetailAsync(id, ct)); }, "确认以当前结论验收此成果？"));
            }
            return Ui.Card(box);
        }, token);
        panel.Children.Add(Action("任务讨论", () => ReplaceAsync(ct => TaskCommentsAsync(id, ct))));
        panel.Children.Add(Action("私密问询", () => ReplaceAsync(ct => TaskInquiriesAsync(id, ct))));
        return panel;
    }
    private async Task<UIElement> TaskCommentsAsync(string id, CancellationToken token)
    {
        var panel = Page("任务讨论", "讨论对当前项目可见。"); var path = Base + "/comments";
        await AddPagedAsync(panel, path + "?targetType=task&targetId=" + Escape(id) + "&limit=50", row => Ui.Card(Ui.Label(row.Text("authorName")), Ui.Label(row.Text("body")), Ui.Label(row.Text("createdAt"))), token);
        var text = Ui.Field("讨论内容", "", true); panel.Children.Add(Ui.Card(text, Action("发表评论", async () => { if (string.IsNullOrWhiteSpace(text.Text)) return; await WriteAsync("POST", path, new JsonObject { ["targetType"] = "task", ["targetId"] = id, ["body"] = text.Text.Trim() }); await ReplaceAsync(ct => TaskCommentsAsync(id, ct)); })));
        return panel;
    }
    private async Task<UIElement> TaskInquiriesAsync(string id, CancellationToken token)
    {
        var panel = Page("任务私密问询", "仅向所选成员发送；服务端按任务及参与人隔离消息。"); var path = Base + "/tasks/" + Escape(id) + "/inquiries";
        await AddPagedAsync(panel, path + "?limit=50", row =>
        {
            var replies = Ui.Stack(Ui.Label(row.Id("senderName", "recipientName"), 18));
            foreach (var message in row.Rows("messages")) replies.Children.Add(Ui.Label(message.Text("body")));
            var response = Ui.Field("回复此问询", "", true);
            replies.Children.Add(response); replies.Children.Add(Action("发送回复", async () => { if (string.IsNullOrWhiteSpace(response.Text)) return; await WriteAsync("POST", Base + "/task-inquiries/" + Escape(row.Text("inquiryId")) + "/messages", new JsonObject { ["body"] = response.Text.Trim() }); await ReplaceAsync(ct => TaskInquiriesAsync(id, ct)); }));
            return Ui.Card(replies);
        }, token);
        var members = (await repository.GetAsync(Base + "/members?limit=100", token)).Rows().Where(m => m.Text("userId") != repository.AccountId);
        var recipient = Ui.Choice("接收成员", members.Select(m => (m.Text("userId"), m.Text("displayName")))); var body = Ui.Field("问询内容", "", true);
        panel.Children.Add(Ui.Card(recipient, body, Action("发起私密问询", async () => { if (recipient.Value().Length == 0 || string.IsNullOrWhiteSpace(body.Text)) throw new InvalidOperationException("请选择成员并填写问询内容。"); await WriteAsync("POST", path, new JsonObject { ["recipientId"] = recipient.Value(), ["body"] = body.Text.Trim() }); await ReplaceAsync(ct => TaskInquiriesAsync(id, ct)); }, "确认发送给所选成员？")));
        return panel;
    }
}
