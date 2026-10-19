using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("DPAPI regression requires Windows");
var tests = new List<(string Name, Func<Task> Run)>();
const string Project = "11111111-1111-4111-8111-111111111111";
const string Root = "/api/v1/projects/" + Project;
const string TaskPath = Root + "/tasks/22222222-2222-4222-8222-222222222222";
const string State = "sssssssssssssssssssssssssssssssssssssssssss";
const string Code = "ccccccccccccccccccccccccccccccccccccccccccc";

tests.Add(("lost response retries stable key through offline-sync wrapper", async () =>
{
    using var f = new Fixture(); await f.Login();
    var keys = new List<string>(); var bodies = new List<string>(); var applied = new HashSet<string>();
    f.Handler.Route = request =>
    {
        Equal(request.Method, "POST"); Equal(request.Path, Root + "/offline-sync");
        keys.Add(request.Key!); bodies.Add(request.Body!);
        var payload = JsonNode.Parse(request.Body!)!;
        Equal(payload["method"]!.GetValue<string>(), "POST"); Equal(payload["tail"]!.GetValue<string>(), "comments");
        Equal(payload["body"]!["text"]!.GetValue<string>(), "durable");
        if (applied.Add(request.Key!)) throw new HttpRequestException("synthetic response lost after server commit");
        return Task.FromResult(Reply(new JsonObject { ["commentId"] = "comment-one" }));
    };
    var result = await f.Repository.SendAsync("POST", Root + "/comments", new JsonObject { ["text"] = "durable" }, true);
    True(result?["offlinePending"]?.GetValue<bool>() == true); Equal((await f.Store.WritesAsync()).Count, 1);
    await f.Repository.SyncAsync();
    Equal(keys.Count, 2); Equal(keys[0], keys[1]); Equal(bodies[0], bodies[1]); Equal(applied.Count, 1); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("concurrent durable callers receive only their own result", async () =>
{
    using var f = new Fixture(); await f.Login(); var entered = NewSignal(); var release = NewSignal(); var count = 0;
    f.Handler.Route = async request =>
    {
        if (Interlocked.Increment(ref count) == 1) { entered.SetResult(); await release.Task; }
        var marker = JsonNode.Parse(request.Body!)!["body"]!["text"]!.GetValue<string>();
        return Reply(new JsonObject { ["marker"] = marker });
    };
    var first = f.Repository.SendAsync("POST", Root + "/comments", new JsonObject { ["text"] = "first" }, true);
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var second = f.Repository.SendAsync("POST", Root + "/comments", new JsonObject { ["text"] = "second" }, true);
    await Until(async () => (await f.Store.WritesAsync()).Count == 2); release.SetResult();
    var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(10));
    Equal(results[0]?["marker"]?.GetValue<string>(), "first"); Equal(results[1]?["marker"]?.GetValue<string>(), "second");
}));

tests.Add(("401 clears identity and prevents later cached reads", async () =>
{
    using var f = new Fixture(); await f.Login(); await f.Store.SaveSnapshotAsync(TaskPath, new JsonObject { ["secret"] = "account-a" });
    f.Handler.Route = _ => Task.FromResult(Error(401)); await Reject(() => f.Repository.GetAsync(TaskPath));
    Equal(f.Repository.AccountId, null); Equal(f.Secrets.Read("session"), null);
    f.Handler.Route = _ => throw new HttpRequestException("offline");
    await Reject(() => f.Repository.GetAsync(TaskPath));
}));

tests.Add(("account switch rejects in-flight GET and never caches into new account", async () =>
{
    using var f = new Fixture(); await f.Login(); var entered = NewSignal(); var release = NewSignal();
    f.Handler.Route = async _ => { entered.SetResult(); await release.Task; return Reply(new JsonObject { ["secret"] = "old-account" }); };
    var reading = f.Repository.GetAsync(TaskPath); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await f.Login("account-b"); release.SetResult(); await Reject(() => reading);
    Equal(f.Repository.AccountId, "account-b"); Equal(await f.Store.ReadSnapshotAsync(TaskPath), null);
}));

tests.Add(("logout calls DELETE auth/session and clears PKCE even after network failure", async () =>
{
    using var f = new Fixture(); await f.Login(); f.Pending();
    f.Handler.Route = request => { Equal(request.Method, "DELETE"); Equal(request.Path, "/api/v1/auth/session"); return Task.FromResult(Reply(new JsonObject { ["revoked"] = true })); };
    await f.Repository.LogoutAsync(); Equal(f.Repository.AccountId, null); Equal(f.Secrets.Read("pkce"), null); Equal(f.Secrets.Read("session"), null);
    await f.Login(); f.Pending(); f.Handler.Route = _ => throw new HttpRequestException("offline");
    await Reject(() => f.Repository.LogoutAsync()); Equal(f.Repository.AccountId, null); Equal(f.Secrets.Read("pkce"), null); Equal(f.Secrets.Read("session"), null);
}));

tests.Add(("logout invalidates in-flight exchange", async () =>
{
    using var f = new Fixture(); await f.Login(); var entered = NewSignal(); var release = NewSignal();
    f.Handler.Route = async request =>
    {
        if (request.Path == "/api/v1/auth/native/exchange") { entered.SetResult(); await release.Task; return Reply(new JsonObject { ["user"] = new JsonObject { ["id"] = "account-b" } }); }
        return Reply(new JsonObject { ["revoked"] = true });
    };
    var exchange = f.Repository.ExchangeAsync(Code, State); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await f.Repository.LogoutAsync(); release.SetResult(); await Reject(() => exchange); Equal(f.Repository.AccountId, null);
}));

foreach (var rootStatus in new[] { 403, 404 })
{
    var status = rootStatus;
    tests.Add(($"root {status} purges snapshots and blocks queued writes", async () =>
    {
        using var f = new Fixture(); await f.Login(); await f.Store.SaveSnapshotAsync(TaskPath, new JsonObject { ["secret"] = "cached" });
        await f.Store.EnqueueAsync(Guid.NewGuid().ToString(), "PATCH", TaskPath, new JsonObject { ["title"] = "draft" });
        f.Handler.Route = _ => Task.FromResult(Error(status)); await Reject(() => f.Repository.GetAsync(TaskPath));
        True(await f.Store.IsRevokedAsync(Project)); Equal(await f.Store.ReadSnapshotAsync(TaskPath), null);
        Equal((await f.Store.WritesAsync()).Single().Status, "blocked");
        f.Handler.Route = _ => throw new HttpRequestException("offline"); await Reject(() => f.Repository.GetAsync(TaskPath));
    }));
}

tests.Add(("action denial does not revoke an otherwise accessible project", async () =>
{
    using var f = new Fixture(); await f.Login();
    f.Handler.Route = r => Task.FromResult(r.Path == Root ? Reply(new JsonObject { ["projectId"] = Project }) : Error(403));
    await Reject(() => f.Repository.GetAsync(TaskPath)); True(!await f.Store.IsRevokedAsync(Project));
}));

tests.Add(("revoked write blocks all project intents and clears old snapshots", async () =>
{
    using var f = new Fixture(); await f.Login();
    await f.Store.SaveSnapshotAsync(TaskPath, new JsonObject { ["secret"] = "cached" });
    await f.Store.EnqueueAsync(Guid.NewGuid().ToString(), "PATCH", TaskPath, new JsonObject { ["title"] = "first" });
    await f.Store.EnqueueAsync(Guid.NewGuid().ToString(), "POST", Root + "/comments", new JsonObject { ["text"] = "second" });
    var writes = 0; f.Handler.Route = r => { if (r.Method == "POST") writes++; return Task.FromResult(Error(403)); };
    await f.Repository.SyncAsync(); Equal(writes, 1); True(await f.Store.IsRevokedAsync(Project));
    True((await f.Store.WritesAsync()).All(r => r.Status == "blocked")); Equal(await f.Store.ReadSnapshotAsync(TaskPath), null);
    await f.Repository.SyncAsync(); Equal(writes, 1);
}));

tests.Add(("non-whitelisted AI write is never durably replayed", async () =>
{
    using var f = new Fixture(); await f.Login(); var count = 0;
    f.Handler.Route = _ => { count++; throw new HttpRequestException("offline"); };
    await Reject(() => f.Repository.SendAsync("POST", Root + "/ai/chat", new JsonObject { ["prompt"] = "synthetic" }, true));
    Equal((await f.Store.WritesAsync()).Count, 0); await f.Repository.SyncAsync(); Equal(count, 1);
}));

tests.Add(("409 preserves intent and server conflict without automatic replay", async () =>
{
    using var f = new Fixture(); await f.Login(); var calls = 0;
    f.Handler.Route = r => { if (r.Method == "GET") return Task.FromResult(Reply(new JsonObject { ["revision"] = 3 })); calls++; return Task.FromResult(Error(409)); };
    await Reject(() => f.Repository.SendAsync("PATCH", TaskPath, new JsonObject { ["expectedRevision"] = 1, ["title"] = "mine" }, true));
    var row = (await f.Store.WritesAsync()).Single(); Equal(row.Status, "conflict"); True(row.Body.Contains("mine")); True(row.Server!.Contains("3"));
    await f.Repository.SyncAsync(); Equal(calls, 1);
}));

foreach (var callback in new[] {
    $"https://auth/callback?code={Code}&state={State}",
    $"buwei-native-preview://auth/callback?code={Code}&state={State}",
    $"buwei-windows-native://evil/callback?code={Code}&state={State}",
    $"buwei-windows-native://user@auth/callback?code={Code}&state={State}",
    $"buwei-windows-native://auth/callback/other?code={Code}&state={State}",
    $"buwei-windows-native://auth/callback?code={Code}&state=wrong",
    $"buwei-windows-native://auth/callback?code={Code}&state={State}&state={State}",
    $"buwei-windows-native://auth/callback?code={Code}&state={State}#fragment",
    $"buwei-windows-native://auth/callback?code=short&state={State}",
    $"buwei-windows-native://auth/callback?code={Code}&state={State}&redirect=https%3A%2F%2Fevil.invalid"
})
{
    var target = callback;
    tests.Add(("reject hostile PKCE callback " + target, async () =>
    {
        using var f = new Fixture(); f.Pending(); var exchanges = 0;
        f.Handler.Route = _ => { exchanges++; return Task.FromResult(Reply(new JsonObject { ["user"] = new JsonObject { ["id"] = "account-a" } })); };
        await Reject(() => new NativeAuth(f.Repository, f.Secrets).FinishAsync(new Uri(target))); Equal(exchanges, 0);
    }));
}

tests.Add(("PKCE begin uses Windows S256 and valid finish is single use", async () =>
{
    using var f = new Fixture(); var exchanges = 0; JsonNode? start = null;
    f.Handler.Route = request =>
    {
        if (request.Path == "/api/v1/auth/native/transactions") { start = JsonNode.Parse(request.Body!); return Task.FromResult(Reply(new JsonObject { ["authorizationPath"] = "/app/native-authorize?transaction=synthetic" })); }
        exchanges++; return Task.FromResult(Reply(new JsonObject { ["user"] = new JsonObject { ["id"] = "account-a" } }));
    };
    var auth = new NativeAuth(f.Repository, f.Secrets); var link = await auth.BeginAsync();
    Equal(link.Host, "localhost"); Equal(start?["clientType"]?.GetValue<string>(), "windows");
    var pending = JsonNode.Parse(f.Secrets.Read("pkce")!)!;
    var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(pending["verifier"]!.GetValue<string>()))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    Equal(start?["codeChallenge"]?.GetValue<string>(), challenge);
    var callback = new Uri(ClientPaths.Callback + $"?code={Code}&state=" + pending["state"]!.GetValue<string>());
    await auth.FinishAsync(callback); Equal(exchanges, 1); Equal(f.Secrets.Read("pkce"), null);
    await Reject(() => auth.FinishAsync(callback)); Equal(exchanges, 1);
}));

