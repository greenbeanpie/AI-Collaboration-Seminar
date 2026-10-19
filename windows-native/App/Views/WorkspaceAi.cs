using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> AiAsync(CancellationToken token)
    {
        var capabilities = await repository.GetAsync("/capabilities", token);
        var panel = Page("项目 AI", "对话可引用当前项目资料；AI 提供的建议需要人工核对。发送操作可能调用已配置模型并产生费用。");
        var key = "chat:" + projectId; var draft = await repository.Store.LoadDraftAsync(key);
        var composer = Ui.Field("询问项目 AI", draft.Text("content"), true, 8000);
        var send = Action("发送问题", async () =>
        {
            if (composer.Text.Trim().Length == 0) return;
            await repository.Store.SaveDraftAsync(key, new JsonObject { ["content"] = composer.Text });
            var response = await WriteAsync("POST", Base + "/ai-chat", new JsonObject { ["content"] = composer.Text.Trim() });
            await repository.Store.DeleteDraftAsync(key);
            if (response.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(response.Text("jobId"), ct)); else await NavigateAsync("ai");
        }, "发送问题并调用项目配置的模型？", true); send.IsEnabled = capabilities?["features"].Flag("aiEnabled") == true;
        panel.Children.Add(Ui.Card(composer, Action("暂存问题", () => repository.Store.SaveDraftAsync(key, new JsonObject { ["content"] = composer.Text })), send));
        await AddPagedAsync(panel, Base + "/ai-chat?limit=30", row =>
        {
            var box = Ui.Stack(Ui.Label(row.Text("role") is "assistant" ? "项目 AI" : "我的问题", 18), Ui.Label(row.Text("content")), Ui.Label(row.Text("createdAt")));
            foreach (var reference in row.Rows("references")) box.Children.Add(Ui.Label("引用：" + reference.Id("title", "label") + " · " + reference.Text("quote")));
            if (row.Text("jobId").Length > 0) box.Children.Add(Action("查看执行进度", () => ReplaceAsync(ct => JobAsync(row.Text("jobId"), ct))));
            return Ui.Card(box);
        }, token);
        panel.Children.Add(Action("清空当前项目对话", async () => { await WriteAsync("DELETE", Base + "/ai-chat"); await NavigateAsync("ai"); }, "删除当前项目对话历史？请先保留需要的内容。"));
        panel.Children.Add(Action("AI 补位与成果采纳", () => ReplaceAsync(ct => AgentSessionsAsync(ct))));
        return panel;
    }
    private async Task<UIElement> JobAsync(string id, CancellationToken token)
    {
        var row = await repository.GetAsync("/jobs/" + Escape(id), token);
        var panel = Ui.Stack(Ui.Heading("AI 执行进度"), Ui.Label(Ui.Status(row.Text("status"))), Ui.Label(row.Id("progressMessage", "message")), Ui.Label(row.Text("error")), Action("刷新执行状态", () => ReplaceAsync(ct => JobAsync(id, ct))));
        var execution = row?["execution"];
        if (execution != null) panel.Children.Add(Ui.Label("累计执行工具 " + execution.Text("toolCallCount") + " 次（含失败尝试）"));
        if (row?["result"] is JsonObject result) { if (result.Text("markdown").Length > 0) panel.Children.Add(Ui.Label(result.Text("markdown"))); if (result.Text("summary").Length > 0) panel.Children.Add(Ui.Label(result.Text("summary"))); }
        return panel;
    }
    private async Task<UIElement> AgentSessionsAsync(CancellationToken token)
    {
        var panel = Page("AI 补位与成果采纳", "参考资料固定版本后发起任务；生成草稿须人工复核后采纳。");
        await AddPagedAsync(panel, Base + "/agent-sessions?status=all&limit=30", row => Ui.Card(Ui.Label(row.Id("title", "instruction"), 18), Ui.Label(Ui.Status(row.Text("status"))), Action("查看会话与草稿", () => ReplaceAsync(ct => AgentSessionDetailAsync(row.Text("sessionId"), ct)))), token);
        var instruction = Ui.Field("补位目标与要求", "", true, 8000);
        var mode = Ui.Choice("工作方式", [("guide", "引导协作"), ("do", "直接起草"), ("review_only", "仅审阅")]);
        var sources = (await repository.GetAsync(Base + "/sources?limit=100", token)).Rows(); var materials = (await repository.GetAsync(Base + "/materials?limit=100", token)).Rows();
        var sourceSelection = new Dictionary<string, CheckBox>(); var materialSelection = new Dictionary<string, CheckBox>();
        var references = Ui.Stack(Ui.Label("固定参考资料", 20));
        foreach (var source in sources) { var version = source.Text("currentVersionId"); if (version.Length == 0) continue; var check = new CheckBox { Content = source.Text("title") + " · 来源" }; sourceSelection[version] = check; references.Children.Add(check); }
        foreach (var material in materials) { var version = material.Id("currentVersionId"); if (version.Length == 0) continue; var check = new CheckBox { Content = material.Text("title") + " · 成果" }; materialSelection[version] = check; references.Children.Add(check); }
        panel.Children.Add(Ui.Card(instruction, mode, references, Action("发起补位会话", async () =>
        {
            var response = await WriteAsync("POST", Base + "/agent-sessions", new JsonObject { ["mode"] = mode.Value(), ["taskId"] = null, ["instruction"] = instruction.Text.Trim(), ["materialVersionIds"] = new JsonArray(materialSelection.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray()), ["sourceVersionIds"] = new JsonArray(sourceSelection.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray()), ["allowSearch"] = false });
            if (response.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(response.Text("jobId"), ct)); else await NavigateAsync("ai");
        }, "调用配置模型生成补位内容？不会自动提交或替换项目成果。", true)));
        return panel;
    }
    private async Task<UIElement> AgentSessionDetailAsync(string id, CancellationToken token)
    {
        var row = await repository.GetAsync(Base + "/agent-sessions/" + Escape(id), token);
        var panel = Page(row.Id("title", "instruction"), Ui.Status(row.Text("status")));
        foreach (var turn in row.Rows("turns"))
        {
            panel.Children.Add(Ui.Card(Ui.Label(turn.Id("content", "markdown", "message")), Ui.Label(Ui.Status(turn.Text("status")))));
            if (turn.Text("jobId").Length > 0) panel.Children.Add(Action("查看本轮执行状态", () => ReplaceAsync(ct => JobAsync(turn.Text("jobId"), ct))));
        }
        var answer = Ui.Field("回答 AI 的问题", "", true, 8000);
        panel.Children.Add(Ui.Card(answer, Action("提交本轮回答", async () => { if (string.IsNullOrWhiteSpace(answer.Text)) return; var response = await WriteAsync("POST", Base + "/agent-sessions/" + Escape(id) + "/turns", new JsonObject { ["content"] = answer.Text.Trim() }); if (response.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(response.Text("jobId"), ct)); }, "继续调用模型处理本轮回答？")));
        return panel;
    }
}
