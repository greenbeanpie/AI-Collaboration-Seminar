using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> TaskHierarchyProposalsAsync(CancellationToken token)
    {
        var panel = Page("AI 建议与历史", "父任务自动依赖其子任务。修订按当前方案版本保存，应用时由服务端验证完整关系图。");
        var graph = await repository.GetAsync(Base + "/tasks/graph", token); var tasks = graph.Rows();
        panel.Children.Add(Action("返回任务列表", () => NavigateAsync("tasks")));
        await AddPagedAsync(panel, Base + "/collaboration/proposals?limit=30", proposal =>
        {
            var content = Ui.Stack(Ui.Label("方案 · " + Ui.Status(proposal.Text("status")), 20), Ui.Label(proposal.Text("createdAt")));
            var payload = proposal?["payload"]?.DeepClone() as JsonObject ?? new JsonObject();
            var created = payload.Rows("tasks"); var choices = new[] { ("", "无父任务") }.Concat(created.Select(t => (t.Text("key"), t.Text("title")))).Concat(tasks.Select(t => (t.Text("taskId"), t.Text("title")))).ToList();
            var parents = new List<(JsonNode Row, string Group, string Field, ComboBox Choice, string InitialParent)>();
            var editable = Can("taskManage") && proposal.Text("status") is "pending" or "stale" or "rejected";
            foreach (var (group, field) in new[] { ("tasks", "parent"), ("updates", "parentTaskId") }) foreach (var row in payload.Rows(group))
            {
                var box = Ui.Stack(Ui.Label(row.Text("title"), 18), Ui.Label(row.Text("detail")), Ui.Label("验收标准：" + row.Text("criteria")));
                string Name(string id) => choices.FirstOrDefault(c => c.Item1 == id).Item2 ?? "暂不可见任务";
                var currentParent = (row as JsonObject)?.ContainsKey(field) == true ? row.Text(field) : group == "updates" ? tasks.FirstOrDefault(t => t.Text("taskId") == row.Text("taskId")).Text("parentTaskId") : "";
                box.Children.Add(Ui.Label("父任务：" + Name(currentParent)));
                if (group == "tasks") box.Children.Add(Ui.Label("前置任务：" + string.Join("、", row.Rows("dependsOn").Select(id => Name(id.ToString())))));
                if (editable)
                {
                    var ownId = group == "tasks" ? row.Text("key") : row.Text("taskId");
                    var picker = Ui.Choice("调整父任务", choices.Where(c => c.Item1 != ownId && (group == "tasks" || c.Item1.Length == 0 || tasks.Any(t => t.Text("taskId") == c.Item1))), currentParent);
                    box.Children.Add(picker); parents.Add((row, group, field, picker, currentParent));
                }
                content.Children.Add(Ui.Card(box));
            }
            if (editable)
            {
                var reason = Ui.Field("层级修订理由", "", true, 4000); content.Children.Add(reason);
                content.Children.Add(Action("保存层级修订", async () =>
                {
                    if (string.IsNullOrWhiteSpace(reason.Text)) throw new InvalidOperationException("请填写修订理由。");
                    var submitted = (JsonObject)payload.DeepClone();
                    foreach (var group in new[] { "tasks", "updates" }) if (payload[group] is JsonArray rows)
                        submitted[group] = new JsonArray(rows.Select(row => { var entry = parents.FirstOrDefault(p => ReferenceEquals(p.Row, row)); return entry.Row == null ? row.Copy() : TaskProposalParent.Apply((JsonObject)entry.Row, entry.Field, entry.InitialParent, entry.Choice.Value()); }).ToArray());
                    await WriteAsync("PATCH", Base + "/collaboration/proposals/" + Escape(proposal.Text("proposalId")), new JsonObject { ["expectedRevision"] = proposal?["revision"].Copy(), ["payload"] = submitted, ["reason"] = reason.Text.Trim() });
                    await ReplaceAsync(TaskHierarchyProposalsAsync);
                }, "保存当前方案的父子层级修订？"));
            }
            return Ui.Card(content);
        }, token);
        return panel;
    }
}
