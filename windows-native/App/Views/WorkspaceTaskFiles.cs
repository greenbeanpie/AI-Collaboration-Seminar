using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    public Func<TaskFileTarget, Task>? TaskFileUploadRequested { get; set; }
    public Func<string, Task>? TaskFileResumeUploadRequested { get; set; }
    private async Task<UIElement> TaskFilesAsync(string taskId, CancellationToken token)
    {
        var path = Base + "/tasks/" + Escape(taskId); var task = await repository.GetAsync(path, token);
        var ownerProject = projectId!;
        var panel = Page("任务成果文件", "替换创建新的不可变版本，历史提交仍引用原固定版本。上传和文件登记遵循项目处理策略，启用自动处理可能产生费用。");
        panel.Children.Add(Action("返回任务", () => ReplaceAsync(ct => TaskDetailAsync(taskId, ct))));
        if (TaskFileUploadRequested != null && (Can("resourceManage") || task.Text("assigneeId") == repository.AccountId))
            panel.Children.Add(Action("上传新的成果文件", async () => { await TaskFileUploadRequested(new(ownerProject, taskId)); await ReplaceAsync(ct => TaskFilesAsync(taskId, ct)); }, primary: true));
        var pending = (await repository.Store.TaskFileRequestsAsync()).Where(x => x.Path == path + "/files" || x.Path.StartsWith(path + "/files/", StringComparison.Ordinal)).ToList();
        if (pending.Count > 0) panel.Children.Add(Ui.Label("本机待处理登记", 20));
        foreach (var request in pending)
        {
            var body = JsonNode.Parse(request.Body);
            var card = Ui.Stack(Ui.Label("文件 " + body.Text("fileId"), 18), Ui.Label("状态 " + request.State + " · " + request.Created),
                Ui.Label("材料原版本 " + (body.Text("expectedRevision") is { Length: > 0 } revision ? revision : "新增材料") + "\n" + request.Error),
                Ui.Label("若上传中断，请先在窗口顶部“同步与冲突”继续原文件上传；本页不会后台重放登记。"));
            if (body.Text("text").Length > 0) card.Children.Add(new Expander { Header = "查看本次登记正文", Content = Ui.Label(body.Text("text")) });
            if (request.Recovery != null && TaskFileResumeUploadRequested != null) card.Children.Add(Action("继续原文件上传", () => TaskFileResumeUploadRequested(request.Id), "沿用原 fileId 和摘要继续上传；上传完成后仍需在本页确认登记。项目文件处理策略可能产生费用。"));
            card.Children.Add(Action("仅联网核对已完成登记", async () => { await repository.ReconcileTaskFileRegistrationAsync(request.Id, PageToken); await ReplaceAsync(ct => TaskFilesAsync(taskId, ct)); }));
            card.Children.Add(Action("核对后使用原文件恢复登记", async () => { await repository.TransmitTaskFileRegistrationAsync(request.Id, true, PageToken); await ReplaceAsync(ct => TaskFilesAsync(taskId, ct)); },
                "请先核对任务成果文件及材料历史。此操作沿用原 fileId 和原登记内容，不会重新上传；项目自动处理可能产生费用。仅原文件上传完成后才能登记。"));
            card.Children.Add(Action("停止恢复此登记记录", async () => { await repository.AbandonTaskFileRegistrationAsync(request.Id, true, PageToken); await ReplaceAsync(ct => TaskFilesAsync(taskId, ct)); },
                "确认已核对并保留必要备份？仅停止本机恢复，不删除原文件、材料或历史版本，也不会撤回服务端已经发生的操作。"));
            panel.Children.Add(Ui.Card(card));
        }
        panel.Children.Add(Ui.Label("当前与归档成果文件", 20));
        await AddPagedAsync(panel, path + "/files?limit=100", file =>
        {
            var material = file.Text("materialId");
            var box = Ui.Stack(Ui.Label(file.Text("name"), 20), Ui.Label("材料版本 " + file.Text("revision") + " · 固定版本 " + file.Text("versionId")),
                Ui.Label(file.Text("deletedAt").Length > 0 ? "文件在回收站" : file.Text("archivedAt").Length > 0 ? "原文件已归档" : file.Text("materialArchivedAt").Length > 0 ? "任务材料已归档" : "当前有效文件"));
            if (OpenAttachmentRequested != null && file.Text("deletedAt").Length == 0) box.Children.Add(Action("预览或保存原文件", () => OpenAttachmentRequested(ownerProject, file.Text("fileId"))));
            box.Children.Add(Action("材料正文与不可变版本历史", () => ReplaceAsync(ct => ResourceAsync("material", material, ct))));
            if (file.Flag("canManage"))
            {
                if (TaskFileUploadRequested != null && file.Text("archivedAt").Length == 0 && file.Text("materialArchivedAt").Length == 0 && file.Text("deletedAt").Length == 0)
                    box.Children.Add(Action("上传文件替换此材料", async () => { await TaskFileUploadRequested(new(ownerProject, taskId, material, file!["revision"]!.GetValue<int>())); await ReplaceAsync(ct => TaskFilesAsync(taskId, ct)); }, "将以材料自身的 revision 校验替换。原文件和旧版本保持保留，已有成果提交引用不变。"));
                var archived = file.Text("materialArchivedAt").Length > 0;
                box.Children.Add(Action(archived ? "恢复任务材料" : "归档任务材料", async () =>
                {
                    await WriteAsync("POST", Base + "/materials/" + Escape(material) + (archived ? "/unarchive" : "/archive"), new JsonObject { ["expectedRevision"] = file!["revision"].Copy() });
                    await ReplaceAsync(ct => TaskFilesAsync(taskId, ct));
                }, "更改任务材料归档状态？保留原文件及历史引用；原文件自身的归档或回收状态需要在附件管理中另外恢复。"));
            }
            return Ui.Card(box);
        }, token);
        return panel;
    }
}
