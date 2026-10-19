using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView
{
    private async Task<UIElement> BridgeDeviceScopeAsync(string device, CancellationToken token)
    {
        var path = BridgePolicy.Root + "/devices/" + Escape(device) + "/projects";
        var options = (await repository.GetFreshAsync(path, token)).Rows();
        var panel = Page("设备项目授权", "移除项目授权会阻止设备继续读取该项目；运行中交接的处理以服务端状态为准。");
        var fields = new Dictionary<string, CheckBox>();
        foreach (var row in options)
        {
            var check = new CheckBox { Content = row.Text("name"), IsChecked = row.Flag("authorized") };
            fields.Add(row.Text("projectId"), check); panel.Children.Add(check);
        }
        static JsonArray ScopeSnapshot(IEnumerable<JsonNode> rows) => new(rows.OrderBy(x => x.Text("projectId"), StringComparer.Ordinal).Select(x => (JsonNode?)new JsonObject { ["projectId"] = x["projectId"].Copy(), ["authorized"] = x["authorized"].Copy() }).ToArray());
        var saved = await TrackFormAsync("bridge-scope:" + device, fields.ToDictionary(x => x.Key, x => (Control)x.Value), ScopeSnapshot(options));
        panel.Children.Add(Action("保存项目授权", async () =>
        {
            var snapshot = saved.Snapshot();
            var selected = fields.Where(x => x.Value.IsChecked == true).Select(x => (JsonNode?)JsonValue.Create(x.Key)).ToArray();
            if (selected.Length > 100) throw new InvalidOperationException("一次最多授权 100 个项目。");
            var current = (await repository.GetFreshAsync(path, PageToken)).Rows();
            if (!JsonNode.DeepEquals(saved.Identity, ScopeSnapshot(current))) throw new InvalidOperationException("设备授权已由其他操作改变，请返回刷新后核对。本机勾选草稿保留。");
            await WriteAsync("POST", path, new JsonObject { ["projectIds"] = new JsonArray(selected) });
            await FinishFormAsync(saved, snapshot); await NavigateAsync("bridge");
        }, "确认按勾选结果更新设备授权？可取消全部项目授权。", true));
        panel.Children.Add(Action("返回设备列表", () => NavigateAsync("bridge")));
        panel.Children.Add(Action("舍弃本机授权勾选，重新读取", async () =>
        {
            panel.IsHitTestVisible = false;
            try
            {
                await Task.WhenAll(draftWrites.ToArray()); await repository.Store.DeleteDraftAsync("bridge-scope:" + device);
                saveCurrentDraft = null; draftDirty = false; await ReplaceAsync(ct => BridgeDeviceScopeAsync(device, ct));
            }
            finally { panel.IsHitTestVisible = true; }
        }, "会清除未提交的本机勾选草稿，并重新读取服务端授权。确认舍弃这些勾选？"));
        return panel;
    }

    private async Task<UIElement> TaskBridgeAsync(string id, CancellationToken token)
    {
        var project = projectId ?? throw new InvalidOperationException("请先选择项目");
        var taskPath = "/api/v1/projects/" + Escape(project) + "/tasks/" + Escape(id);
        var eligibilityPath = "/api/v1/projects/" + Escape(project) + "/collaboration/tasks/" + Escape(id) + "/agent-eligibility";
        var handoffsPath = BridgePolicy.Root + "/projects/" + Escape(project) + "/tasks/" + Escape(id) + "/handoffs";
        var panel = Page("本地 Agent 代实施", "使用 DSH 已配置的模型执行任务，成果回传后由任务执行人核对并提交验收。审批或补充输入在 DSH 完成。");
        var body = Ui.Stack(); var message = Ui.Label("");
        var preference = await repository.Store.LoadDraftAsync("bridge-device:" + project);
        var selectedDevice = preference.Text("deviceId"); string? selectedHandoff = null, reviewedStamp = null;
        JsonNode task = new JsonObject(); JsonNode? eligibility = null;
        List<JsonNode> devices = []; List<JsonNode> handoffs = []; IReadOnlyList<BridgeRequest> pending = [];
        var busy = false; var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        bool PendingPath(string path) => pending.Any(x => x.Path == ClientPaths.Normalize(path));
        async Task ReloadAsync()
        {
            var latestTask = await repository.GetFreshAsync(taskPath, token) ?? throw new InvalidDataException("任务内容缺失。");
            var latestEligibility = await repository.GetFreshAsync(eligibilityPath, token);
            var latestDevices = (await repository.GetFreshAsync(BridgePolicy.Root + "/devices", token)).Rows().ToList();
            var latestHandoffs = (await repository.GetFreshAsync(handoffsPath, token)).Rows().ToList();
            var intents = await repository.Store.PendingBridgeRequestsAsync(); token.ThrowIfCancellationRequested();
            task = latestTask; eligibility = latestEligibility; devices = latestDevices; handoffs = latestHandoffs; pending = intents;
            if (selectedHandoff == null || !handoffs.Any(x => x.Text("handoffId") == selectedHandoff)) selectedHandoff = handoffs.FirstOrDefault()?.Text("handoffId");
            Render();
        }
        async Task ExecuteAsync(Func<Task> work)
        {
            if (busy) return;
            busy = true;
            try { await work(); await ReloadAsync(); }
            finally { busy = false; }
        }
        void Render()
        {
            body.Children.Clear();
            body.Children.Add(Ui.Heading(task.Text("title")));
            body.Children.Add(Ui.Label("任务版本 " + task.Text("revision") + " · 适用性：" + (eligibility.Text("status") == "ready" ? BridgePolicy.Eligible(eligibility, task) ? "可交给 Agent" : "暂不适合" : Ui.Status(eligibility.Text("status")))));
            if (eligibility.Text("reason").Length > 0) body.Children.Add(Ui.Label(eligibility.Text("reason")));
            if (!JsonNode.DeepEquals(eligibility?["taskRevision"], task["revision"])) body.Children.Add(Ui.Label("适用性记录对应旧任务版本，需检查最新版本。"));
            var check = Action("检查任务适用性（AI）", () => ExecuteAsync(async () =>
            {
                var current = await repository.GetFreshAsync(taskPath, token) ?? throw new InvalidDataException("任务缺失");
                var payload = new JsonObject { ["expectedRevision"] = current["revision"].Copy() };
                if (eligibility.Text("status") == "failed") payload["retry"] = true;
                await repository.SendBridgeActionAsync(eligibilityPath, payload, token);
            }), "仅本次调用 AI 判断任务适用性，可能产生费用；不会自动重试或执行任务。");
            check.IsEnabled = !PendingPath(eligibilityPath) && eligibility.Text("status") is not ("queued" or "running"); body.Children.Add(check);
            var available = devices.Where(x => BridgePolicy.Bound(x, project)).ToList();
            if (available.Count == 0) body.Children.Add(Ui.Label("没有已授权并绑定项目工作目录的设备。请先连接 DSH，再在 DSH 选择项目目录。"));
            var choice = Ui.Choice("执行设备", new[] { ("", "请选择设备") }.Concat(available.Select(x => (x.Text("deviceId"), x.Text("deviceName")))), selectedDevice);
            choice.SelectionChanged += (_, _) => { selectedDevice = choice.Value(); RegisterDraftWrite(repository.Store.SaveDraftAsync("bridge-device:" + project, new JsonObject { ["deviceId"] = selectedDevice })); };
            body.Children.Add(choice);
            var dispatch = Action("交给所选 DSH 执行", () => ExecuteAsync(async () =>
            {
                var device = choice.Value();
                var current = await repository.GetFreshAsync(taskPath, token) ?? throw new InvalidDataException("任务缺失");
                var ready = await repository.GetFreshAsync(eligibilityPath, token);
                var authorized = (await repository.GetFreshAsync(BridgePolicy.Root + "/devices", token)).Rows();
                var running = (await repository.GetFreshAsync(handoffsPath, token)).Rows();
                if (current.Text("assigneeId") != repository.AccountId || !BridgePolicy.Eligible(ready, current) || !authorized.Any(x => x.Text("deviceId") == device && BridgePolicy.Bound(x, project)) || running.Any(BridgePolicy.Active))
                    throw new InvalidOperationException("任务适用性、设备授权或交接状态已变化，请刷新核对。");
                var result = await repository.SendBridgeActionAsync(handoffsPath, new JsonObject { ["expectedRevision"] = current["revision"].Copy(), ["targetDeviceId"] = device }, token);
                selectedHandoff = result.Text("handoffId"); reviewedStamp = null;
            }), "设备将读取授权输入并使用其模型执行，可能产生费用。不会自动采纳成果。", true);
            bool CanDispatch() => task.Text("assigneeId") == repository.AccountId && !PendingPath(handoffsPath) && BridgePolicy.Eligible(eligibility, task) && !handoffs.Any(BridgePolicy.Active) && available.Any(x => x.Text("deviceId") == choice.Value());
            dispatch.IsEnabled = CanDispatch(); choice.SelectionChanged += (_, _) => dispatch.IsEnabled = CanDispatch();
            if (task.Text("assigneeId") != repository.AccountId) body.Children.Add(Ui.Label("仅当前任务执行人可派发任务；请先在任务页认领或完成分工。"));
            body.Children.Add(dispatch);
            if (handoffs.Any(BridgePolicy.Active)) body.Children.Add(Ui.Label("已有未结束交接。执行状态不明时请在 DSH 核对已有会话，不要重新执行。"));
            var history = Ui.Choice("交接历史", new[] { ("", "请选择交接") }.Concat(handoffs.Select(x => (x.Text("handoffId"), BridgePolicy.Label(x.Text("state")) + " · " + x.Text("createdAt")))), selectedHandoff ?? "");
            history.SelectionChanged += (_, _) => { selectedHandoff = history.Value(); reviewedStamp = null; Render(); };
            body.Children.Add(history);
            var currentHandoff = handoffs.FirstOrDefault(x => x.Text("handoffId") == selectedHandoff);
            if (currentHandoff != null)
            {
                var handoffId = currentHandoff.Text("handoffId"); var path = BridgePolicy.Root + "/handoffs/" + Escape(handoffId);
                var card = Ui.Stack(Ui.Label(BridgePolicy.Label(currentHandoff.Text("state")), 20));
                if (currentHandoff.Text("reason").Length > 0) card.Children.Add(Ui.Label(currentHandoff.Text("reason")));
                if (currentHandoff.Text("state") == "waiting_input") card.Children.Add(Ui.Label("请在当前 DSH 会话中处理审批或输入，完成后在此刷新。Windows 客户端不会代设备批准执行。"));
                if (currentHandoff.Text("state") == "dispatch_uncertain") card.Children.Add(Ui.Label("执行结果不明。请核对 DSH 已有会话，不能重新派发。"));
                if (BridgePolicy.Active(currentHandoff) && currentHandoff.Text("state") != "cancel_requested")
                {
                    var cancel = Action("请求取消交接", () => ExecuteAsync(async () => { await repository.SendBridgeActionAsync(path + "/cancel", new JsonObject(), token); }), "运行中的设备需确认取消。在其确认前保持等待取消状态。");
                    cancel.IsEnabled = !PendingPath(path + "/cancel"); card.Children.Add(cancel);
                }
                if (currentHandoff["result"] is JsonObject result)
                {
                    card.Children.Add(Ui.Label("AI 成果说明 · 请人工核对", 18)); card.Children.Add(Ui.Markdown(result.Text("summary")));
                    foreach (var file in result.Rows("artifacts"))
                    {
                        var fileId = file.Text("fileId"); var name = file.Text("name");
                        card.Children.Add(Action("打开成果文件：" + name, async () => { if (OpenAttachmentRequested == null) throw new InvalidOperationException("文件打开入口未就绪"); await OpenAttachmentRequested(project, fileId); }));
                    }
                    var stamp = BridgePolicy.ReviewStamp(currentHandoff, task);
                    if (reviewedStamp != stamp) reviewedStamp = null;
                    var reviewed = new CheckBox { Content = "我已核对这份成果说明及全部文件", IsChecked = reviewedStamp == stamp };
                    reviewed.Checked += (_, _) => reviewedStamp = stamp; reviewed.Unchecked += (_, _) => reviewedStamp = null;
                    card.Children.Add(reviewed);
                    var adopt = Action("采纳并提交验收", () => ExecuteAsync(async () =>
                    {
                        var acknowledged = reviewedStamp;
                        var latestTask = await repository.GetFreshAsync(taskPath, token) ?? throw new InvalidDataException("任务缺失");
                        var latest = await repository.GetFreshAsync(path, token) ?? throw new InvalidDataException("交接缺失");
                        var payload = BridgePolicy.Adoption(latest, latestTask, repository.AccountId ?? "", project, acknowledged != null, acknowledged ?? "");
                        await repository.SendBridgeActionAsync(path + "/adopt-and-submit", payload, token); reviewedStamp = null;
                    }), "仅提交已人工核对、仍对应当前任务版本的成果。项目可能自动触发后续 AI 评价。", true);
                    adopt.IsEnabled = currentHandoff.Text("state") == "ready_for_review" && !currentHandoff.Flag("stale") && currentHandoff.Text("adoptedSubmissionId").Length == 0 && task.Text("assigneeId") == repository.AccountId && !PendingPath(path + "/adopt-and-submit");
                    card.Children.Add(adopt);
                    if (currentHandoff.Text("adoptedSubmissionId").Length > 0) card.Children.Add(Ui.Label("此成果已提交验收。"));
                    else if (currentHandoff.Flag("stale") || !JsonNode.DeepEquals(currentHandoff["taskRevision"], task["revision"])) card.Children.Add(Ui.Label("任务或依据已更新，旧版本成果可以核对但不能直接提交。"));
                }
                body.Children.Add(Ui.Card(card));
            }
            var handoffIds = handoffs.Select(x => x.Text("handoffId")).ToHashSet();
            foreach (var intent in pending.Where(x => x.Path == ClientPaths.Normalize(handoffsPath) || x.Path == ClientPaths.Normalize(eligibilityPath) || handoffIds.Any(h => x.Path.StartsWith(BridgePolicy.Root + "/handoffs/" + h + "/", StringComparison.Ordinal))))
            {
                body.Children.Add(Ui.Card(Ui.Label("上次操作待核对", 18), Ui.Label(intent.Path + " · " + intent.Created), Ui.Label(intent.Error ?? "请求在完成确认前中断，不能自动重放。"),
                    Action("我已核对服务端记录，确认本机请求已生效", () => ExecuteAsync(() => repository.ReconcileBridgeRequestAsync(intent.Id, selectedHandoff, token)), "只读取服务端记录进行核对。交接发起需先选择与原请求对应的交接，不会重新执行。"),
                    Action("人工按原请求重试", () => ExecuteAsync(async () => { await repository.RetryBridgeRequestExplicitlyAsync(intent.Id, true, token); }), "请先核对 DSH 会话及服务端记录。仅本次使用原参数和原请求标识重试；适用性判断并非支付去重凭证，可能再次产生模型费用，提交也可能触发后续评价。确认承担本次操作后重试？")));
            }
        }
        panel.Children.Add(Action("返回任务", () => ReplaceAsync(ct => TaskDetailAsync(id, ct))));
        panel.Children.Add(Action("刷新状态", () => ExecuteAsync(() => Task.CompletedTask)));
        panel.Children.Add(message); panel.Children.Add(body);
        timer.Tick += async (_, _) =>
        {
            if (busy || token.IsCancellationRequested || panel.XamlRoot?.IsHostVisible != true || !(handoffs.Any(BridgePolicy.Active) || eligibility.Text("status") is "queued" or "running")) return;
            try { await ExecuteAsync(() => Task.CompletedTask); message.Text = ""; }
            catch (OperationCanceledException) { timer.Stop(); }
            catch (Exception error) { timer.Stop(); message.Text = "状态刷新已停止：" + error.Message + "。请手动刷新核对。"; }
        };
        panel.Loaded += (_, _) => timer.Start(); panel.Unloaded += (_, _) => timer.Stop();
        await ReloadAsync(); return panel;
    }
}
