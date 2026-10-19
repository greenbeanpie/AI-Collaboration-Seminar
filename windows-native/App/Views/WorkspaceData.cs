using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    public Func<Task>? AddFileRequested { get; set; }
    public Func<Task>? CaptureRequested { get; set; }
    public Func<string, string, Task>? OpenAttachmentRequested { get; set; }
    public string? SelectedProjectId => projectId;
    public string? CurrentProjectId => projectId;
    private async Task<UIElement> DataAsync(CancellationToken token)
    {
        var panel = Page("项目资料", "集中管理来源、参考资料及成果文档。历史引用保持固定版本。");
        panel.Children.Add(Action("新增资料", () => ReplaceAsync(ct => IntakeAsync(ct)), primary: true));
        panel.Children.Add(Action("附件与回收站", () => ReplaceAsync(FilesAsync)));
        var query = Ui.Field("搜索资料标题", max: 200); var purpose = Ui.Choice("资料用途", [("", "全部"), ("background", "项目背景"), ("reference", "参考资料"), ("output", "成果")]);
        var archived = new CheckBox { Content = "查看已归档资料" }; var list = Ui.Stack();
        async Task SearchAsync()
        {
            list.Children.Clear(); await AddPagedAsync(list, Base + "/resource-library?limit=50&q=" + Escape(query.Text.Trim()) + "&archived=" + (archived.IsChecked == true ? "true" : "false") + (purpose.Value().Length > 0 ? "&purpose=" + purpose.Value() : ""), row => Ui.Card(Ui.Label(row.Text("title"), 20), Ui.Label((row.Text("resourceType") == "source" ? "来源原文" : "成果文档") + " · " + row.Text("updatedAt")), Action("查看资料", () => ReplaceAsync(ct => ResourceAsync(row.Text("resourceType"), row.Text("resourceId"), ct)))), token, virtualize: true);
        }
        panel.Children.Add(Ui.Card(query, purpose, archived, Action("搜索", SearchAsync))); panel.Children.Add(list); await SearchAsync(); return panel;
    }
    private async Task<UIElement> IntakeAsync(CancellationToken token)
    {
        var key = "intake:" + projectId; var draft = await repository.Store.LoadDraftAsync(key);
        var panel = Page("新增资料", "选择一种方式，保留来源身份和历史引用。");
        var method = Ui.Choice("新增方式", [("material", "成果文档"), ("paste", "粘贴文本"), ("web", "公开网页")], draft.Text("method"));
        var title = Ui.Field("资料标题", draft.Text("title"), max: 200); var body = Ui.Field("来源原文", draft.Text("text"), true, 100000); var url = Ui.Field("公开网页地址", draft.Text("url"), max: 2048);
        var purpose = Ui.Choice("资料用途", [("reference", "参考资料"), ("background", "项目背景"), ("output", "成果")], draft.Text("purpose"));
        void Update() { body.Visibility = method.Value() == "paste" ? Visibility.Visible : Visibility.Collapsed; url.Visibility = method.Value() == "web" ? Visibility.Visible : Visibility.Collapsed; }
        method.SelectionChanged += (_, _) => Update(); Update();
        JsonObject Draft() => new() { ["method"] = method.Value(), ["title"] = title.Text, ["text"] = body.Text, ["url"] = url.Text, ["purpose"] = purpose.Value() };
        TrackDraft(key, Draft, method, title, body, url, purpose);
        panel.Children.Add(Ui.Card(method, title, purpose, body, url, Action("暂存到本机", () => repository.Store.SaveDraftAsync(key, Draft())), Action("确认新增", async () =>
        {
            await repository.Store.SaveDraftAsync(key, Draft());
            var value = new JsonObject { ["title"] = title.Text.Trim(), ["purpose"] = purpose.Value() };
            if (method.Value() == "material") { if (title.Text.Trim().Length == 0) throw new InvalidOperationException("请填写资料标题。"); value["kind"] = purpose.Value() == "background" ? "background" : "document"; }
            else { value["kind"] = method.Value(); if (method.Value() == "paste") { if (body.Text.Trim().Length == 0) throw new InvalidOperationException("请粘贴来源原文。"); value["text"] = body.Text; } else { if (!Uri.TryCreate(url.Text, UriKind.Absolute, out var address) || address.Scheme is not ("http" or "https")) throw new InvalidOperationException("请填写公开 HTTP/HTTPS 网页地址。"); value["url"] = url.Text.Trim(); } }
            var result = await WriteAsync("POST", Base + (method.Value() == "material" ? "/materials" : "/sources"), value, method.Value() != "web");
            if (result.Flag("queued") || result.Flag("offlinePending")) { StatusChanged?.Invoke("资料已保存到本机等待同步，服务端尚未创建。"); return; }
            await repository.Store.DeleteDraftAsync(key); await NavigateAsync("data");
        }, "将资料保存到当前项目。", true)));
        if (AddFileRequested != null) panel.Children.Add(Action("选择文件并导入", AddFileRequested));
        if (CaptureRequested != null) panel.Children.Add(Action("录音 / 录像 / 拍照", CaptureRequested));
        return panel;
    }
    private async Task<UIElement> ResourceAsync(string type, string id, CancellationToken token)
    {
        var resource = await repository.GetAsync(Base + "/resource-library/" + Escape(type) + "/" + Escape(id), token);
        var panel = Page(resource.Text("title"), (type == "material" ? "成果文档" : "来源原文") + " · " + resource.Text("purpose"));
        panel.Children.Add(Action("返回项目资料", () => NavigateAsync("data")));
        if (resource.Flag("canManage") && resource.Text("archivedAt").Length == 0 && resource.Text("deletedAt").Length == 0)
        {
            var purpose = Ui.Choice("资料用途", [("background", "项目背景"), ("reference", "参考资料"), ("output", "成果")], resource.Text("purpose"));
            panel.Children.Add(Ui.Card(purpose, Action("保存资料用途", async () => { await WriteAsync("PATCH", Base + "/resource-library/" + Escape(type) + "/" + Escape(id), new JsonObject { ["purpose"] = purpose.Value(), ["expectedRevision"] = resource?["revision"].Copy() }); await ReplaceAsync(ct => ResourceAsync(type, id, ct)); }, "修改用途可能按项目配置继续后台文件处理，请核对后保存。")));
        }
        if (type == "material")
        {
            var path = Base + "/materials/" + Escape(id); var material = await repository.GetAsync(path, token); var version = material?["currentVersion"];
            var validDocument = version?["doc"] is JsonObject && version["doc"].Text("type") == "doc";
            var editor = new RichDocumentEditor(version?["doc"], !(material.Flag("canEdit") && material.Text("archivedAt").Length == 0 && validDocument));
            var editorHost = Ui.Stack(editor);
            var expected = material?["revision"].Copy();
            var key = "material:" + projectId + ":" + id; var saved = await repository.Store.LoadDraftAsync(key);
            var editorOwner = repository.AccountId;
            void BindEditor() { editor.Changed += doc => { if (repository.AccountId != editorOwner) return; draftDirty = true; RegisterDraftWrite(repository.Store.SaveDraftAsync(key, new JsonObject { ["doc"] = doc, ["revision"] = expected.Copy() })); }; }
            BindEditor();
            saveCurrentDraft = () => repository.Store.SaveDraftAsync(key, new JsonObject { ["doc"] = editor.Document, ["revision"] = expected.Copy() });
            if (saved?["doc"] != null && material.Flag("canEdit")) panel.Children.Add(Action("恢复本机正文草稿", () => { editor = new RichDocumentEditor(saved["doc"]); BindEditor(); expected = saved["revision"].Copy(); editorHost.Children.Clear(); editorHost.Children.Add(editor); StatusChanged?.Invoke("已恢复基于版本 " + saved.Text("revision") + " 的本机草稿；保存时仍核对此版本。"); return Task.CompletedTask; }));
            panel.Children.Add(editorHost);
            if (!validDocument) panel.Children.Add(Ui.Card(Ui.Label("当前正文结构无法安全编辑；保留原内容，仅显示已有 Markdown。"), Ui.Markdown(version.Text("markdown"))));
            foreach (var file in version.Rows("attachments")) { panel.Children.Add(Ui.Label(file.Text("name"))); if (OpenAttachmentRequested != null && file.Text("availability") != "unavailable") panel.Children.Add(Action("打开附件", () => OpenAttachmentRequested(projectId!, file.Text("fileId")))); }
            if (material.Flag("canEdit") && material.Text("archivedAt").Length == 0 && validDocument)
            {
                panel.Children.Add(Action("暂存正文到本机", () => repository.Store.SaveDraftAsync(key, new JsonObject { ["doc"] = editor.Document, ["revision"] = expected.Copy() })));
                panel.Children.Add(Action("保存正文新版本", async () =>
                {
                    var doc = editor.Document; await repository.Store.SaveDraftAsync(key, new JsonObject { ["doc"] = doc.DeepClone(), ["revision"] = expected.Copy() });
                    var result = await WriteAsync("PUT", path, new JsonObject { ["expectedRevision"] = expected.Copy(), ["doc"] = doc, ["attachmentIds"] = new JsonArray(version.Rows("attachments").Select(x => x["fileId"].Copy()).ToArray()) }, true);
                    if (result.Flag("queued") || result.Flag("offlinePending")) { StatusChanged?.Invoke("正文已保存到本机等待同步；服务端版本未更新。"); return; }
                    await repository.Store.DeleteDraftAsync(key); draftDirty = false; saveCurrentDraft = null; await ReplaceAsync(ct => ResourceAsync(type, id, ct));
                }, primary: true));
            }
            if (material.Flag("canArchive")) panel.Children.Add(Action(material.Text("archivedAt").Length == 0 ? "归档文档" : "恢复文档", async () => { await WriteAsync("POST", path + (material.Text("archivedAt").Length == 0 ? "/archive" : "/unarchive"), new JsonObject { ["expectedRevision"] = material?["revision"].Copy() }); await NavigateAsync("data"); }, "修改归档状态？历史固定版本及引用会保留。"));
            panel.Children.Add(Ui.Label("版本历史", 20));
            await AddPagedAsync(panel, path + "/versions?limit=30", row => Ui.Card(Ui.Label("第 " + row.Text("revision") + " 版 · " + row.Text("createdAt")), Action("查看固定版本", async () => { var fixedVersion = await repository.GetAsync(path + "/versions/" + Escape(row.Text("versionId")), PageToken); Show(Ui.Stack(Ui.Heading("固定版本 · 只读"), new RichDocumentEditor(fixedVersion?["doc"], true)), PageToken); })), token);
        }
        else
        {
            var path = Base + "/sources/" + Escape(id); var source = await repository.GetAsync(path, token);
            if (source.Text("fileId").Length > 0 && OpenAttachmentRequested != null) panel.Children.Add(Action("打开来源文件", () => OpenAttachmentRequested(projectId!, source.Text("fileId"))));
            if (source.Text("currentVersionId").Length > 0)
            {
                var version = await repository.GetAsync(path + "/versions/" + Escape(source.Text("currentVersionId")), token);
                panel.Children.Add(Ui.Card(Ui.Label("正文覆盖情况", 20), Ui.Label(Ui.Status(version.Text("status"))), Ui.Label(version.Text("extractionCoverage")), Ui.Label(version.Text("parseError"))));
                panel.Children.Add(Action("资料目录、搜索与原文定位", () => ReplaceAsync(ct => ResourceIndexAsync("source", source.Text("currentVersionId"), ct))));
                panel.Children.Add(Action("正文、要求与总结", () => ReplaceAsync(ct => SourceProcessingAsync(source, version, ct))));
            }
            if (source.Flag("canDelete") && source.Text("fileId").Length == 0) panel.Children.Add(Action("移入回收站", async () => { await WriteAsync("DELETE", path, new JsonObject { ["expectedLifecycleVersion"] = source?["lifecycleVersion"].Copy() }); await NavigateAsync("data"); }, "将此来源移入回收站并停止相关处理？原文和历史引用保留，可按权限恢复。"));
        }
        return panel;
    }
    private async Task<UIElement> ResourceIndexAsync(string type, string version, CancellationToken token)
    {
        var path = Base + "/resource-index/" + Escape(type) + "/" + Escape(version);
        var panel = Page("资料目录与原文", "搜索摘录仅用于定位，请打开原文核对完整语境。固定版本保留原始身份。");
        var query = Ui.Field("资料内搜索", max: 200); var records = Ui.Stack(); int offset = 0;
        async Task LoadAsync(bool more)
        {
            if (!more) { offset = 0; records.Children.Clear(); }
            var data = await repository.GetAsync(path + (query.Text.Trim().Length == 0 ? "?offset=" + offset : "/search?query=" + Escape(query.Text.Trim()) + "&offset=" + offset), token);
            foreach (var entry in data.Rows()) records.Children.Add(Ui.Card(Ui.Label(entry.Id("heading", "excerpt"), 18), Ui.Label(entry.Text("excerpt")), Ui.Label("第 " + entry.Text("pageNumber") + " 页"), Action("打开完整原文", async () =>
            {
                await ReplaceAsync(ct => ResourceSectionAsync(path, entry.Text("sectionId"), entry.Id("heading", "excerpt"), 0, ct));
            })));
            if (data?["nextOffset"] is JsonValue next && int.TryParse(next.ToString(), out var following)) { if (following <= offset) throw new InvalidOperationException("目录分页未前进，请刷新重试。"); offset = following; records.Children.Add(Action("下一批目录", () => LoadAsync(true))); }
        }
        panel.Children.Add(Ui.Card(query, Action("搜索原文", () => LoadAsync(false)))); panel.Children.Add(records); await LoadAsync(false); return panel;
    }
    private async Task<UIElement> ResourceSectionAsync(string path, string sectionId, string title, int offset, CancellationToken token)
    {
        var detail = await repository.GetAsync(path + "/section?sectionId=" + Escape(sectionId) + "&offset=" + offset + "&neighbors=true", token);
        var panel = Ui.Stack(Ui.Heading(title.Length == 0 ? "固定版本原文" : title), Ui.Label("原文覆盖：" + detail.Text("coverage")), Ui.Label(detail.Text("text")));
        foreach (var fragment in detail.Rows("fragments")) panel.Children.Add(Ui.Card(Ui.Label("第 " + fragment.Text("pageNumber") + " 页"), Ui.Label(fragment.Text("quote"))));
        if (int.TryParse(detail.Text("nextOffset"), out var next))
        { if (next <= offset) throw new InvalidOperationException("原文读取位置没有前进，请刷新后重试。"); panel.Children.Add(Action("继续读取原文", () => ReplaceAsync(ct => ResourceSectionAsync(path, sectionId, title, next, ct)))); }
        if (offset > 0) panel.Children.Add(Action("从本节开头阅读", () => ReplaceAsync(ct => ResourceSectionAsync(path, sectionId, title, 0, ct))));
        return panel;
    }
}
