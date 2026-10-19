using System.Text.Json.Nodes;

namespace Buwei.Windows.Core;

public sealed record SubmissionFile(string MaterialId, string VersionId, string Name);
public sealed record SubmissionFileSet(IReadOnlyList<SubmissionFile> Files, DateTimeOffset? OldestSnapshotAt);
public sealed record CachedSubmissionReview(string ProjectId, string TaskId, int Revision, long Epoch, SubmissionFileSet FileSet);

public sealed partial class ClientRepository
{
    private static string SubmissionTaskPath(string projectId, string taskId)
    {
        if (!Guid.TryParseExact(projectId, "D", out _) || !Guid.TryParseExact(taskId, "D", out _)) throw new ArgumentException("任务标识无效。");
        return "/api/v1/projects/" + projectId + "/tasks/" + taskId;
    }

    private async Task<Snapshot> CachedSnapshotAsync(string path, long started, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested(); Guard(started);
        if (AccountId == null) throw new InvalidOperationException("请先登录。");
        if (ClientPaths.Project(path) is { } project && await Store.IsRevokedAsync(project)) throw new InvalidOperationException("项目已撤权，不能使用本机缓存。");
        Guard(started);
        var snapshot = await Store.ReadSnapshotAsync(path); Guard(started); ct.ThrowIfCancellationRequested();
        return snapshot ?? throw new InvalidOperationException("任务或成果文件分页尚未完整保存到本机，请联网打开或重新准备离线内容。");
    }

    public async Task<SubmissionFileSet> ReadSubmissionFilesAsync(string projectId, string taskId, bool cacheOnly, CancellationToken ct = default)
    {
        var path = SubmissionTaskPath(projectId, taskId); var started = epoch;
        var seen = new HashSet<string>(); var versions = new HashSet<string>(); var cursors = new HashSet<string>(); var active = new List<SubmissionFile>();
        DateTimeOffset? oldest = null; string? cursor = null;
        for (var pageIndex = 0; ; pageIndex++)
        {
            ct.ThrowIfCancellationRequested(); Guard(started);
            if (pageIndex >= 200) throw new InvalidDataException("成果文件分页超过支持范围，请先整理文件。");
            var pagePath = path + "/files?limit=100" + (cursor == null ? "" : "&cursor=" + Uri.EscapeDataString(cursor));
            JsonNode? page;
            if (cacheOnly)
            {
                var snapshot = await CachedSnapshotAsync(pagePath, started, ct); page = snapshot.Data;
                if (oldest == null || snapshot.SavedAt < oldest) oldest = snapshot.SavedAt;
            }
            else page = await GetFreshAsync(pagePath, ct);
            Guard(started);
            if (page?["items"] is not JsonArray items || !page.AsObject().ContainsKey("nextCursor")) throw new InvalidDataException("成果文件清单缺少完整分页信息。");
            foreach (var file in items)
            {
                var material = file?["materialId"]?.GetValue<string>() ?? "";
                if (!Guid.TryParseExact(material, "D", out _) || !seen.Add(material)) throw new InvalidDataException("成果文件标识无效或分页出现重复，请联网刷新。");
                if (file?["taskId"]?.GetValue<string>() != taskId) throw new InvalidDataException("成果文件不属于当前任务。");
                if (!string.IsNullOrEmpty(file?["archivedAt"]?.ToString()) || !string.IsNullOrEmpty(file?["materialArchivedAt"]?.ToString()) || !string.IsNullOrEmpty(file?["deletedAt"]?.ToString())) continue;
                var version = file?["versionId"]?.GetValue<string>() ?? "";
                if (!Guid.TryParseExact(version, "D", out _) || !versions.Add(version)) throw new InvalidDataException("成果文件版本无效或重复，无法安全固定本轮版本。");
                active.Add(new(material, version, file?["name"]?.GetValue<string>() ?? material));
                if (active.Count > 10) throw new InvalidOperationException("当前成果文件超过 10 个，请先归档不参与本轮的文件。");
            }
            cursor = page["nextCursor"]?.GetValue<string>();
            if (string.IsNullOrEmpty(cursor)) break;
            if (cursor.Length > 4096 || !cursors.Add(cursor)) throw new InvalidDataException("成果文件分页未前进，请联网刷新。");
        }
        Guard(started); return new(active.AsReadOnly(), oldest);
    }

