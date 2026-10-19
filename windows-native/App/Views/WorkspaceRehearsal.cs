using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    public Func<string, string, Task>? VoiceRequested { get; set; }
    public Func<string, string, Task>? ExportRequested { get; set; }
    private async Task<UIElement> RehearsalsAsync(CancellationToken token)
    {
        var panel = Page("答辩演练", "围绕固定目标、标准和资料进行真实问答。只有明确确认的创建、回答和结束操作会调用模型。");
        var members = (await repository.GetAsync(Base + "/members?limit=100", token)).Rows(); var scope = Ui.Choice("演练范围", [("all", "全体答辩"), ("member", "指定成员")]); var person = Ui.Choice("答辩成员", members.Select(x => (x.Text("userId"), x.Text("displayName"))));
        var references = Ui.Stack(); var materials = new Dictionary<string, CheckBox>(); var sources = new Dictionary<string, CheckBox>();
        foreach (var material in (await repository.GetAsync(Base + "/materials?limit=100", token)).Rows()) { var version = material.Text("currentVersionId"); if (version.Length == 0) continue; var check = new CheckBox { Content = material.Text("title") + " · 成果" }; materials[version] = check; references.Children.Add(check); }
        foreach (var source in (await repository.GetAsync(Base + "/sources?limit=100", token)).Rows()) { var version = source.Text("currentVersionId"); if (version.Length == 0) continue; var check = new CheckBox { Content = source.Text("title") + " · 来源" }; sources[version] = check; references.Children.Add(check); }
        JsonObject Body(bool scored)
        {
            var materialIds = materials.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray(); var sourceIds = sources.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray();
            if (materialIds.Length > 10 || sourceIds.Length > 5) throw new InvalidOperationException("最多选择 10 份成果和 5 份来源固定版本。");
            var body = new JsonObject { ["materialVersionIds"] = new JsonArray(materialIds), ["sourceVersionIds"] = new JsonArray(sourceIds) };
            if (scored) body["kind"] = "rehearsal"; else { body["scope"] = scope.Value(); body["memberId"] = scope.Value() == "member" ? JsonValue.Create(person.Value()) : null; }
            return body;
        }
        var create = Action("开始新演练", async () => { var result = await WriteAsync("POST", Base + "/rehearsals", Body(false)); await ReplaceAsync(ct => RehearsalAsync(result.Text("rehearsalId"), ct)); }, "固定所选资料并调用模型生成第一问？", true); create.IsEnabled = Can("scoreInitiate");
        var scored = Action("开始带评分的答辩演练", async () => { var result = await WriteAsync("POST", Base + "/assessments", Body(true)); await ReplaceAsync(ct => RehearsalAsync(result.Text("rehearsalId"), ct)); }, "固定主目标、统一标准及资料，并依据本轮真实回答生成维度评分？会调用模型。", true); scored.IsEnabled = Can("scoreInitiate");
        panel.Children.Add(Ui.Card(scope, person, references, create, scored));
        await AddPagedAsync(panel, Base + "/rehearsals?limit=30", row => Ui.Card(Ui.Label(row.Text("createdAt"), 18), Ui.Label(Ui.Status(row.Text("status"))), Action("查看本轮问答", () => ReplaceAsync(ct => RehearsalAsync(row.Text("rehearsalId"), ct)))), token);
        return panel;
    }
    private async Task<UIElement> RehearsalAsync(string id, CancellationToken token)
    {
        var path = Base + "/rehearsals/" + Escape(id); var detail = await repository.GetAsync(path, token);
        var panel = Ui.Stack(Ui.Heading("答辩演练"), Ui.Label(Ui.Status(detail.Text("status"))), Action("刷新本轮问答", () => ReplaceAsync(ct => RehearsalAsync(id, ct))));
        foreach (var turn in detail.Rows("turns")) panel.Children.Add(Ui.Card(Ui.Label("第 " + turn.Text("sequence") + " 回合 · " + (turn.Text("role") == "user" ? "真实回答" : turn.Text("kind") == "summary" ? "总结" : "问题"), 18), Ui.Label(turn.Text("content"))));
        var busy = detail.Text("processingStatus") is "queued" or "running" or "waiting_input";
        if (detail.Flag("canOperate") && detail.Text("status") == "active")
        {
            var key = "rehearsal-answer:" + projectId + ":" + id; var saved = await repository.Store.LoadDraftAsync(key); var answer = Ui.Field("本轮真实回答", saved.Text("answer"), true, 8000); TrackDraft(key, () => new JsonObject { ["answer"] = answer.Text }, answer);
            var submit = Action("提交本轮回答", async () => { if (answer.Text.Trim().Length == 0) throw new InvalidOperationException("请输入本轮真实回答。"); await WriteAsync("POST", path + "/answers", new JsonObject { ["content"] = answer.Text.Trim() }); await repository.Store.DeleteDraftAsync(key); draftDirty = false; saveCurrentDraft = null; await ReplaceAsync(ct => RehearsalAsync(id, ct)); }, "保存真实回答并调用模型进行后续追问及评分？", true);
            var latest = detail.Rows("turns").LastOrDefault(); submit.IsEnabled = !busy && latest.Text("role") == "assistant" && latest.Text("kind") is "question" or "followup"; panel.Children.Add(Ui.Card(answer, submit));
            if (VoiceRequested != null) { var voice = Action("语音答辩", () => VoiceRequested(projectId!, id)); voice.IsEnabled = !busy; panel.Children.Add(voice); }
            var finish = Action("结束并生成总结", async () => { var result = await WriteAsync("POST", path + "/finish"); if (result.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(result.Text("jobId"), ct)); else await ReplaceAsync(ct => RehearsalAsync(id, ct)); }, "依据本轮固定资料和真实回答调用模型生成总结及评分？"); finish.IsEnabled = !busy && detail.Rows("turns").Count > 0; panel.Children.Add(finish);
            panel.Children.Add(Action("取消并删除本场演练", async () => { await WriteAsync("DELETE", path); await NavigateAsync("rehearsals"); }, "本场问答及未完成评分不会保存，取消后无法恢复。确认取消并删除？"));
        }
        var job = detail.Id("processingJobId", "aiJobId"); if (job.Length > 0) panel.Children.Add(Action("查看执行进度", () => ReplaceAsync(ct => JobAsync(job, ct))));
        return panel;
    }
    private async Task<UIElement> ExportAsync(CancellationToken token)
    {
        var bundle = await repository.GetAsync(Base + "/export-bundle", token); var panel = Page("成果导出", "导出仅包含当前账户有权查看的服务端内容。附件原文件可在资料库单独下载。");
        panel.Children.Add(Ui.Card(Ui.Label(bundle?["project"].Text("name") ?? "项目成果", 20), Ui.Label("任务 " + bundle.Rows("tasks").Count + " 项 · 成果材料 " + bundle.Rows("materials").Count + " 份 · 来源 " + bundle.Rows("sources").Count + " 份")));
        if (ExportRequested != null) foreach (var (format, title) in new[] { ("json", "保存完整数据 JSON"), ("md", "保存项目正文 Markdown"), ("pdf", "保存项目成果 PDF") }) panel.Children.Add(Action(title, () => ExportRequested(projectId!, format)));
        else panel.Children.Add(Ui.Label("当前窗口尚未连接文件导出服务。"));
        return panel;
    }
}
