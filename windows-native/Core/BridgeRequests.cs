using System.Text.Json.Nodes;

namespace Buwei.Windows.Core;

public sealed record BridgeRequest(string Id, string Path, string Body, string Created, string State, string? Error);

public sealed partial class LocalStore
{
    public Task<IReadOnlyList<BridgeRequest>> PendingBridgeRequestsAsync() => UseAsync<IReadOnlyList<BridgeRequest>>(async c =>
    {
        using var command = Command(c, "SELECT id,path,body,created,state,error FROM bridge_requests WHERE state IN ('pending','unknown') ORDER BY created,id");
        await using var rows = await command.ExecuteReaderAsync(); var all = new List<BridgeRequest>();
        while (await rows.ReadAsync()) all.Add(new(rows.GetString(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetString(4), rows.IsDBNull(5) ? null : rows.GetString(5)));
        return all;
    });
    internal Task<string> StartBridgeRequestAsync(string path, JsonObject body) => UseAsync(async c =>
    {
        using var check = Command(c, "SELECT id FROM bridge_requests WHERE path=$p AND state IN ('pending','unknown') LIMIT 1", ("$p", path));
        if (await check.ExecuteScalarAsync() != null) throw new InvalidOperationException("上次操作结果尚未核对。请刷新服务端记录并处理本机请求，不能重复执行。");
        var id = Guid.NewGuid().ToString();
        using var insert = Command(c, "INSERT INTO bridge_requests(id,path,body,created,state) VALUES($id,$p,$b,$t,'pending')", ("$id", id), ("$p", path), ("$b", body.ToJsonString()), ("$t", DateTimeOffset.UtcNow.ToString("O")));
        await insert.ExecuteNonQueryAsync(); return id;
    });
    internal Task<int> FinishBridgeRequestAsync(string id, string state, JsonNode? result, string? error = null) => UseAsync(async c =>
    {
        using var command = Command(c, "UPDATE bridge_requests SET state=$s,response=$r,error=$e WHERE id=$id", ("$id", id), ("$s", state), ("$r", result?.ToJsonString()), ("$e", error));
        return await command.ExecuteNonQueryAsync();
    });
}

public sealed partial class ClientRepository
{
    private readonly object bridgeLock = new();
    private readonly HashSet<string> bridgeInFlight = [];
    public async Task<JsonNode?> SendBridgeActionAsync(string path, JsonObject body, CancellationToken ct = default)
    {
        path = ClientPaths.Normalize(path); BridgePolicy.ValidateAction(path, body);
        var started = epoch; if (AccountId == null) throw new InvalidOperationException("请先登录");
        var snapshot = (JsonObject)body.DeepClone();
        var id = await Store.StartBridgeRequestAsync(path, snapshot); Guard(started);
        return await TransmitBridgeAsync(id, path, snapshot, started, ct);
    }
    public async Task<JsonNode?> RetryBridgeRequestExplicitlyAsync(string id, bool acknowledgedPotentialCharge, CancellationToken ct = default)
    {
        if (!acknowledgedPotentialCharge) throw new InvalidOperationException("人工重试前必须核对记录并明确确认可能产生的费用。");
        var started = epoch;
        var request = (await Store.PendingBridgeRequestsAsync()).SingleOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("该请求已处理。"); Guard(started);
        var body = JsonNode.Parse(request.Body) as JsonObject ?? throw new InvalidDataException("本机请求记录无效。");
        BridgePolicy.ValidateAction(request.Path, body);
        return await TransmitBridgeAsync(request.Id, request.Path, body, started, ct);
    }
    private async Task<JsonNode?> TransmitBridgeAsync(string id, string path, JsonObject body, long started, CancellationToken ct)
    {
        lock (bridgeLock) { if (!bridgeInFlight.Add(id)) throw new InvalidOperationException("该请求正在发送，请等待完成后再核对。"); }
        try
        {
            Guard(started); await Store.FinishBridgeRequestAsync(id, "pending", null); Guard(started);
            var result = await NetworkAsync("POST", path, body, id, ct); Guard(started);
            if (result is not JsonObject) throw new InvalidDataException("Bridge 操作响应缺失，请核对服务端记录。");
            await Store.FinishBridgeRequestAsync(id, "confirmed", result); Guard(started); return result;
        }
        catch (Exception error)
        {
            if (epoch == started)
                await Store.FinishBridgeRequestAsync(id, error is ApiException { Status: 400 or 401 or 403 or 404 or 409 or 410 or 422 } ? "rejected" : "unknown", null, error.Message);
            throw;
        }
        finally { lock (bridgeLock) bridgeInFlight.Remove(id); }
    }
    public async Task ReconcileBridgeRequestAsync(string id, string? selectedHandoff = null, CancellationToken ct = default)
    {
        var started = epoch;
        var request = (await Store.PendingBridgeRequestsAsync()).SingleOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("该请求已处理。"); Guard(started);
        var body = JsonNode.Parse(request.Body) as JsonObject ?? throw new InvalidDataException("本机请求记录无效。"); var path = request.Path; JsonNode? proof;
        BridgePolicy.ValidateAction(path, body);
        if (path.EndsWith("/agent-eligibility", StringComparison.Ordinal))
        {
            proof = await GetFreshAsync(path, ct);
            if (BridgePolicy.Text(proof, "status") is not ("queued" or "running" or "ready" or "failed" or "disabled") || !JsonNode.DeepEquals(proof?["taskRevision"], body["expectedRevision"]))
                throw new InvalidOperationException("尚无可核对的同版本适用性记录，本机请求继续保留。");
        }
        else if (path.EndsWith("/handoffs", StringComparison.Ordinal))
        {
            if (!Guid.TryParse(selectedHandoff, out var handoff)) throw new InvalidOperationException("请选择已人工核对的交接记录。");
            proof = await GetFreshAsync(BridgePolicy.Root + "/handoffs/" + handoff, ct);
            var match = BridgePolicy.ActionPath().Match(path);
            if (BridgePolicy.Text(proof, "projectId") != match.Groups["project"].Value || BridgePolicy.Text(proof, "taskId") != match.Groups["task"].Value ||
                BridgePolicy.Text(proof, "deviceId") != BridgePolicy.Text(body, "targetDeviceId") || !JsonNode.DeepEquals(proof?["taskRevision"], body["expectedRevision"]))
                throw new InvalidOperationException("所选交接与原请求不一致，本机请求继续保留。");
        }
        else
        {
            proof = await GetFreshAsync(path[..path.LastIndexOf('/')], ct);
            if (path.EndsWith("/cancel", StringComparison.Ordinal) ? BridgePolicy.Text(proof, "state") is not ("cancel_requested" or "cancelled") : !Guid.TryParse(BridgePolicy.Text(proof, "adoptedSubmissionId"), out _))
                throw new InvalidOperationException("服务端尚无已取消或已采纳记录，本机请求继续保留。");
        }
        Guard(started); await Store.FinishBridgeRequestAsync(id, "confirmed", proof); Guard(started);
    }
}
