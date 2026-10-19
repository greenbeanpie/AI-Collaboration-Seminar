using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> FilesAsync(CancellationToken token)
    {
        var panel = Page("附件与回收站", "恢复保留原文件和历史引用，不自动启动解析、OCR、要求提取或总结。");
        var view = Ui.Choice("文件视图", [("active", "当前文件"), ("archived", "已归档文件"), ("recycle", "回收站")]); var query = Ui.Field("搜索文件和来源", max: 200); var records = Ui.Stack();
        async Task LoadAsync()
        {
            records.Children.Clear(); var deleted = view.Value() == "recycle"; var archived = view.Value() == "archived";
            await AddPagedAsync(records, Base + "/files?limit=50&q=" + Escape(query.Text.Trim()) + "&deleted=" + deleted.ToString().ToLowerInvariant() + "&archived=" + archived.ToString().ToLowerInvariant(), file =>
            {
                var box = Ui.Stack(Ui.Label(file.Text("name"), 18), Ui.Label(Ui.Status(file.Text("status")) + " · " + file.Text("sizeBytes") + " 字节"));
                if (!deleted && file.Text("status") == "available")
                {
                    if (OpenAttachmentRequested != null) box.Children.Add(Action("预览或保存原文件", () => OpenAttachmentRequested(projectId!, file.Text("fileId"))));
                    box.Children.Add(Action("正文提取与文件处理", () => ReplaceAsync(ct => FileProcessingAsync(file.Text("fileId"), ct))));
                }
                if (file.Flag("canManage"))
                {
                    if (!deleted) box.Children.Add(Action(archived ? "撤销归档" : "归档文件", async () => { await WriteAsync("POST", Base + "/files/" + Escape(file.Text("fileId")) + (archived ? "/unarchive" : "/archive"), new JsonObject { ["expectedLifecycleVersion"] = file["lifecycleVersion"].Copy() }); await LoadAsync(); }, "更改文件归档状态？原文件和历史引用保持保留。"));
                    if (file.Flag("canDelete")) box.Children.Add(Action(deleted ? "恢复文件" : "移入回收站", async () => { await WriteAsync(deleted ? "POST" : "DELETE", Base + "/files/" + Escape(file.Text("fileId")) + (deleted ? "/restore" : ""), new JsonObject { ["expectedLifecycleVersion"] = file["lifecycleVersion"].Copy() }); await LoadAsync(); }, deleted ? "恢复文件及相关来源？不会自动启动 AI。" : "将文件及相关来源移入回收站并停止相关处理？原文件和历史引用保留，可按权限恢复。"));
                }
                return Ui.Card(box);
            }, token);
            if (deleted) await AddPagedAsync(records, Base + "/sources?limit=50&deleted=true&q=" + Escape(query.Text.Trim()), source =>
            {
                var box = Ui.Stack(Ui.Label(source.Text("title"), 18), Ui.Label("来源原文 · 回收站"));
                if (source.Flag("canDelete") && source.Text("fileId").Length == 0) box.Children.Add(Action("恢复来源", async () => { await WriteAsync("POST", Base + "/sources/" + Escape(source.Text("sourceId")) + "/restore", new JsonObject { ["expectedLifecycleVersion"] = source["lifecycleVersion"].Copy() }); await LoadAsync(); }, "恢复来源？不会自动启动 AI。"));
                return Ui.Card(box);
            }, token);
        }
        panel.Children.Add(Ui.Card(view, query, Action("读取此视图", LoadAsync))); panel.Children.Add(records); await LoadAsync(); return panel;
    }
    private async Task<UIElement> FileProcessingAsync(string id, CancellationToken token)
    {
        var path = Base + "/files/" + Escape(id) + "/processing"; var state = await repository.GetAsync(path, token);
        var panel = Ui.Stack(Ui.Heading("正文提取与文件处理"), Ui.Label("正文：" + Ui.Status(state.Text("textStatus")) + " · 总结：" + Ui.Status(state.Text("summaryStatus")) + " · 要求：" + Ui.Status(state.Text("requirementsStatus"))), Ui.Label(state.Text("error")), Action("刷新处理状态", () => ReplaceAsync(ct => FileProcessingAsync(id, ct))));
        var process = Action("启动或继续文件处理", async () => { var result = await WriteAsync("POST", path, new JsonObject { ["expectedLifecycleVersion"] = state?["lifecycleVersion"].Copy(), ["retry"] = state.Text("jobStatus") is "failed" or "cancelled" }); if (result.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(result.Text("jobId"), ct)); else await ReplaceAsync(ct => FileProcessingAsync(id, ct)); }, "按当前文件状态继续正文、总结或要求处理。项目启用 AI 时可能调用模型并产生费用；原文件保留。", true);
        process.IsEnabled = state.Flag("canProcess") && state.Text("jobStatus") is not ("queued" or "running" or "processing") && !state.Flag("waitingForConcurrency"); panel.Children.Add(process);
        if (state.Flag("waitingForConcurrency")) panel.Children.Add(Ui.Label("后台已排队等待并发名额，无需重复提交。"));
        return panel;
    }
    private async Task<UIElement> SourceProcessingAsync(JsonNode? source, JsonNode? version, CancellationToken token)
    {
        var id = source.Text("sourceId"); var versionId = version.Text("sourceVersionId"); var path = Base + "/sources/" + Escape(id) + "/versions/" + Escape(versionId) + "/processing";
        var state = await repository.GetAsync(path, token); var panel = Ui.Stack(Ui.Heading("正文、要求与总结"), Ui.Label("正文：" + Ui.Status(state.Text("textStatus")) + " · 要求：" + Ui.Status(state.Text("requirementsStatus")) + " · 总结：" + Ui.Status(state.Text("summaryStatus"))), Ui.Label(state.Text("requirementsError")), Ui.Label(state.Text("summaryError")), Action("刷新处理状态", () => ReplaceAsync(ct => SourceProcessingAsync(source, version, ct))));
        var summary = state?["summary"];
        if (summary != null)
        {
            var card = Ui.Stack(Ui.Label(summary.Text("title"), 20), Ui.Label(summary.Text("summary")), Ui.Label("AI 总结供辅助核对，不能替代原文。"));
            foreach (var point in summary.Rows("keyPoints")) card.Children.Add(Ui.Label("• " + point)); foreach (var citation in summary.Rows("citations")) card.Children.Add(Ui.Label("第 " + citation.Text("pageNumber") + " 页：" + citation.Text("quote"))); panel.Children.Add(Ui.Card(card));
        }
        async Task GuardSourceAsync()
        {
            var latest = await repository.GetAsync(Base + "/sources/" + Escape(id), PageToken);
            if (latest.Text("currentVersionId") != versionId || latest.Text("lifecycleVersion") != source.Text("lifecycleVersion") || latest.Text("deletedAt").Length > 0) throw new InvalidOperationException("来源版本或生命周期已变化，请刷新核对后继续。");
        }
        foreach (var (tail, title) in new[] { ("/sources/" + Escape(id) + "/parse", "解析来源并提取要求"), ("/document-imports/extract", "只提取正文"), ("/document-imports/analyze", "依据完整正文生成要求") })
        {
            var button = Action(title, async () => { await GuardSourceAsync(); var result = await WriteAsync("POST", Base + tail, new JsonObject { ["sourceVersionId"] = versionId }); if (result.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(result.Text("jobId"), ct)); else await ReplaceAsync(ct => SourceProcessingAsync(source, version, ct)); }, "此操作可能使用已配置识别或分析模型并产生费用。原文件和已接收正文保留。");
            button.IsEnabled = state.Text("textStatus") != "processing" && (tail != "/document-imports/analyze" || state.Text("textStatus") == "ready"); panel.Children.Add(button);
        }
        var summarize = Action("生成或重试文件总结", async () => { await GuardSourceAsync(); var result = await WriteAsync("POST", path + "/summary", new JsonObject { ["expectedSummaryRevision"] = state?["summaryRevision"].Copy() }); if (result.Text("jobId").Length > 0) await ReplaceAsync(ct => JobAsync(result.Text("jobId"), ct)); }, "调用 AI 单独生成总结？不会重新上传、解析或重复 OCR，可能产生费用。"); summarize.IsEnabled = state.Text("textStatus") == "ready" && state.Text("summaryStatus") is not ("queued" or "running"); panel.Children.Add(summarize);
        foreach (var job in new[] { state.Text("processingJobId"), state.Text("summaryJobId") }.Where(x => x.Length > 0).Distinct()) panel.Children.Add(Action("查看后台执行", () => ReplaceAsync(ct => JobAsync(job, ct))));
        return panel;
    }
}
