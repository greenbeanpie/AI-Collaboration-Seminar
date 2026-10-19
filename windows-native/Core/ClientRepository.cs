using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Net.WebSockets;

namespace Buwei.Windows.Core;

public sealed class ApiException(int status, string code, string message, JsonNode? details = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public JsonNode? Details { get; } = details;
}

public sealed partial class ClientRepository : IDisposable
{
    private readonly CookieContainer cookies;
    private readonly SecretStore secrets;
    private readonly SemaphoreSlim syncing = new(1);
    private long epoch;
    private int activeRequests;
    public int ActiveRequests => Volatile.Read(ref activeRequests);
    public HttpClient Http { get; }
    public LocalStore Store { get; }
    public string? AccountId => User?["id"]?.GetValue<string>();
    public JsonNode? User { get; private set; }
    public bool LastReadOffline { get; private set; }
    public DateTimeOffset? LastSnapshotAt { get; private set; }
    public event Action? AccountChanged;
    public event Action<string>? StatusChanged;
    public void ConfigureSocket(ClientWebSocketOptions options, string expectedAccount)
    {
        if (AccountId != expectedAccount) throw new InvalidOperationException("账号已变化");
        options.Cookies = cookies;
        options.KeepAliveInterval = TimeSpan.FromSeconds(30);
    }
    public long Epoch => Interlocked.Read(ref epoch);
    public ClientRepository(LocalStore store, SecretStore secrets, HttpMessageHandler? handler = null, Uri? origin = null)
    {
        Store = store; this.secrets = secrets; cookies = new();
        var address = origin ?? new Uri(ClientPaths.ProductionOrigin);
        if (address.AbsoluteUri.TrimEnd('/') != ClientPaths.ProductionOrigin && !(address.IsLoopback && address.Scheme == "http"))
            throw new ArgumentException("只允许固定服务地址或本机测试地址");
        Http = new HttpClient(handler ?? new HttpClientHandler { CookieContainer = cookies, AllowAutoRedirect = false }) { BaseAddress = address, Timeout = TimeSpan.FromSeconds(30) };
        var version = System.Reflection.Assembly.GetEntryAssembly()?.GetName().Version ?? new Version(0, 1, 1);
        Http.DefaultRequestHeaders.UserAgent.ParseAdd($"Buwei-Windows-Native/{version.Major}.{version.Minor}.{version.Build}");
    }
    private void Guard(long started)
    {
        if (Interlocked.Read(ref epoch) != started) throw new InvalidOperationException("账号已变化，请重新打开页面");
    }
    private void SetUser(JsonNode? user)
    {
        Interlocked.Increment(ref epoch); User = user?.DeepClone(); Store.SetAccount(AccountId); AccountChanged?.Invoke();
    }
    public async Task RestoreAsync(CancellationToken ct = default)
    {
        var saved = JsonNode.Parse(secrets.Read("session") ?? "null");
        if (saved == null) return;
        if (saved["cookie"]?.GetValue<string>() is { } cookie) cookies.SetCookies(Http.BaseAddress!, cookie);
        SetUser(saved["user"]);
        try { var session = await NetworkAsync("GET", "/api/v1/auth/session", null, null, ct); SetUser(session?["user"]); PersistSession(); }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException) { StatusChanged?.Invoke("离线模式：仅可查看本机已保存内容"); }
        catch (ApiException ex) when (ex.Status == 401) { ClearSession(); }
    }
    public async Task ExchangeAsync(string code, string verifier, CancellationToken ct = default)
    {
        var started = epoch;
        var data = await NetworkAsync("POST", "/api/v1/auth/native/exchange", new JsonObject { ["code"] = code, ["codeVerifier"] = verifier }, null, ct);
        Guard(started);
        if (data?["user"]?["id"] == null) throw new InvalidDataException("服务未返回有效账户");
        SetUser(data["user"]); PersistSession();
    }
    private void PersistSession()
    {
        secrets.Write("session", User == null ? null : new JsonObject { ["user"] = User.DeepClone(), ["cookie"] = cookies.GetCookieHeader(Http.BaseAddress!) }.ToJsonString());
    }
    private void ClearSession()
    {
        foreach (Cookie cookie in cookies.GetCookies(Http.BaseAddress!)) cookie.Expired = true;
        secrets.Write("session", null); secrets.Write("pkce", null); SetUser(null);
    }
    public async Task LogoutAsync(CancellationToken ct = default)
    {
        // Do not claim revocation on network failure. Local credentials are removed regardless.
        var started = epoch;
        Interlocked.Increment(ref epoch);
        secrets.Write("pkce", null);
        try { await NetworkAsync("DELETE", "/api/v1/auth/session", null, null, ct); }
        finally { if (epoch == started + 1) ClearSession(); }
    }
    public Task<JsonNode?> GetAsync(string path, CancellationToken ct = default) => ReadAsync(path, true, ct);
    public Task<JsonNode?> GetFreshAsync(string path, CancellationToken ct = default) => ReadAsync(path, false, ct);
    private async Task<JsonNode?> ReadAsync(string path, bool allowCache, CancellationToken ct)
    {
        path = ClientPaths.Normalize(path); var started = epoch; var account = AccountId;
        try
        {
            var data = await NetworkAsync("GET", path, null, null, ct); Guard(started);
            LastReadOffline = false; LastSnapshotAt = null;
            if (account != null && ClientPaths.Cacheable(path))
            {
                await Store.SaveSnapshotAsync(path, data); Guard(started);
                if (ClientPaths.Project(path) is { } project && path == "/api/v1/projects/" + project) await Store.RestoreAccessAsync(project);
            }
            var visible = await OverlayAsync(path, data); Guard(started); return visible;
        }
        catch (Exception ex) when (allowCache && (ex is HttpRequestException || ex is TaskCanceledException && !ct.IsCancellationRequested))
        {
            Guard(started);
            if (account == null || !ClientPaths.Cacheable(path)) throw;
            if (ClientPaths.Project(path) is { } project && await Store.IsRevokedAsync(project)) throw new InvalidOperationException("本机项目已撤权，不能继续访问");
            var snapshot = await Store.ReadSnapshotAsync(path); Guard(started);
            if (snapshot == null) throw new InvalidOperationException("此内容尚未保存到本机，首次打开需要联网", ex);
            LastReadOffline = true; LastSnapshotAt = snapshot.SavedAt;
            StatusChanged?.Invoke("本机缓存版本 · " + snapshot.SavedAt.ToLocalTime().ToString("g"));
            var visible = await OverlayAsync(path, snapshot.Data); Guard(started); return visible;
        }
        catch (ApiException ex) when (ex.Status is 403 or 404 && ClientPaths.Project(path) is { } project)
        {
            Guard(started);
            // Only a project-root refusal establishes lost membership; action denials do not.
            try { await NetworkAsync("GET", "/api/v1/projects/" + project, null, null, ct); }
            catch (ApiException root) when (root.Status is 403 or 404) { Guard(started); await Store.RevokeAsync(project); }
            Guard(started);
            if (ClientPaths.ResourceIndexScope(path) is { } scope) await Store.PurgeSnapshotScopeAsync(scope);
            throw;
        }
    }
    public async Task<JsonNode?> SendAsync(string method, string path, JsonNode? body = null, bool allowOffline = false, CancellationToken ct = default)
    {
        path = ClientPaths.Normalize(path); method = method.ToUpperInvariant(); var started = epoch;
        var id = Guid.NewGuid().ToString();
        if (allowOffline && AccountId != null && ClientPaths.Writable(method, path))
        {
            Guard(started); await Store.EnqueueAsync(id, method, path, body); Guard(started);
            await SyncAsync(ct); Guard(started);
            var pending = (await Store.WritesAsync()).FirstOrDefault(x => x.Id == id);
            if (pending != null)
            {
                if (pending.Status != "pending") throw new ApiException(409, "SYNC_BLOCKED", pending.Error ?? "修改已保留，请处理同步冲突", JsonNode.Parse(pending.Server ?? "null"));
                StatusChanged?.Invoke("本机待同步 · 联网后将使用相同幂等键发送");
                return new JsonObject { ["offlinePending"] = true, ["localId"] = id };
            }
            return writeResults.Remove(id, out var ownResult) ? ownResult : null;
        }
        var data = await NetworkAsync(method, path, body, id, ct); Guard(started); return data;
    }
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, JsonNode?> writeResults = new();
    public async Task SyncAsync(CancellationToken ct = default)
    {
        await syncing.WaitAsync(ct);
        var started = epoch; var account = AccountId;
        try
        {
            while (true)
            {
                var row = (await Store.WritesAsync()).FirstOrDefault();
                if (row == null) break;
                Guard(started);
                if (row.AccountId != account || row.Status != "pending") break;
                try
                {
                    // Persist before dispatch: a crash or lost response must not silently replay a potentially paid submission.
                    if (IsSubmissionWrite(row)) { await Store.MarkWriteAsync(row.Id, "sending"); Guard(started); }
                    var tail = row.Path[("/api/v1/projects/" + row.ProjectId + "/").Length..];
                    var data = await NetworkAsync("POST", "/api/v1/projects/" + row.ProjectId + "/offline-sync",
                        new JsonObject { ["method"] = row.Method, ["tail"] = tail, ["body"] = JsonNode.Parse(row.Body) }, row.Id, ct); Guard(started);
                    if (IsSubmissionWrite(row))
                    {
                        var sent = JsonNode.Parse(row.Body);
                        if (!Guid.TryParseExact(data?["submissionId"]?.ToString(), "D", out _) || data?["taskId"]?.ToString() != row.Path.Split('/')[6] ||
                            data?["submittedBy"]?.ToString() != row.AccountId || data?["body"]?.ToString() != sent?["body"]?.ToString() ||
                            !JsonNode.DeepEquals(data?["materialVersionIds"], sent?["materialVersionIds"])) throw new InvalidDataException("服务端响应未证明原成果提交已完成。");
                    }
                    writeResults[row.Id] = data?.DeepClone();
                    if (writeResults.Count > 128) writeResults.Clear();
                    await Store.ConfirmWriteAsync(row, data);
                    StatusChanged?.Invoke("服务端已提交");
                }
                catch (ApiException ex)
                {
                    Guard(started);
                    if (ex.Status == 401) { ClearSession(); throw; }
                    if (IsSubmissionWrite(row) && (ex.Status is 408 or 429 || ex.Status >= 500 || ex.Status == 409 && ex.Code is "INVALID_STATE" or "IDEMPOTENCY_CONFLICT"))
                    { await Store.MarkWriteAsync(row.Id, "uncertain", "提交结果尚未确认，请核对服务端记录后使用原幂等键恢复。" + ex.Message); break; }
                    if (ex.Status == 409)
                    {
                        JsonNode? server = ex.Details;
                        try { server = await NetworkAsync("GET", row.Path, null, null, ct); } catch (Exception error) when (error is ApiException or HttpRequestException or TaskCanceledException) { }
                        Guard(started); await Store.MarkWriteAsync(row.Id, "conflict", ex.Message, server);
                    }
                    else if (ex.Status >= 500 || ex.Status == 429) break;
                    else
                    {
                        await Store.MarkWriteAsync(row.Id, "blocked", ex.Message, ex.Details);
                        if (ex.Status is 403 or 404)
                        {
                            try { await NetworkAsync("GET", "/api/v1/projects/" + row.ProjectId, null, null, ct); }
                            catch (ApiException root) when (root.Status is 403 or 404) { Guard(started); await Store.RevokeAsync(row.ProjectId); }
                        }
                    }
                    break;
                }
                catch (Exception ex) when (ex is HttpRequestException || ex is OperationCanceledException || IsSubmissionWrite(row) && ex is InvalidDataException or System.Text.Json.JsonException)
                {
                    Guard(started);
                    if (IsSubmissionWrite(row)) await Store.MarkWriteAsync(row.Id, "uncertain", "发送中断或响应无法确认，请核对服务端记录后使用原幂等键恢复。");
                    if (ct.IsCancellationRequested) throw;
                    break;
                }
            }
        }
        finally { syncing.Release(); }
    }
    public async Task ResolveAsync(string id, JsonNode? revisedBody, bool discard, CancellationToken ct = default)
    {
        var started = epoch;
        await syncing.WaitAsync(ct);
        try
        {
            Guard(started);
            var row = (await Store.WritesAsync()).FirstOrDefault(x => x.Id == id) ?? throw new InvalidOperationException("同步记录不存在");
            Guard(started);
            if (row.AccountId != AccountId) throw new InvalidOperationException("账号不匹配");
            if (!discard && row.Status is "awaiting_confirmation" or "uncertain" or "sending") throw new InvalidOperationException("此提交只能核对后使用原幂等键恢复，不能生成新键重发。");
            if (!discard && revisedBody == null) throw new InvalidOperationException("请核对服务端当前版本后重新编辑");
            if (!discard) { await Store.EnqueueAsync(Guid.NewGuid().ToString(), row.Method, row.Path, revisedBody); Guard(started); }
            await Store.CompleteWriteAsync(id); Guard(started);
        }
        finally { syncing.Release(); }
        if (!discard) await SyncAsync(ct);
    }
    private async Task<JsonNode?> NetworkAsync(string method, string path, JsonNode? body, string? idempotencyKey, CancellationToken ct)
    {
        using var activity = new RequestLease(this);
        var started = epoch;
        using var message = new HttpRequestMessage(new HttpMethod(method), ClientPaths.Normalize(path));
        message.Headers.Add("X-Request-Id", Guid.NewGuid().ToString());
        if (method != "GET" && System.Text.RegularExpressions.Regex.IsMatch(path, "^/api/v1/auth/(?:profile|password|personal-profile|recovery-email(?:/verify)?)$"))
            message.Headers.Add("X-Account-Settings", "1");
        if (idempotencyKey != null) message.Headers.Add("Idempotency-Key", idempotencyKey);
        if (body != null) message.Content = JsonContent.Create(body, ClientJson.Default.JsonNode);
        using var response = await Http.SendAsync(message, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
        if ((int)response.StatusCode is >= 300 and < 400) throw new InvalidDataException("接口重定向被拒绝");
        if (response.Content.Headers.ContentLength is > 16_777_216) throw new InvalidDataException("接口响应过大，请缩小分页范围");
        using var bounded = new MemoryStream();
        await using var input = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        var buffer = new byte[65536]; int count;
        while ((count = await input.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
        {
            if (bounded.Length + count > 16_777_216) throw new InvalidDataException("接口响应过大");
            await bounded.WriteAsync(buffer.AsMemory(0, count), ct).ConfigureAwait(false);
        }
        var envelope = bounded.Length == 0 ? null : JsonNode.Parse(bounded.ToArray());
        Guard(started);
        if (response.StatusCode == HttpStatusCode.Unauthorized && User != null) ClearSession();
        if (!response.IsSuccessStatusCode) throw new ApiException((int)response.StatusCode, envelope?["error"]?["code"]?.GetValue<string>() ?? "HTTP_ERROR", envelope?["error"]?["message"]?.GetValue<string>() ?? $"服务请求失败（{(int)response.StatusCode}）", envelope?["error"]?["details"]?.DeepClone());
        return envelope?["data"]?.DeepClone();
    }
    private async Task<JsonNode?> OverlayAsync(string path, JsonNode? data)
    {
        var account = AccountId; var writes = await Store.WritesAsync();
        return await Task.Run(() =>
        {
        var view = data?.DeepClone();
        foreach (var row in writes)
        {
            if (row.AccountId != account || row.Status == "blocked") continue;
            var body = JsonNode.Parse(row.Body);
            if (path == row.Path && row.Method is "PATCH" or "PUT" && view is JsonObject obj && body is JsonObject fields)
            {
                foreach (var field in fields.Where(x => x.Key != "expectedRevision")) obj[field.Key] = field.Value?.DeepClone();
                obj["offlinePending"] = true;
            }
        }
        return view;
        });
    }
    public void Dispose() { Http.Dispose(); syncing.Dispose(); Store.Dispose(); }
    private sealed class RequestLease : IDisposable
    {
        private ClientRepository? owner;
        public RequestLease(ClientRepository repository) { owner = repository; Interlocked.Increment(ref repository.activeRequests); }
        public void Dispose() { var repository = Interlocked.Exchange(ref owner, null); if (repository != null) Interlocked.Decrement(ref repository.activeRequests); }
    }
    public async Task<OfflinePreparation> PrepareProjectAsync(string projectId, CancellationToken ct = default, OfflinePreparationLimits? limits = null)
    {
        if (!Guid.TryParse(projectId, out _)) throw new ArgumentException("项目标识无效");
        limits ??= new(); limits.Validate();
        var started = epoch; if (AccountId == null) throw new InvalidOperationException("请先登录");
        var root = "/api/v1/projects/" + projectId;
        var cached = new HashSet<string>(); var partial = new Dictionary<string, string>(); var preparedSections = new HashSet<string>();
        var attempted = 0; long received = 0;
        await Store.SaveSnapshotAsync(root + "/offline-ready", new JsonObject { ["scope"] = "project-text-v2", ["state"] = "preparing" }); Guard(started);
        async Task<JsonNode?> Read(string path)
        {
            Guard(started); ct.ThrowIfCancellationRequested();
            if (attempted >= limits.MaxRequests) throw new InvalidDataException("离线准备达到接口数量上限，已有缓存保留，本次未完成。");
            attempted++;
            StatusChanged?.Invoke($"离线准备：累计读取接口 {attempted} 次（含失败尝试），已保存 {cached.Count} 个入口");
            return await NetworkAsync("GET", path, null, null, ct);
        }
        async Task<JsonNode?> Load(string path, Func<JsonNode?, bool>? accepts = null)
        {
            Guard(started);
            JsonNode? data;
            try { data = await Read(path); }
            catch (ApiException error) when (error.Status is 403 or 404)
            {
                Guard(started);
                if (path == root) { await Store.RevokeAsync(projectId); throw; }
                try { await Read(root); }
                catch (ApiException refusal) when (refusal.Status is 403 or 404) { Guard(started); await Store.RevokeAsync(projectId); throw; }
                throw;
            }
            Guard(started);
            received += await Task.Run(() => System.Text.Encoding.UTF8.GetByteCount(data?.ToJsonString() ?? "null"), ct); Guard(started);
            if (received > limits.MaxBytes) throw new InvalidDataException("离线准备达到文本容量上限，已有缓存保留，本次未完成。");
            if (accepts != null && !accepts(data)) throw new InvalidDataException("接口响应与固定离线入口不一致。");
            await Store.SaveSnapshotAsync(path, data); Guard(started); cached.Add(ClientPaths.SnapshotKey(path));
            if (path == root) { await Store.RestoreAccessAsync(projectId); Guard(started); }
            return data;
        }
        async Task<List<JsonNode>> List(string path, int limit = 100)
        {
            var all = new List<JsonNode>(); var seen = new HashSet<string>(); string? cursor = null;
            var basis = path + (path.Contains('?') ? "&" : "?") + "limit=" + limit;
            do
            {
                var data = await Load(basis + (cursor == null ? "" : "&cursor=" + Uri.EscapeDataString(cursor)), x => x?["items"] is JsonArray);
                foreach (var row in data?["items"]?.AsArray() ?? []) if (row != null) all.Add(row.DeepClone());
                cursor = data?["nextCursor"]?.GetValue<string>();
                if (cursor != null && (!seen.Add(cursor) || seen.Count >= limits.MaxPages)) throw new InvalidDataException("离线准备分页未正常前进或达到分页上限。");
            } while (cursor != null);
            return all;
        }
        async Task PrepareIndex(string type, string version)
        {
            if (!Guid.TryParse(version, out _)) throw new InvalidDataException("固定资料版本标识无效。");
            var path = root + "/resource-index/" + type + "/" + version;
            var sections = new HashSet<string>(); var offset = 0; var directoryOffsets = new HashSet<int>(); JsonNode? baseline = null;
            try
            {
                do
                {
                    if (!directoryOffsets.Add(offset) || directoryOffsets.Count > limits.MaxPages) throw new InvalidDataException("资料目录分页未前进或达到上限。");
                    var directory = await Load(path + "?offset=" + offset, x => x?["items"] is JsonArray && x["versionId"]?.ToString() == version && x["resourceType"]?.ToString() == type && x["revision"] is JsonValue revision && revision.TryGetValue<int>(out var value) && value > 0 && (baseline == null || JsonNode.DeepEquals(baseline, x["revision"])));
                    if (directory?["items"] is not JsonArray entries || directory["versionId"]?.ToString() != version || directory["resourceType"]?.ToString() != type)
                        throw new InvalidDataException("资料目录与固定版本不一致。");
                    if (baseline != null && !JsonNode.DeepEquals(baseline, directory["revision"])) throw new InvalidDataException("资料生命周期在离线准备中发生变化，请刷新后重试。");
                    baseline ??= directory["revision"]?.DeepClone();
                    if (directory["indexStatus"]?.ToString() != "ready" || directory["coverage"]?.ToString() is not ("ready" or "complete" or "full"))
                        partial[type + "/" + version] = "索引或原文覆盖尚未完成";
                    foreach (var entry in entries)
                    {
                        var section = entry?["sectionId"]?.ToString();
                        if (string.IsNullOrEmpty(section) || section.Length > 200) throw new InvalidDataException("原文分节标识无效。");
                        sections.Add(section);
                    }
                    if (directory["nextOffset"] == null) break;
                    var next = directory["nextOffset"]!.GetValue<int>();
                    if (next <= offset || next > 1_000_000) throw new InvalidDataException("资料目录分页未前进。");
                    offset = next;
                } while (true);
                foreach (var section in sections)
                {
                    var readOffsets = new HashSet<int>(); offset = 0;
                    do
                    {
                        if (!readOffsets.Add(offset) || readOffsets.Count > limits.MaxPages) throw new InvalidDataException("原文续读未前进或达到上限。");
                        var content = await Load(path + "/section?sectionId=" + Uri.EscapeDataString(section) + "&offset=" + offset + "&neighbors=true", x => x?["versionId"]?.ToString() == version && x["resourceType"]?.ToString() == type && x["sectionId"]?.ToString() == section && JsonNode.DeepEquals(baseline, x["revision"]));
                        if (content?["versionId"]?.ToString() != version || content["resourceType"]?.ToString() != type || content["sectionId"]?.ToString() != section || !JsonNode.DeepEquals(baseline, content["revision"]))
                            throw new InvalidDataException("原文与固定资料版本或生命周期不一致。");
                        if (content["text"] == null && content["fragments"] is not JsonArray) throw new InvalidDataException("原文响应缺少正文或片段。");
                        if (content["nextOffset"] == null) break;
                        var next = content["nextOffset"]!.GetValue<int>();
                        if (next <= offset || next > 1_000_000) throw new InvalidDataException("原文续读未前进。"); offset = next;
                    } while (true);
                    preparedSections.Add(type + "/" + version + "/" + section);
                }
            }
            catch (ApiException error) when (error.Status is 403 or 404 or 409)
            {
                Guard(started); if (await Store.IsRevokedAsync(projectId)) throw;
                if (error.Status is 403 or 404)
                {
                    await Store.PurgeSnapshotScopeAsync(path); Guard(started);
                    cached.RemoveWhere(x => x == path || x.StartsWith(path + "/", StringComparison.Ordinal) || x.StartsWith(path + "?", StringComparison.Ordinal));
                }
                partial[type + "/" + version] = error.Message;
            }
        }
        await Load(root); await Load(root + "/members/me"); await Load(root + "/tasks/graph"); await Load(root + "/goal");
        await List("/api/v1/projects?status=active&q=", 20); await List(root + "/members");
        var tasks = await List(root + "/tasks?q=", 50);
        foreach (var task in tasks)
        {
            var id = task["taskId"]?.GetValue<string>(); if (id == null) continue;
            await Load(root + "/tasks/" + id); await List(root + "/tasks/" + id + "/files");
            await List(root + "/tasks/" + id + "/submissions", 30);
            await List(root + "/comments?targetType=task&targetId=" + id, 50);
        }
        var materials = await List(root + "/materials");
        foreach (var material in materials)
        {
            var id = material["materialId"]?.GetValue<string>(); if (id == null) continue;
            await Load(root + "/materials/" + id); var versions = await List(root + "/materials/" + id + "/versions", 30);
            var ids = versions.Select(x => x["versionId"]?.ToString()).Append(material["currentVersionId"]?.ToString()).Where(x => !string.IsNullOrEmpty(x)).Distinct();
            foreach (var version in ids)
            {
                await Load(root + "/materials/" + id + "/versions/" + version); await PrepareIndex("material", version!);
            }
        }
        var resources = await List(root + "/resource-library?q=&archived=false", 50);
        foreach (var resource in resources)
        {
            var type = resource["resourceType"]?.GetValue<string>(); var id = resource["resourceId"]?.GetValue<string>();
            if (type is "material" or "source" && id != null) await Load(root + "/resource-library/" + type + "/" + id);
        }
        await List(root + "/files?deleted=false", 30);
        var sources = await List(root + "/sources");
        foreach (var source in sources)
        {
            var id = source["sourceId"]?.GetValue<string>(); if (id == null) continue;
            await Load(root + "/sources/" + id);
            if (source["currentVersionId"]?.GetValue<string>() is { } version)
            {
                await Load(root + "/sources/" + id + "/versions/" + version); await PrepareIndex("source", version);
            }
        }
        Guard(started);
        await Store.SaveSnapshotAsync(root + "/offline-ready", new JsonObject { ["preparedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["scope"] = "project-text-v2", ["state"] = partial.Count == 0 ? "text-ready" : "partial", ["cachedEndpoints"] = cached.Count, ["sections"] = preparedSections.Count,
            ["incomplete"] = new JsonArray(partial.Select(x => (JsonNode?)new JsonObject { ["resource"] = x.Key, ["reason"] = x.Value }).ToArray()) }); Guard(started);
        return new(cached.Count, preparedSections.Count, partial.Count, received);
    }
}

public sealed record OfflinePreparation(int Endpoints, int Sections, int PartialResources, long TextBytes);
public sealed record OfflinePreparationLimits(long MaxBytes = 128L * 1024 * 1024, int MaxRequests = 2000, int MaxPages = 200)
{
    internal void Validate()
    {
        if (MaxBytes is <= 0 or > 128L * 1024 * 1024 || MaxRequests is <= 0 or > 2000 || MaxPages is <= 0 or > 200) throw new ArgumentOutOfRangeException(nameof(MaxBytes), "离线准备额度超出支持范围。");
    }
}

[JsonSerializable(typeof(JsonNode))]
[JsonSourceGenerationOptions(WriteIndented = false)]
public partial class ClientJson : JsonSerializerContext;