tests.Add(("expired PKCE is removed without exchanging", async () =>
{
    using var f = new Fixture(); var count = 0;
    f.Secrets.Write("pkce", new JsonObject { ["state"] = State, ["verifier"] = State, ["started"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 301 }.ToJsonString());
    f.Handler.Route = _ => { count++; throw new Exception("Unexpected exchange"); };
    await Reject(() => new NativeAuth(f.Repository, f.Secrets).FinishAsync(new Uri(ClientPaths.Callback + $"?code={Code}&state={State}")));
    Equal(count, 0); Equal(f.Secrets.Read("pkce"), null);
}));

tests.Add(("explicit PKCE denial clears pending login without exchange", async () =>
{
    using var f = new Fixture(); f.Pending(); var count = 0;
    f.Handler.Route = _ => { count++; throw new Exception("Unexpected exchange"); };
    await Reject(() => new NativeAuth(f.Repository, f.Secrets).FinishAsync(new Uri(ClientPaths.Callback + $"?error=access_denied&state={State}")));
    Equal(count, 0); Equal(f.Secrets.Read("pkce"), null);
}));

tests.Add(("ordered draft saves retain final caller value and preserve account ownership", async () =>
{
    using var f = new Fixture(); await f.Login();
    var writes = new List<Task>();
    for (var i = 0; i < 100; i++) writes.Add(f.Store.SaveDraftAsync("typing", new JsonObject { ["text"] = i }));
    f.Store.SetAccount("account-b");
    writes.Add(f.Store.SaveDraftAsync("typing", new JsonObject { ["text"] = "other-account" }));
    await Task.WhenAll(writes);
    Equal((await f.Store.LoadDraftAsync("typing"))?["text"]?.ToString(), "other-account");
    f.Store.SetAccount("account-a"); Equal((await f.Store.LoadDraftAsync("typing"))?["text"]?.GetValue<int>(), 99);
}));
tests.Add(("fresh submission reads never fall back to cached file versions", async () =>
{
    using var f = new Fixture(); await f.Login();
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100", new JsonObject { ["items"] = new JsonArray(new JsonObject { ["versionId"] = "stale" }) });
    f.Handler.Route = _ => throw new HttpRequestException("offline");
    await Reject(() => f.Repository.GetFreshAsync(TaskPath + "/files?limit=100"));
    Equal((await f.Repository.GetAsync(TaskPath + "/files?limit=100"))?["items"]?[0]?["versionId"]?.ToString(), "stale");
}));
var failed = 0;
foreach (var (name, run) in tests)
{
    try { await run().WaitAsync(TimeSpan.FromSeconds(20)); Console.WriteLine("PASS " + name); }
    catch (Exception ex) { failed++; Console.Error.WriteLine("FAIL " + name + "\n" + ex); }
}
Console.WriteLine($"{tests.Count - failed}/{tests.Count} Core regression scenarios passed");
return failed == 0 ? 0 : 1;

static void Equal<T>(T actual, T expected) { if (!EqualityComparer<T>.Default.Equals(actual, expected)) throw new Exception($"Expected {expected}, got {actual}"); }
static void True(bool value) { if (!value) throw new Exception("Assertion failed"); }
static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected operation rejection"); }
static TaskCompletionSource NewSignal() => new(TaskCreationOptions.RunContinuationsAsynchronously);
static async Task Until(Func<Task<bool>> check) { for (var i = 0; i < 200; i++) { if (await check()) return; await Task.Delay(10); } throw new TimeoutException("Fixture condition never reached"); }
static HttpResponseMessage Reply(JsonNode data) => new(HttpStatusCode.OK) { Content = new StringContent(new JsonObject { ["data"] = data }.ToJsonString(), Encoding.UTF8, "application/json") };
static HttpResponseMessage Error(int status) => new((HttpStatusCode)status) { Content = new StringContent(new JsonObject { ["error"] = new JsonObject { ["code"] = "SYNTHETIC", ["message"] = "synthetic failure" } }.ToJsonString(), Encoding.UTF8, "application/json") };

sealed record Request(string Method, string Path, string? Key, string? Body);
sealed class Handler : HttpMessageHandler
{
    public Func<Request, Task<HttpResponseMessage>> Route { get; set; } = _ => throw new InvalidOperationException("Unexpected HTTP request");
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        await Route(new(request.Method.Method, request.RequestUri!.AbsolutePath, request.Headers.TryGetValues("Idempotency-Key", out var keys) ? keys.Single() : null, request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));
}
sealed class Fixture : IDisposable
{
    public string DirectoryPath { get; } = Path.Combine(Path.GetTempPath(), "Buwei-Core-Regression-" + Guid.NewGuid().ToString("N"));
    public Handler Handler { get; } = new();
    public SecretStore Secrets { get; }
    public LocalStore Store { get; }
    public ClientRepository Repository { get; }
    public Fixture() { Secrets = new(Path.Combine(DirectoryPath, "secrets")); Store = new(Path.Combine(DirectoryPath, "data")); Repository = new(Store, Secrets, Handler, new Uri("http://localhost")); }
    public async Task Login(string id = "account-a")
    {
        var user = new JsonObject { ["id"] = id, ["displayName"] = "Synthetic " + id };
        Secrets.Write("session", new JsonObject { ["cookie"] = "buwei_session=synthetic; Path=/", ["user"] = user.DeepClone() }.ToJsonString());
        Handler.Route = _ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(new JsonObject { ["data"] = new JsonObject { ["user"] = user.DeepClone() } }.ToJsonString(), Encoding.UTF8, "application/json") });
        await Repository.RestoreAsync();
    }
    public void Pending() => Secrets.Write("pkce", new JsonObject { ["state"] = new string('s', 43), ["verifier"] = new string('a', 43), ["started"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() }.ToJsonString());
    public void Dispose() { Repository.Dispose(); Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools(); if (Directory.Exists(DirectoryPath)) Directory.Delete(DirectoryPath, true); }
}
