using Microsoft.Data.Sqlite;
using System.Text.Json.Nodes;

namespace Buwei.Windows.Core;

public sealed record PendingWrite(string Id, string AccountId, string ProjectId, string Method, string Path, string Body, string Status, string? Error, string? Server);
public sealed record Snapshot(JsonNode? Data, DateTimeOffset SavedAt);

public sealed class LocalStore : IDisposable
{
    private readonly object gate = new();
    private Task tail = Task.CompletedTask;
    private bool disposed;
    private string account = "anonymous";
    public string DataDirectory { get; }
    public string? AccountId => account == "anonymous" ? null : account;
    private string Database => Path.Combine(DataDirectory, "accounts", ClientPaths.SafeSegment(account), "workspace.db");
    public LocalStore(string dataDirectory) { DataDirectory = dataDirectory; Directory.CreateDirectory(dataDirectory); }
    public void SetAccount(string? accountId) => account = accountId ?? "anonymous";
    private Task<T> UseAsync<T>(Func<SqliteConnection, Task<T>> action)
    {
        // Capture the account-owned file before waiting; a switch must never redirect old writes.
        var file = Database;
        Task previous;
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        // Reserve FIFO position on the caller thread before dispatching to the thread pool.
        lock (gate) { ObjectDisposedException.ThrowIf(disposed, this); previous = tail; tail = completion.Task; }
        return Task.Run(async () =>
        {
        await previous.ConfigureAwait(false);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            await using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = file }.ToString());
            await connection.OpenAsync().ConfigureAwait(false);
            using var init = connection.CreateCommand();
            init.CommandText = """
                PRAGMA journal_mode=WAL;
                PRAGMA busy_timeout=5000;
                CREATE TABLE IF NOT EXISTS snapshots(path TEXT PRIMARY KEY, data TEXT NOT NULL, saved TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS drafts(key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS writes(id TEXT PRIMARY KEY, account TEXT NOT NULL, project TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, server TEXT, created INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS revoked(project TEXT PRIMARY KEY);
                """;
            await init.ExecuteNonQueryAsync().ConfigureAwait(false);
            return await action(connection).ConfigureAwait(false);
        }
        finally { completion.SetResult(); }
        });
    }
    private static SqliteCommand Command(SqliteConnection connection, string sql, params (string, object?)[] values)
    {
        var command = connection.CreateCommand(); command.CommandText = sql;
        foreach (var (key, value) in values) command.Parameters.AddWithValue(key, value ?? DBNull.Value);
        return command;
    }
    public async Task SaveSnapshotAsync(string path, JsonNode? data) => await UseAsync(async c =>
    {
        using var cmd = Command(c, "INSERT OR REPLACE INTO snapshots VALUES($p,$d,$t)", ("$p", ClientPaths.SnapshotKey(path)), ("$d", data?.ToJsonString() ?? "null"), ("$t", DateTimeOffset.UtcNow.ToString("O")));
        return await cmd.ExecuteNonQueryAsync();
    });
    public Task<Snapshot?> ReadSnapshotAsync(string path) => UseAsync<Snapshot?>(async c =>
    {
        using var cmd = Command(c, "SELECT data,saved FROM snapshots WHERE path=$p", ("$p", ClientPaths.SnapshotKey(path)));
        await using var reader = await cmd.ExecuteReaderAsync();
        return await reader.ReadAsync() ? new Snapshot(JsonNode.Parse(reader.GetString(0)), DateTimeOffset.Parse(reader.GetString(1))) : null;
    });
    public async Task SaveDraftAsync(string key, JsonNode content) => await UseAsync(async c => { using var cmd = Command(c, "INSERT OR REPLACE INTO drafts VALUES($k,$d)", ("$k", key), ("$d", content.ToJsonString())); return await cmd.ExecuteNonQueryAsync(); });
    public Task<JsonNode?> LoadDraftAsync(string key) => UseAsync(async c => { using var cmd = Command(c, "SELECT data FROM drafts WHERE key=$k", ("$k", key)); return JsonNode.Parse((string?)await cmd.ExecuteScalarAsync() ?? "null"); });
    public async Task DeleteDraftAsync(string key) => await UseAsync(async c => { using var cmd = Command(c, "DELETE FROM drafts WHERE key=$k", ("$k", key)); return await cmd.ExecuteNonQueryAsync(); });
    public async Task EnqueueAsync(string id, string method, string path, JsonNode? body)
    {
        var owner = AccountId ?? throw new InvalidOperationException("请先登录");
        var project = ClientPaths.Project(path) ?? throw new InvalidOperationException("缺少项目");
        if (!ClientPaths.Writable(method, path)) throw new InvalidOperationException("此操作需要联网");
        await UseAsync(async c =>
        {
            using var permission = Command(c, "SELECT count(*) FROM revoked WHERE project=$p", ("$p", project));
            if ((long)(await permission.ExecuteScalarAsync())! != 0) throw new InvalidOperationException("项目权限已撤销，修改保留但不能同步");
            using var cmd = Command(c, "INSERT OR IGNORE INTO writes(id,account,project,method,path,body,created) VALUES($i,$a,$p,$m,$u,$b,$t)",
                ("$i", id), ("$a", owner), ("$p", project), ("$m", method), ("$u", path), ("$b", body?.ToJsonString() ?? "{}"), ("$t", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            return await cmd.ExecuteNonQueryAsync();
        });
    }
    public Task<List<PendingWrite>> WritesAsync() => UseAsync(async c =>
    {
        using var cmd = Command(c, "SELECT id,account,project,method,path,body,status,error,server FROM writes ORDER BY created,rowid");
        await using var reader = await cmd.ExecuteReaderAsync(); var rows = new List<PendingWrite>();
        while (await reader.ReadAsync()) rows.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetString(3), reader.GetString(4), reader.GetString(5), reader.GetString(6), reader.IsDBNull(7) ? null : reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8)));
        return rows;
    });
    public async Task MarkWriteAsync(string id, string status, string? error = null, JsonNode? server = null) => await UseAsync(async c =>
    {
        using var cmd = Command(c, "UPDATE writes SET status=$s,error=$e,server=$v WHERE id=$i", ("$s", status), ("$e", error), ("$v", server?.ToJsonString()), ("$i", id)); return await cmd.ExecuteNonQueryAsync();
    });
    public async Task CompleteWriteAsync(string id) => await UseAsync(async c => { using var cmd = Command(c, "DELETE FROM writes WHERE id=$i", ("$i", id)); return await cmd.ExecuteNonQueryAsync(); });
    public async Task ConfirmWriteAsync(PendingWrite row, JsonNode? result) => await UseAsync(async c =>
    {
        using var transaction = c.BeginTransaction();
        var snapshots = new List<(string Path, JsonNode? Data)>();
        using (var read = Command(c, "SELECT path,data FROM snapshots"))
        {
            read.Transaction = transaction;
            await using var reader = await read.ExecuteReaderAsync();
            while (await reader.ReadAsync()) snapshots.Add((reader.GetString(0), JsonNode.Parse(reader.GetString(1))));
        }
        var taskId = result?["taskId"]?.ToString();
        foreach (var snapshot in snapshots)
        {
            var changed = false; var data = snapshot.Data;
            if (snapshot.Path == row.Path && row.Method == "PUT" && row.Path.Contains("/materials/") && data is JsonObject material)
            { material["currentVersion"] = result?.DeepClone(); material["revision"] = result?["revision"]?.DeepClone(); changed = true; }
            else if (snapshot.Path == row.Path && row.Method == "PATCH" && data is JsonObject detail && result is JsonObject fields)
            { foreach (var item in fields) detail[item.Key] = item.Value?.DeepClone(); changed = true; }
            else if (taskId != null && snapshot.Path.StartsWith("/api/v1/projects/" + row.ProjectId + "/tasks", StringComparison.Ordinal) && data?["items"] is JsonArray items)
            {
                var index = items.ToList().FindIndex(x => x?["taskId"]?.ToString() == taskId || x?["taskId"]?.ToString() == row.Id);
                if (index >= 0) { items[index] = result?.DeepClone(); changed = true; }
                else if (row.Method == "POST" && row.Path.EndsWith("/tasks", StringComparison.Ordinal) && !snapshot.Path.Contains("cursor=") && !snapshot.Path.Contains("q=") && !snapshot.Path.Contains("assigneeId=") && !snapshot.Path.Contains("lifecycleState="))
                { items.Insert(0, result?.DeepClone()); changed = true; }
            }
            if (!changed) continue;
            using var update = Command(c, "UPDATE snapshots SET data=$d,saved=$t WHERE path=$p", ("$d", data?.ToJsonString() ?? "null"), ("$t", DateTimeOffset.UtcNow.ToString("O")), ("$p", snapshot.Path));
            update.Transaction = transaction; await update.ExecuteNonQueryAsync();
        }
        if (taskId != null && taskId != row.Id && row.Method == "POST" && row.Path.EndsWith("/tasks", StringComparison.Ordinal))
        {
            var remaining = new List<(string Id, string Path, JsonObject Body)>();
            using (var read = Command(c, "SELECT id,path,body FROM writes WHERE id!=$i AND status='pending'", ("$i", row.Id)))
            {
                read.Transaction = transaction; await using var reader = await read.ExecuteReaderAsync();
                while (await reader.ReadAsync()) if (JsonNode.Parse(reader.GetString(2)) is JsonObject body) remaining.Add((reader.GetString(0), reader.GetString(1), body));
            }
            foreach (var next in remaining)
            {
                foreach (var field in new[] { "taskId", "targetId", "parentTaskId" }) if (next.Body[field]?.ToString() == row.Id) next.Body[field] = taskId;
                if (next.Body["dependsOnTaskIds"] is JsonArray deps) for (var i = 0; i < deps.Count; i++) if (deps[i]?.ToString() == row.Id) deps[i] = taskId;
                using var update = Command(c, "UPDATE writes SET path=$p,body=$b WHERE id=$i", ("$p", next.Path.Replace("/tasks/" + row.Id, "/tasks/" + taskId, StringComparison.Ordinal)), ("$b", next.Body.ToJsonString()), ("$i", next.Id));
                update.Transaction = transaction; await update.ExecuteNonQueryAsync();
            }
        }
        using var remove = Command(c, "DELETE FROM writes WHERE id=$i", ("$i", row.Id)); remove.Transaction = transaction; await remove.ExecuteNonQueryAsync();
        transaction.Commit(); return 0;
    });
    public async Task RevokeAsync(string project) => await UseAsync(async c =>
    {
        using var cmd = Command(c, "INSERT OR IGNORE INTO revoked VALUES($p); UPDATE writes SET status='blocked',error='项目权限已撤销' WHERE project=$p; DELETE FROM snapshots WHERE path=$root OR path LIKE $prefix;",
            ("$p", project), ("$root", "/api/v1/projects/" + project), ("$prefix", "/api/v1/projects/" + project + "/%"));
        return await cmd.ExecuteNonQueryAsync();
    });
    public Task<bool> IsRevokedAsync(string project) => UseAsync(async c => { using var cmd = Command(c, "SELECT count(*) FROM revoked WHERE project=$p", ("$p", project)); return (long)(await cmd.ExecuteScalarAsync())! != 0; });
    public async Task RestoreAccessAsync(string project) => await UseAsync(async c => { using var cmd = Command(c, "DELETE FROM revoked WHERE project=$p", ("$p", project)); return await cmd.ExecuteNonQueryAsync(); });
    public void Dispose() { lock (gate) disposed = true; }
}
