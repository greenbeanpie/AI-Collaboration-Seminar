using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Buwei.Windows.Core;

public sealed record TaskFileTarget(string ProjectId, string TaskId, string? MaterialId = null, int? Revision = null);
public sealed record TaskFileRecovery(string SourcePath, string Sha256);
public sealed record TaskFileRequest(string Id, string Path, string Body, string Created, string State, string? Error, string? Recovery);

public sealed partial class LocalStore
{
    public Task<IReadOnlyList<TaskFileRequest>> TaskFileRequestsAsync() => UseAsync<IReadOnlyList<TaskFileRequest>>(async c =>
    {
        using var command = Command(c, "SELECT id,path,body,created,state,error,recovery FROM task_file_requests WHERE state NOT IN ('confirmed','abandoned') ORDER BY created,id");
        await using var rows = await command.ExecuteReaderAsync(); var all = new List<TaskFileRequest>();
        while (await rows.ReadAsync()) all.Add(new(rows.GetString(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetString(4), rows.IsDBNull(5) ? null : rows.GetString(5), rows.IsDBNull(6) ? null : rows.GetString(6)));
        return all;
    });
    internal Task<string> StartTaskFileRequestAsync(string path, JsonObject body, JsonObject? recovery) => UseAsync(async c =>
    {
        using var check = Command(c, "SELECT id FROM task_file_requests WHERE path=$p AND state NOT IN ('confirmed','abandoned') LIMIT 1", ("$p", path));
        if (await check.ExecuteScalarAsync() != null) throw new InvalidOperationException("该任务文件已有待处理的登记记录，请先核对，避免重复上传和处理。");
        var id = Guid.NewGuid().ToString();
        using var insert = Command(c, "INSERT INTO task_file_requests(id,path,body,created,state,recovery) VALUES($i,$p,$b,$t,'waiting_upload',$r)", ("$i", id), ("$p", path), ("$b", body.ToJsonString()), ("$t", DateTimeOffset.UtcNow.ToString("O")), ("$r", recovery?.ToJsonString()));
        await insert.ExecuteNonQueryAsync(); return id;
    });
    internal Task<int> FinishTaskFileRequestAsync(string id, string state, JsonNode? response = null, string? error = null) => UseAsync(async c =>
    {
        using var command = Command(c, "UPDATE task_file_requests SET state=$s,response=$r,error=$e WHERE id=$i", ("$i", id), ("$s", state), ("$r", response?.ToJsonString()), ("$e", error));
        return await command.ExecuteNonQueryAsync();
    });
}

public sealed partial class ClientRepository
{
    private readonly object taskFileLock = new();
    private readonly HashSet<string> taskFileInFlight = [];
    public const int MaxTaskFileTextCharacters = 60_000;
    public static string BoundTaskFileText(string text)
    {
        if (text.Length <= MaxTaskFileTextCharacters) return text;
        const string note = "\n\n（正文超限，仅登记开头部分；完整内容保留在原文件）";
        var length = MaxTaskFileTextCharacters - note.Length;
        if (char.IsHighSurrogate(text[length - 1])) length--;
        return text[..length] + note;
    }
    private static void ValidateTaskFileRequest(string path, JsonObject body)
    {
        var match = Regex.Match(path, "^/api/v1/projects/([a-fA-F0-9-]{36})/tasks/([a-fA-F0-9-]{36})/files(?:/([a-fA-F0-9-]{36}))?$");
        if (!match.Success || !Guid.TryParseExact(match.Groups[1].Value, "D", out _) || !Guid.TryParseExact(match.Groups[2].Value, "D", out _) ||
            match.Groups[3].Success && !Guid.TryParseExact(match.Groups[3].Value, "D", out _) || !Guid.TryParseExact(body["fileId"]?.ToString(), "D", out _)) throw new ArgumentException("任务文件登记标识无效。");
        if (body.Any(x => x.Key is not ("fileId" or "expectedRevision" or "text")) || body["text"]?.GetValue<string>().Length > MaxTaskFileTextCharacters) throw new ArgumentException("任务文件登记字段或正文长度无效。");
        if (match.Groups[3].Success ? body["expectedRevision"]?.GetValue<int>() is not > 0 : body.ContainsKey("expectedRevision")) throw new ArgumentException("替换必须使用材料自身的有效 revision。");
    }
    public async Task<string> PrepareTaskFileRegistrationAsync(TaskFileTarget target, string fileId, string? text, CancellationToken ct = default, TaskFileRecovery? recovery = null)
    {
        var path = SubmissionTaskPath(target.ProjectId, target.TaskId) + "/files" + (target.MaterialId == null ? "" : "/" + target.MaterialId);
        var body = new JsonObject { ["fileId"] = fileId };
        if (target.Revision != null) body["expectedRevision"] = target.Revision;
        if (!string.IsNullOrWhiteSpace(text)) body["text"] = text;
        ValidateTaskFileRequest(path, body); var started = epoch; ct.ThrowIfCancellationRequested();
        if (AccountId == null || await Store.IsRevokedAsync(target.ProjectId)) throw new InvalidOperationException("请登录并确认项目权限。");
        JsonObject? savedRecovery = null;
        if (recovery != null)
        {
            var owned = Path.GetFullPath(Path.Combine(Store.DataDirectory, "accounts", ClientPaths.SafeSegment(AccountId!), "files")) + Path.DirectorySeparatorChar;
            if (!Path.GetFullPath(recovery.SourcePath).StartsWith(owned, StringComparison.OrdinalIgnoreCase) || !Regex.IsMatch(recovery.Sha256, "^[a-fA-F0-9]{64}$")) throw new ArgumentException("恢复文件必须位于当前账户私有文件目录并包含有效摘要。");
            savedRecovery = new() { ["sourcePath"] = Path.GetFullPath(recovery.SourcePath), ["sha256"] = recovery.Sha256 };
        }
        Guard(started); var id = await Store.StartTaskFileRequestAsync(path, body, savedRecovery); Guard(started); return id;
    }
    private async Task<TaskFileRequest> EnterTaskFileRequestAsync(string id, long started)
    {
        lock (taskFileLock) { if (!taskFileInFlight.Add(id)) throw new InvalidOperationException("此文件登记正在处理中。"); }
        try
        {
            var row = (await Store.TaskFileRequestsAsync()).SingleOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("文件登记记录已处理。"); Guard(started);
            ValidateTaskFileRequest(row.Path, JsonNode.Parse(row.Body)!.AsObject()); return row;
        }
        catch { lock (taskFileLock) taskFileInFlight.Remove(id); throw; }
    }
    public async Task<JsonNode?> TransmitTaskFileRegistrationAsync(string id, bool acknowledgedPotentialCharge, CancellationToken ct = default)
    {
        if (!acknowledgedPotentialCharge) throw new InvalidOperationException("请先核对上传及登记结果，并确认项目处理策略可能产生的费用。");
        var started = epoch; var row = await EnterTaskFileRequestAsync(id, started);
        try
        {
            if (await Store.IsRevokedAsync(ClientPaths.Project(row.Path)!)) throw new InvalidOperationException("项目已撤权。"); Guard(started);
            var body = JsonNode.Parse(row.Body)!.AsObject();
            await Store.FinishTaskFileRequestAsync(id, "sending"); Guard(started);
            var method = row.Path.Split('/').Length == 8 ? "POST" : "PUT";
            var result = await NetworkAsync(method, row.Path, body, id, ct); Guard(started);
            ValidateTaskFileProof(row, result);
            await Store.FinishTaskFileRequestAsync(id, "confirmed", result); Guard(started); return result;
        }
        catch (Exception error)
        {
            if (epoch == started) await Store.FinishTaskFileRequestAsync(id, "unknown", error: error.Message);
            throw;
        }
        finally { lock (taskFileLock) taskFileInFlight.Remove(id); }
    }
    private static void ValidateTaskFileProof(TaskFileRequest row, JsonNode? result)
    {
        var parts = row.Path.Split('/'); var body = JsonNode.Parse(row.Body);
        if (result?["taskId"]?.ToString() != parts[6] || result?["fileId"]?.ToString() != body?["fileId"]?.ToString() ||
            !Guid.TryParseExact(result?["materialId"]?.ToString(), "D", out _) || !Guid.TryParseExact(result?["versionId"]?.ToString(), "D", out _) ||
            parts.Length == 9 && (result?["materialId"]?.ToString() != parts[8] || result?["revision"]?.GetValue<int>() <= body?["expectedRevision"]?.GetValue<int>()) || result?["revision"]?.GetValue<int>() is not > 0) throw new InvalidDataException("响应未证明原文件已登记到当前任务，请核对服务端记录。");
    }
    public async Task<bool> TaskFileNeedsUploadAsync(string id, CancellationToken ct = default)
    {
        var started = epoch; var row = await EnterTaskFileRequestAsync(id, started);
        try
        {
            var fileId = JsonNode.Parse(row.Body)!["fileId"]!.GetValue<string>();
            var page = await GetFreshAsync("/api/v1/projects/" + ClientPaths.Project(row.Path) + "/files?limit=1&deleted=false&archived=false&fileId=" + fileId, ct); Guard(started);
            if (page?["items"] is not JsonArray items || items.Count != 1 || items[0]?["fileId"]?.ToString() != fileId) throw new InvalidOperationException("原文件未在当前文件库中找到。请核对归档、回收站或材料历史，不能重建上传。");
            return items[0]?["status"]?.ToString() switch { "pending" => true, "available" => false, _ => throw new InvalidOperationException("原文件当前状态不允许继续上传。") };
        }
        finally { lock (taskFileLock) taskFileInFlight.Remove(id); }
    }
    public async Task ReconcileTaskFileRegistrationAsync(string id, CancellationToken ct = default)
    {
        var started = epoch; var row = await EnterTaskFileRequestAsync(id, started);
        try
        {
            var parts = row.Path.Split('/'); var path = string.Join('/', parts.Take(8)); var cursors = new HashSet<string>(); string? cursor = null;
            for (var pageIndex = 0; pageIndex < 200; pageIndex++)
            {
                var page = await GetFreshAsync(path + "?limit=100" + (cursor == null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), ct); Guard(started);
                if (page?["items"] is not JsonArray items) throw new InvalidDataException("任务文件清单无效。");
                foreach (var item in items)
                {
                    if (item?["fileId"]?.ToString() != JsonNode.Parse(row.Body)?["fileId"]?.ToString()) continue;
                    ValidateTaskFileProof(row, item); await Store.FinishTaskFileRequestAsync(id, "confirmed", item); Guard(started); return;
                }
                cursor = page["nextCursor"]?.GetValue<string>();
                if (string.IsNullOrEmpty(cursor)) break;
                if (!cursors.Add(cursor)) throw new InvalidDataException("任务文件分页未前进。");
            }
            throw new InvalidOperationException("当前任务文件中没有原上传文件的完成证据。记录继续保留；若已在其他客户端替换，请人工核对材料历史。");
        }
        finally { lock (taskFileLock) taskFileInFlight.Remove(id); }
    }
    public async Task AbandonTaskFileRegistrationAsync(string id, bool acknowledged, CancellationToken ct = default)
    {
        if (!acknowledged) throw new InvalidOperationException("请核对服务端并确认仅停止本机恢复，不删除上传文件或历史版本。");
        var started = epoch; await EnterTaskFileRequestAsync(id, started);
        try { ct.ThrowIfCancellationRequested(); Guard(started); await Store.FinishTaskFileRequestAsync(id, "abandoned"); Guard(started); }
        finally { lock (taskFileLock) taskFileInFlight.Remove(id); }
    }
}