    public async Task<CachedSubmissionReview> ReviewCachedSubmissionAsync(string projectId, string taskId, int expectedRevision, CancellationToken ct = default)
    {
        var path = SubmissionTaskPath(projectId, taskId); var started = epoch;
        var task = await CachedSnapshotAsync(path, started, ct);
        if (task.Data?["taskId"]?.GetValue<string>() != taskId || expectedRevision <= 0 || task.Data?["revision"]?.GetValue<int>() != expectedRevision) throw new InvalidOperationException("成果草稿与缓存任务版本不同，请联网核对后处理草稿。");
        if (task.Data?["assigneeId"]?.GetValue<string>() != AccountId || task.Data?["lifecycleState"]?.GetValue<string>() is not ("in_progress" or "improve" or "rework")) throw new InvalidOperationException("缓存中的任务状态或负责人不允许提交。");
        var files = await ReadSubmissionFilesAsync(projectId, taskId, true, ct); Guard(started);
        files = files with { OldestSnapshotAt = files.OldestSnapshotAt is { } saved && saved < task.SavedAt ? saved : task.SavedAt };
        return new(projectId, taskId, expectedRevision, started, files);
    }

    public async Task<string> QueueReviewedSubmissionAsync(CachedSubmissionReview review, string body, CancellationToken ct = default)
    {
        Guard(review.Epoch); ct.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(body) || body.Length > 12000) throw new ArgumentException("成果说明应为 1–12000 字符。");
        var current = await ReviewCachedSubmissionAsync(review.ProjectId, review.TaskId, review.Revision, ct); Guard(review.Epoch);
        if (!current.FileSet.Files.SequenceEqual(review.FileSet.Files)) throw new InvalidOperationException("缓存文件版本在确认期间发生变化，请重新核对。");
        var id = Guid.NewGuid().ToString();
        var content = new JsonObject { ["expectedRevision"] = review.Revision, ["body"] = body.Trim(), ["materialVersionIds"] = new JsonArray(review.FileSet.Files.Select(f => (JsonNode?)JsonValue.Create(f.VersionId)).ToArray()) };
        await Store.EnqueueAsync(id, "POST", SubmissionTaskPath(review.ProjectId, review.TaskId) + "/submissions", content, rejectExistingPath: true, manualConfirmation: true);
        Guard(review.Epoch);
        StatusChanged?.Invoke("成果已落盘，尚未提交到服务端。请在同步中心联网同步并核对结果。");
        return id;
    }

    private static bool IsSubmissionWrite(PendingWrite row) => row.Method == "POST" && row.Path.EndsWith("/submissions", StringComparison.Ordinal) && ClientPaths.Writable(row.Method, row.Path);

    public async Task ConfirmQueuedSubmissionAsync(string id, bool acknowledged, CancellationToken ct = default)
    {
        if (!acknowledged) throw new InvalidOperationException("请先核对服务端记录及可能的自动评价费用。");
        var started = epoch;
        await syncing.WaitAsync(ct);
        try
        {
            Guard(started);
            var row = (await Store.WritesAsync()).FirstOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("本机提交记录不存在，请刷新核对。");
            if (row.AccountId != AccountId || !IsSubmissionWrite(row) || row.Status is not ("awaiting_confirmation" or "uncertain" or "sending")) throw new InvalidOperationException("此记录不能通过原键恢复，请刷新核对。");
            if (await Store.IsRevokedAsync(row.ProjectId)) throw new InvalidOperationException("项目权限已撤销，不能发送。");
            Guard(started); ct.ThrowIfCancellationRequested();
            await Store.MarkWriteAsync(row.Id, "pending"); Guard(started);
        }
        finally { syncing.Release(); }
        await SyncAsync(ct);
    }
}
