using System.Text.Json.Nodes;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private static List<JsonNode> TaskAncestors(JsonNode task, IReadOnlyList<JsonNode> tasks)
    {
        var result = new List<JsonNode>(); var seen = new HashSet<string> { task.Text("taskId") }; var parent = task.Text("parentTaskId");
        while (parent.Length > 0 && seen.Add(parent)) { var row = tasks.FirstOrDefault(t => t.Text("taskId") == parent); if (row == null) break; result.Insert(0, row); parent = row.Text("parentTaskId"); }
        return result;
    }
    private void AddTaskRelations(StackPanel panel, JsonNode task, IReadOnlyList<JsonNode> tasks, bool children)
    {
        void Link(JsonNode row, string prefix)
        {
            var label = prefix + row.Text("title") + " · " + Ui.Status(row.Text("lifecycleState"));
            var button = Action(label, () => ReplaceAsync(ct => TaskDetailAsync(row.Text("taskId"), ct)));
            button.Content = Ui.Label(label); button.HorizontalAlignment = HorizontalAlignment.Stretch; button.HorizontalContentAlignment = HorizontalAlignment.Left; panel.Children.Add(button);
        }
        foreach (var parent in TaskAncestors(task, tasks)) Link(parent, "父任务路径：");
        foreach (var id in task.Rows("dependsOnTaskIds")) { var row = tasks.FirstOrDefault(t => t.Text("taskId") == id.ToString()); if (row != null) Link(row, task.Rows("unfinishedDependencyIds").Any(v => v.ToString() == id.ToString()) ? "前置未完成：" : "前置已完成："); else panel.Children.Add(Ui.Label("前置任务暂不可见")); }
        if (children) foreach (var row in tasks.Where(t => t.Text("parentTaskId") == task.Text("taskId"))) Link(row, "子任务：");
        foreach (var row in tasks.Where(t => t.Rows("dependsOnTaskIds").Any(id => id.ToString() == task.Text("taskId")))) Link(row, "后续任务：");
    }
    private async Task AddTaskFocusAsync(StackPanel panel, CancellationToken token)
    {
        panel.Children.Add(Ui.Label("我现在需要处理", 22));
        JsonNode? focus;
        try { focus = await repository.GetAsync(Base + "/tasks/focus", token); }
        catch (OperationCanceledException) { throw; }
        catch (Exception) { panel.Children.Add(Ui.Label("重点任务暂不可用，请刷新重试")); return; }
        var rows = focus.Rows(); var content = Ui.Stack(); var all = false;
        void Render()
        {
            content.Children.Clear();
            foreach (var task in rows.Take(all ? rows.Count : 5))
            {
                var id = task.Text("taskId"); var pinned = task.Flag("pinned");
                content.Children.Add(Ui.Card(Ui.Label(task.Text("title"), 19), Ui.Label(string.Join(" · ", task.Rows("focusReasons").Select(r => r.ToString()))), Ui.Label(task.Text("assigneeId") == repository.AccountId ? "由你负责" : "我关注"),
                    Action("查看与处理", () => ReplaceAsync(ct => TaskDetailAsync(id, ct))), Action(pinned ? "取消个人置顶" : "个人置顶", async () => { await WriteAsync("PUT", Base + "/tasks/" + Escape(id) + "/pin", new JsonObject { ["pinned"] = !pinned }); await NavigateAsync("tasks"); })));
            }
            if (rows.Count == 0) content.Children.Add(Ui.Label("暂无需要你处理的任务"));
            if (rows.Count > 5) content.Children.Add(Action(all ? "收起重点任务" : $"查看全部 {rows.Count} 项", () => { all = !all; Render(); return Task.CompletedTask; }));
        }
        panel.Children.Add(content); Render();
        foreach (var (field, title) in new[] { ("waitingReview", "等待验收"), ("reviewRequired", "待我审核") })
        { var pending = focus.Rows(field); if (pending.Count == 0) continue; panel.Children.Add(Ui.Label($"{title}（{pending.Count}）", 18)); foreach (var row in pending) panel.Children.Add(Action(row.Text("title"), () => ReplaceAsync(ct => TaskDetailAsync(row.Text("taskId"), ct)))); }
    }
}
