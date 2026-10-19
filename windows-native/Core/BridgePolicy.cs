using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Text;

namespace Buwei.Windows.Core;

public static partial class BridgePolicy
{
    public const string Root = "/api/v1/agent-bridges";
    public static bool Active(JsonNode item) => Text(item, "state") is not ("blocked" or "failed" or "cancelled" or "ready_for_review");
    public static bool Eligible(JsonNode? eligibility, JsonNode task) => Text(eligibility, "status") == "ready" &&
        eligibility?["eligible"]?.GetValue<bool>() == true && JsonNode.DeepEquals(eligibility["taskRevision"], task["revision"]) &&
        Regex.IsMatch(Text(eligibility, "sourceHash"), "^[a-f0-9]{64}$");
    public static bool Bound(JsonNode device, string project) => device["paired"]?.GetValue<bool>() == true &&
        device["revoked"]?.GetValue<bool>() != true && device["protocolVersion"]?.GetValue<int>() == 1 &&
        (device["projects"] as JsonArray ?? []).Any(x => Text(x, "projectId") == project && !string.IsNullOrWhiteSpace(Text(x, "workspaceLabel")));
    public static string ReviewStamp(JsonNode item, JsonNode task) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(new JsonObject
    {
        ["handoffId"] = item["handoffId"]?.DeepClone(), ["updatedAt"] = item["updatedAt"]?.DeepClone(),
        ["taskRevision"] = task["revision"]?.DeepClone(), ["result"] = item["result"]?.DeepClone()
    }.ToJsonString())));
    public static JsonObject Adoption(JsonNode item, JsonNode task, string owner, string project, bool reviewed, string reviewedStamp)
    {
        if (!reviewed || reviewedStamp != ReviewStamp(item, task) || Text(item, "state") != "ready_for_review" || item["result"] is not JsonObject)
            throw new InvalidOperationException("请先核对待采纳的成果说明及全部文件。");
        if (Text(item, "projectId") != project || Text(item, "taskId") != Text(task, "taskId") ||
            item["stale"]?.GetValue<bool>() == true || !JsonNode.DeepEquals(item["taskRevision"], task["revision"]) ||
            Text(item, "adoptedSubmissionId").Length > 0) throw new InvalidOperationException("任务、成果版本或采纳状态已变化，请刷新核对。");
        if (Text(task, "assigneeId") != owner) throw new InvalidOperationException("仅当前任务执行人可采纳并提交验收。");
        return new JsonObject { ["expectedTaskRevision"] = task["revision"]?.DeepClone(), ["reviewed"] = true };
    }
    public static void ValidateAction(string path, JsonObject body)
    {
        var match = ActionPath().Match(path);
        if (!match.Success || match.Groups.Cast<Group>().Skip(1).Where(x => x.Success && x.Name is "project" or "task" or "handoff").Any(x => !Guid.TryParse(x.Value, out _)))
            throw new ArgumentException("不支持的 Bridge 操作路径。");
        var fields = path.EndsWith("/cancel", StringComparison.Ordinal) ? Array.Empty<string>() :
            path.EndsWith("/adopt-and-submit", StringComparison.Ordinal) ? ["expectedTaskRevision", "reviewed"] :
            path.EndsWith("/agent-eligibility", StringComparison.Ordinal) ? ["expectedRevision", "retry"] : new[] { "expectedRevision", "targetDeviceId" };
        if (body.Any(x => !fields.Contains(x.Key))) throw new ArgumentException("Bridge 操作包含未知字段。");
        if (fields.Length == 0) return;
        var revision = fields[0];
        if (body[revision] is not JsonValue value || !value.TryGetValue<int>(out var number) || number <= 0) throw new ArgumentException("任务版本无效。");
        if (fields.Contains("targetDeviceId") && !Guid.TryParse(Text(body, "targetDeviceId"), out _)) throw new ArgumentException("请选择有效设备。");
        if (fields.Contains("reviewed") && body["reviewed"]?.GetValue<bool>() != true) throw new ArgumentException("必须人工核对成果。");
        if (body["retry"] is { } retry && retry.GetValueKind() is not System.Text.Json.JsonValueKind.True and not System.Text.Json.JsonValueKind.False) throw new ArgumentException("重试标记无效。");
    }
    public static string Label(string state) => state switch
    {
        "checking" => "正在判断适用性", "waiting_device" => "等待 DSH 接收", "claimed" => "DSH 已领取", "running" => "Agent 正在执行",
        "waiting_input" => "请在 DSH 中处理审批或输入", "uploading" => "正在回传成果", "ready_for_review" => "成果待人工核对",
        "blocked" => "当前不适合执行", "failed" => "执行失败", "cancel_requested" => "等待 DSH 确认取消", "cancelled" => "已取消",
        "dispatch_uncertain" => "执行状态未知，请核对 DSH 会话", _ => state
    };
    internal static string Text(JsonNode? node, string key) => node?[key]?.ToString() ?? "";
    [GeneratedRegex("^/api/v1/(?:projects/(?<project>[a-fA-F0-9-]{36})/collaboration/tasks/(?<task>[a-fA-F0-9-]{36})/agent-eligibility|agent-bridges/projects/(?<project>[a-fA-F0-9-]{36})/tasks/(?<task>[a-fA-F0-9-]{36})/handoffs|agent-bridges/handoffs/(?<handoff>[a-fA-F0-9-]{36})/(?:cancel|adopt-and-submit))$")]
    internal static partial Regex ActionPath();
}
