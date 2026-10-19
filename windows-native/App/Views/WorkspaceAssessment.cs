using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> AssessmentAsync(CancellationToken token)
    {
        var standards = (await repository.GetAsync(Base + "/standards", token)).Rows(); var standard = standards.OrderByDescending(x => int.TryParse(x.Text("version"), out var v) ? v : 0).FirstOrDefault();
        var goal = await repository.GetAsync(Base + "/goal", token);
        var panel = Page("标准与评估", "每轮评分固定目标、标准和成果版本；人工修正保留原始建议及修正历史。");
        foreach (var row in standards)
        {
            var box = Ui.Stack(Ui.Label(row.Text("title") + " · v" + row.Text("version"), 20));
            foreach (var weight in row["rubric"].Rows("weights")) box.Children.Add(Ui.Label(weight.Text("label") + " · 权重 " + weight.Text("weight")));
            panel.Children.Add(Ui.Card(box));
        }
        if (standards.Count == 0) panel.Children.Add(Ui.Label("项目尚未建立评分标准。"));
        if (membership.Text("role") == "owner") panel.Children.Add(Action("编辑评分标准", () => ReplaceAsync(ct => StandardEditorAsync(standard, ct))));
        var materials = (await repository.GetAsync(Base + "/materials?limit=100", token)).Rows(); var references = Ui.Stack(Ui.Label("选择本轮成果固定版本", 20)); var chosen = new Dictionary<string, CheckBox>();
        foreach (var material in materials)
        {
            var version = material.Id("currentVersionId"); if (version.Length == 0) continue;
            var check = new CheckBox { Content = material.Text("title") }; chosen[version] = check; references.Children.Add(check);
        }
        var initiate = Action("开始成果检查", async () =>
        {
            var selected = chosen.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray();
            if (selected.Length == 0) throw new InvalidOperationException("请选择至少一份成果固定版本。");
            var value = await WriteAsync("POST", Base + "/assessments", new JsonObject { ["kind"] = "material_review", ["materialVersionIds"] = new JsonArray(selected), ["sourceVersionIds"] = new JsonArray(), ["goalRevision"] = goal?["revision"].Copy() });
            if (value.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(value.Text("jobId"), ct)); else await NavigateAsync("assessment");
        }, "固定所选成果版本并调用模型评分？可能产生费用。", true); initiate.IsEnabled = Can("scoreInitiate") && standard != null;
        panel.Children.Add(Ui.Card(references, initiate));
        panel.Children.Add(Ui.Label("历史成果评分", 20));
        await AddPagedAsync(panel, Base + "/assessments?limit=30", row => Ui.Card(Ui.Label(row.Text("createdAt") + " · " + Ui.Status(row.Text("status"))), Ui.Label("标准 v" + row.Text("standardsVersion")), Action("查看评分与复核", () => ReplaceAsync(ct => AssessmentDetailAsync(row.Text("assessmentId"), standard, ct)))), token);
        panel.Children.Add(Ui.Label("历史预审", 20));
        await AddPagedAsync(panel, Base + "/reviews?limit=30", row => Ui.Card(Ui.Label(row.Text("createdAt") + " · " + Ui.Status(row.Text("status"))), Action("查看预审", async () => { var value = await repository.GetAsync(Base + "/reviews/" + Escape(row.Text("reviewId")), PageToken); Show(Ui.Stack(Ui.Heading("预审结果"), Report(value?["report"])), PageToken); })), token);
        return panel;
    }
    private async Task<UIElement> StandardEditorAsync(JsonNode? standard, CancellationToken token)
    {
        var draftKey = "standard-editor:" + projectId; var local = await repository.Store.LoadDraftAsync(draftKey);
        if (local != null) standard = local["identity"];
        var panel = Page("编辑评分标准", "保存会创建新标准版本，历史评分依据不变。");
        var title = Ui.Field("标准名称", standard.Text("title"), max: 200); var dimensions = Ui.Stack(); var inputs = new List<(string Key, TextBox Label, TextBox Weight, JsonArray Citations)>();
        var fields = new Dictionary<string, Control> { ["title"] = title }; FormDraft? form = null;
        void AddDimension(string key, string label, string weight, JsonArray? citations = null)
        {
            if (inputs.Count >= 10) return;
            var name = Ui.Field("评分维度", label, max: 60); var number = Ui.Field("权重（0–100）", weight, max: 8); var data = (key, name, number, citations ?? new JsonArray()); inputs.Add(data); var card = Ui.Card(name, number); dimensions.Children.Add(card);
            fields[key + ":label"] = name; fields[key + ":weight"] = number;
            if (form != null) TrackDraft(draftKey, form.Snapshot, name, number);
            ((StackPanel)card.Child).Children.Add(Action("删除维度", () => { inputs.Remove(data); dimensions.Children.Remove(card); fields.Remove(key + ":label"); fields.Remove(key + ":weight"); if (form != null) { draftDirty = true; RegisterDraftWrite(repository.Store.SaveDraftAsync(draftKey, form.Snapshot())); } return Task.CompletedTask; }));
        }
        if (local?["fields"] is JsonObject restored) foreach (var item in restored.Where(x => x.Key.EndsWith(":label", StringComparison.Ordinal))) { var key = item.Key[..^6]; AddDimension(key, item.Value?.ToString() ?? "", restored.Text(key + ":weight")); }
        else foreach (var row in standard?["rubric"].Rows("weights") ?? []) AddDimension(row.Text("key"), row.Text("label"), row.Text("weight"));
        if (inputs.Count == 0) AddDimension("quality", "成果质量", "100");
        form = await TrackFormAsync(draftKey, fields, standard);
        panel.Children.Add(Ui.Card(title, dimensions, Action("添加维度", () => { AddDimension("dimension_" + Guid.NewGuid().ToString("N")[..8], "", "0"); return Task.CompletedTask; }), Action("保存并生效标准", async () =>
        {
            if (title.Text.Trim().Length == 0 || inputs.Count == 0) throw new InvalidOperationException("请填写标准名称和至少一个维度。");
            var weights = new JsonArray(); var requirements = new JsonArray(); double total = 0;
            foreach (var entry in inputs)
            {
                if (entry.Label.Text.Trim().Length == 0 || !double.TryParse(entry.Weight.Text, out var value) || !double.IsFinite(value) || value < 0 || value > 100) throw new InvalidOperationException("每个维度需要名称与 0–100 的有效权重。");
                total += value; weights.Add(new JsonObject { ["key"] = entry.Key, ["label"] = entry.Label.Text.Trim(), ["weight"] = value });
                var existing = standard?["requirements"].Rows().FirstOrDefault(x => x.Text("dimensionKey") == entry.Key);
                requirements.Add(existing?.DeepClone() ?? new JsonObject { ["title"] = entry.Label.Text.Trim(), ["detail"] = "", ["category"] = "scoring", ["dimensionKey"] = entry.Key, ["dueDate"] = null, ["duePrecision"] = "unknown", ["citations"] = entry.Citations.DeepClone() });
            }
            if (total <= 0) throw new InvalidOperationException("总权重必须大于零。");
            var body = new JsonObject { ["title"] = title.Text.Trim(), ["notes"] = standard?["rubric"].Text("notes") ?? "", ["weights"] = weights, ["requirements"] = requirements };
            if (standard != null) body["expectedRevision"] = standard["revision"].Copy();
            var submitted = form.Snapshot(); await WriteAsync(standard == null ? "POST" : "PATCH", Base + "/standards" + (standard == null ? "" : "/" + Escape(standard.Text("standardsVersionId"))), body); await FinishFormAsync(form, submitted); draftDirty = false; saveCurrentDraft = null; await NavigateAsync("assessment");
        }, "确认保存并立即生效此评分标准？", true)));
        return panel;
    }
    private static UIElement Report(JsonNode? report)
    {
        var panel = Ui.Stack(Ui.Label("总分 " + report.Id("weightedTotal"), 24), Ui.Label(report.Text("summary")));
        foreach (var score in report.Rows("scores"))
        {
            var block = Ui.Stack(Ui.Label(score.Text("label") + " · " + score.Text("score"), 18), Ui.Label(score.Text("comment")));
            if (double.TryParse(score.Text("score"), out var value) && double.IsFinite(value))
            {
                var bar = new ProgressBar { Minimum = 0, Maximum = 100, Value = Math.Clamp(value, 0, 100), Height = 10 };
                Microsoft.UI.Xaml.Automation.AutomationProperties.SetName(bar, score.Text("label") + "，得分 " + score.Text("score") + "，满分 100"); block.Children.Add(bar);
            }
            foreach (var evidence in score.Rows("evidence")) block.Children.Add(Ui.Label("证据：" + evidence.Text("quote")));
            foreach (var suggestion in score.Rows("suggestions")) block.Children.Add(Ui.Label("建议：" + suggestion));
            panel.Children.Add(Ui.Card(block));
        }
        foreach (var limitation in report.Rows("limitations")) panel.Children.Add(Ui.Label("限制与待核验：" + limitation));
        return panel;
    }
    private async Task<UIElement> AssessmentDetailAsync(string id, JsonNode? standard, CancellationToken token)
    {
        var path = Base + "/assessments/" + Escape(id); var row = await repository.GetAsync(path, token);
        var panel = Page("成果评分与复核", "版本 " + row.Text("revision") + " · " + Ui.Status(row.Text("status"))); panel.Children.Add(Report(row?["report"]));
        if (row.Text("jobId").Length > 0) panel.Children.Add(Action("查看执行进度", () => ReplaceAsync(ct => JobAsync(row.Text("jobId"), ct))));
        if (Can("scoreCorrect") && row.Text("standardsVersionId") == standard.Text("standardsVersionId"))
        {
            var correctionKey = "manual-score:" + projectId + ":" + id;
            var priorDraft = await repository.Store.LoadDraftAsync(correctionKey); var baseline = priorDraft?["identity"] ?? row;
            var scores = new List<(JsonNode Original, TextBox Score, TextBox Comment)>(); var form = Ui.Stack(Ui.Label("人工修正当前评分", 20));
            var fields = new Dictionary<string, Control>();
            foreach (var score in baseline?["report"].Rows("scores") ?? []) { var number = Ui.Field(score.Text("label") + "（0–100，空为未评分）", score.Text("score"), max: 8); var comment = Ui.Field("维度评语", score.Text("comment"), true, 2000); scores.Add((score, number, comment)); fields[score.Text("key")+":score"]=number; fields[score.Text("key")+":comment"]=comment; form.Children.Add(number); form.Children.Add(comment); }
            var summary = Ui.Field("总体反馈", baseline?["report"].Text("summary") ?? "", true, 8000); var reason = Ui.Field("人工修正理由", "", true); form.Children.Add(summary); form.Children.Add(reason); fields["summary"]=summary;fields["reason"]=reason;
            var protectedScore = await TrackFormAsync(correctionKey, fields, baseline);
            form.Children.Add(Action("保存人工修正", async () =>
            {
                if (string.IsNullOrWhiteSpace(reason.Text)) throw new InvalidOperationException("请填写人工修正理由。");
                var changed = new JsonArray();
                foreach (var score in scores.Where(x => x.Score.Text != x.Original.Text("score") || x.Comment.Text != x.Original.Text("comment")))
                { double? value = null; if (score.Score.Text.Length > 0) { if (!double.TryParse(score.Score.Text, out var number) || !double.IsFinite(number) || number < 0 || number > 100) throw new InvalidOperationException("分数应为 0–100。"); value = number; } changed.Add(new JsonObject { ["key"] = score.Original.Text("key"), ["score"] = value, ["comment"] = score.Comment.Text }); }
                if (changed.Count == 0) throw new InvalidOperationException("请至少修改一个维度。");
                var submitted=protectedScore.Snapshot(); await WriteAsync("PATCH", path + "/scores", new JsonObject { ["expectedRevision"] = protectedScore.Identity?["revision"].Copy(), ["scores"] = changed, ["reason"] = reason.Text.Trim(), ["summary"] = summary.Text }); await FinishFormAsync(protectedScore,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(ct => AssessmentDetailAsync(id, standard, ct));
            }, "发布人工修正？只修改已编辑维度，保留原始 AI 建议和历史版本。")); panel.Children.Add(Ui.Card(form));
            var message = Ui.Field("追问与复核要求", "", true);
            var followup=await TrackFormAsync("score-followup:"+projectId+":"+id,new(){["message"]=message},row?["revision"]);
            panel.Children.Add(Ui.Card(message, Action("发送追问并复核", async () => { if (message.Text.Trim().Length == 0) return;var submitted=followup.Snapshot();await WriteAsync("POST", path + "/followups", new JsonObject { ["message"] = message.Text.Trim(), ["expectedRevision"] = followup.Identity.Copy() });await FinishFormAsync(followup,submitted);draftDirty=false;saveCurrentDraft=null;await ReplaceAsync(ct => AssessmentDetailAsync(id, standard, ct)); }, "调用模型复核当前评分？仅使用固定材料，保留人工分数。")));
        }
        await AddPagedAsync(panel, path + "/followups?limit=20", turn => Ui.Card(Ui.Label(turn.Text("message")), Ui.Label(Ui.Status(turn.Text("status")) + " · r" + turn.Text("baseRevision") + " → r" + turn.Text("publishedRevision")), Report(turn["publishedReport"] ?? turn["proposedReport"])), token);
        return panel;
    }
}

