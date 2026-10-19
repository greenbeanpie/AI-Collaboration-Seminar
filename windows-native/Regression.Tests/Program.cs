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
const string TaskFileId = "88888888-8888-4888-8888-888888888888";
const string TaskMaterialId = "99999999-9999-4999-8999-999999999999";
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
tests.Add(("Bridge pending write is durable before HTTP and lost response cannot replay after reopening", async () =>
{
    using var f = new Fixture(); await f.Login(); var calls = 0; string? requestKey = null;
    var path = "/api/v1/agent-bridges/projects/" + Project + "/tasks/22222222-2222-4222-8222-222222222222/handoffs";
    f.Handler.Route = async request => { calls++; var pending = (await f.Store.PendingBridgeRequestsAsync()).Single(); Equal(pending.Id, request.Key); requestKey = request.Key; throw new HttpRequestException("response lost after dispatch"); };
    var body = new JsonObject { ["expectedRevision"] = 3, ["targetDeviceId"] = "33333333-3333-4333-8333-333333333333" };
    await Reject(() => f.Repository.SendBridgeActionAsync(path, body));
    Equal((await f.Store.PendingBridgeRequestsAsync()).Single().State, "unknown");
    await Reject(() => f.Repository.SendBridgeActionAsync(path, body)); Equal(calls, 1);
    using var reopened = new LocalStore(f.Store.DataDirectory); reopened.SetAccount("account-a");
    Equal((await reopened.PendingBridgeRequestsAsync()).Single().Id, requestKey);
    reopened.SetAccount("account-b"); Equal((await reopened.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge reconciliation only GETs a matching handoff and rejects a different device", async () =>
{
    using var f = new Fixture(); await f.Login();
    var path = "/api/v1/agent-bridges/projects/" + Project + "/tasks/22222222-2222-4222-8222-222222222222/handoffs";
    var body = new JsonObject { ["expectedRevision"] = 3, ["targetDeviceId"] = "33333333-3333-4333-8333-333333333333" };
    f.Handler.Route = _ => throw new HttpRequestException("lost"); await Reject(() => f.Repository.SendBridgeActionAsync(path, body));
    var intent = (await f.Store.PendingBridgeRequestsAsync()).Single(); var gets = 0;
    var proof = new JsonObject { ["projectId"] = Project, ["taskId"] = "22222222-2222-4222-8222-222222222222", ["deviceId"] = "wrong-device", ["taskRevision"] = 3 };
    f.Handler.Route = request => { Equal(request.Method, "GET"); gets++; return Task.FromResult(Reply(proof.DeepClone())); };
    await Reject(() => f.Repository.ReconcileBridgeRequestAsync(intent.Id, "44444444-4444-4444-8444-444444444444"));
    Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 1);
    proof["deviceId"] = body["targetDeviceId"]!.DeepClone();
    await f.Repository.ReconcileBridgeRequestAsync(intent.Id, "44444444-4444-4444-8444-444444444444"); Equal(gets, 2); Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge eligibility and adoption require current version explicit review and matching artifact snapshot", async () =>
{
    var task = new JsonObject { ["taskId"] = "22222222-2222-4222-8222-222222222222", ["revision"] = 3, ["assigneeId"] = "account-a" };
    var eligibility = new JsonObject { ["status"] = "ready", ["taskRevision"] = 3, ["eligible"] = true, ["sourceHash"] = new string('a', 64) };
    True(BridgePolicy.Eligible(eligibility, task)); eligibility["taskRevision"] = 2; True(!BridgePolicy.Eligible(eligibility, task));
    var item = new JsonObject { ["handoffId"] = "44444444-4444-4444-8444-444444444444", ["projectId"] = Project, ["taskId"] = task["taskId"]!.DeepClone(), ["taskRevision"] = 3, ["state"] = "ready_for_review", ["stale"] = false, ["updatedAt"] = "version-one", ["result"] = new JsonObject { ["summary"] = "reviewed", ["artifacts"] = new JsonArray() } };
    var stamp = BridgePolicy.ReviewStamp(item, task);
    Equal(BridgePolicy.Adoption(item, task, "account-a", Project, true, stamp)["expectedTaskRevision"]!.GetValue<int>(), 3);
    await Reject(() => { BridgePolicy.Adoption(item, task, "account-a", Project, false, stamp); return Task.CompletedTask; });
    await Reject(() => { BridgePolicy.Adoption(item, task, "account-b", Project, true, stamp); return Task.CompletedTask; });
    item["result"]!["summary"] = "changed after review";
    await Reject(() => { BridgePolicy.Adoption(item, task, "account-a", Project, true, stamp); return Task.CompletedTask; });
    item["stale"] = true;
    await Reject(() => { BridgePolicy.Adoption(item, task, "account-a", Project, true, BridgePolicy.ReviewStamp(item, task)); return Task.CompletedTask; });
    True(BridgePolicy.Active(new JsonObject { ["state"] = "dispatch_uncertain" }));
}));
tests.Add(("Bridge device must be paired authorized bound and protocol compatible", () =>
{
    var device = new JsonObject { ["paired"] = true, ["revoked"] = false, ["protocolVersion"] = 1, ["projects"] = new JsonArray(new JsonObject { ["projectId"] = Project, ["workspaceLabel"] = "project" }) };
    True(BridgePolicy.Bound(device, Project)); device["revoked"] = true; True(!BridgePolicy.Bound(device, Project)); device["revoked"] = false;
    device["projects"]![0]!["workspaceLabel"] = ""; True(!BridgePolicy.Bound(device, Project));
    return Task.CompletedTask;
}));
tests.Add(("Bridge cancel and adoption reconcile only after server completion evidence", async () =>
{
    using var f = new Fixture(); await f.Login();
    var root = "/api/v1/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444";
    foreach (var action in new[] { "cancel", "adopt-and-submit" })
    {
        f.Handler.Route = _ => throw new HttpRequestException("lost");
        var payload = action == "cancel" ? new JsonObject() : new JsonObject { ["expectedTaskRevision"] = 3, ["reviewed"] = true };
        await Reject(() => f.Repository.SendBridgeActionAsync(root + "/" + action, payload));
        var intent = (await f.Store.PendingBridgeRequestsAsync()).Single();
        var proof = new JsonObject { ["state"] = "running", ["adoptedSubmissionId"] = null };
        f.Handler.Route = request => { Equal(request.Method, "GET"); Equal(request.Path, root); return Task.FromResult(Reply(proof.DeepClone())); };
        await Reject(() => f.Repository.ReconcileBridgeRequestAsync(intent.Id));
        if (action == "cancel") proof["state"] = "cancel_requested";
        else proof["adoptedSubmissionId"] = "55555555-5555-4555-8555-555555555555";
        await f.Repository.ReconcileBridgeRequestAsync(intent.Id); Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
    }
}));
tests.Add(("Bridge eligibility reconciliation requires known state and original task revision", async () =>
{
    using var f = new Fixture(); await f.Login(); var path = Root + "/collaboration/tasks/22222222-2222-4222-8222-222222222222/agent-eligibility";
    f.Handler.Route = _ => throw new HttpRequestException("lost");
    await Reject(() => f.Repository.SendBridgeActionAsync(path, new JsonObject { ["expectedRevision"] = 3 }));
    var intent = (await f.Store.PendingBridgeRequestsAsync()).Single(); var proof = new JsonObject { ["status"] = "missing", ["taskRevision"] = 3 };
    f.Handler.Route = request => { Equal(request.Method, "GET"); return Task.FromResult(Reply(proof.DeepClone())); };
    await Reject(() => f.Repository.ReconcileBridgeRequestAsync(intent.Id));
    proof["status"] = "queued"; proof["taskRevision"] = 2; await Reject(() => f.Repository.ReconcileBridgeRequestAsync(intent.Id));
    proof["taskRevision"] = 3; await f.Repository.ReconcileBridgeRequestAsync(intent.Id); Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge action validation rejects unrelated paths and sensitive fields before persistence or HTTP", async () =>
{
    using var f = new Fixture(); await f.Login(); var calls = 0; f.Handler.Route = _ => { calls++; return Task.FromResult(Reply(new JsonObject())); };
    await Reject(() => f.Repository.SendBridgeActionAsync("/auth/password", new JsonObject { ["password"] = "must-never-persist" }));
    await Reject(() => f.Repository.SendBridgeActionAsync("/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444/cancel", new JsonObject { ["password"] = "must-never-persist" }));
    Equal(calls, 0); Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge response after account switch cannot confirm another account request", async () =>
{
    using var f = new Fixture(); await f.Login(); var entered = NewSignal(); var release = NewSignal();
    f.Handler.Route = async _ => { entered.SetResult(); await release.Task; return Reply(new JsonObject { ["handoffId"] = "44444444-4444-4444-8444-444444444444" }); };
    var sending = f.Repository.SendBridgeActionAsync("/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444/cancel", new JsonObject());
    await entered.Task; await f.Login("account-b"); release.SetResult(); await Reject(() => sending);
    Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
    f.Store.SetAccount("account-a"); Equal((await f.Store.PendingBridgeRequestsAsync()).Single().State, "pending");
}));
tests.Add(("Bridge manual retry requires explicit acknowledgement and preserves original key and payload", async () =>
{
    using var f = new Fixture(); await f.Login(); var requests = new List<Request>();
    f.Handler.Route = request => { requests.Add(request); throw new HttpRequestException("lost"); };
    var path = "/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444/adopt-and-submit";
    await Reject(() => f.Repository.SendBridgeActionAsync(path, new JsonObject { ["expectedTaskRevision"] = 3, ["reviewed"] = true }));
    var intent = (await f.Store.PendingBridgeRequestsAsync()).Single();
    await Reject(() => f.Repository.RetryBridgeRequestExplicitlyAsync(intent.Id, false)); Equal(requests.Count, 1);
    f.Handler.Route = request => { requests.Add(request); return Task.FromResult(Reply(new JsonObject { ["submissionId"] = "55555555-5555-4555-8555-555555555555" })); };
    await f.Repository.RetryBridgeRequestExplicitlyAsync(intent.Id, true);
    Equal(requests.Count, 2); Equal(requests[0].Key, requests[1].Key); Equal(requests[0].Body, requests[1].Body); Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge concurrent manual retries cannot send the same local intent twice", async () =>
{
    using var f = new Fixture(); await f.Login(); var calls = 0; var entered = NewSignal(); var release = NewSignal();
    f.Handler.Route = _ => { calls++; throw new HttpRequestException("lost"); };
    await Reject(() => f.Repository.SendBridgeActionAsync("/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444/cancel", new JsonObject()));
    var id = (await f.Store.PendingBridgeRequestsAsync()).Single().Id;
    f.Handler.Route = async _ => { calls++; entered.SetResult(); await release.Task; return Reply(new JsonObject { ["state"] = "cancelled" }); };
    var retry = f.Repository.RetryBridgeRequestExplicitlyAsync(id, true); await entered.Task;
    await Reject(() => f.Repository.RetryBridgeRequestExplicitlyAsync(id, true)); Equal(calls, 2);
    release.SetResult(); await retry; Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Bridge HTTP throttling remains uncertain while explicit version rejection releases the guard", async () =>
{
    using var f = new Fixture(); await f.Login(); f.Handler.Route = _ => Task.FromResult(Error(429));
    await Reject(() => f.Repository.SendBridgeActionAsync("/agent-bridges/handoffs/44444444-4444-4444-8444-444444444444/cancel", new JsonObject()));
    var intent = (await f.Store.PendingBridgeRequestsAsync()).Single(); Equal(intent.State, "unknown");
    f.Handler.Route = _ => Task.FromResult(Error(409)); await Reject(() => f.Repository.RetryBridgeRequestExplicitlyAsync(intent.Id, true));
    Equal((await f.Store.PendingBridgeRequestsAsync()).Count, 0);
}));
tests.Add(("Prepared fixed source directory and every section continuation open on first offline entry", async () =>
{
    using var f = new Fixture(); await f.Login(); var reads = new List<Request>();
    f.Handler.Route = request => { reads.Add(request); return Task.FromResult(Reply(OfflineFixture.Data(request))); };
    var prepared = await f.Repository.PrepareProjectAsync(Project);
    Equal(prepared.Sections, 2); Equal(prepared.PartialResources, 0); True(prepared.Endpoints >= 18);
    Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "text-ready");
    True(reads.All(x => x.Method == "GET"));
    f.Handler.Route = _ => throw new HttpRequestException("offline");
    Equal((await f.Repository.GetAsync(OfflineFixture.Index + "?offset=0"))?["items"]?[0]?["sectionId"]?.ToString(), OfflineFixture.Section);
    Equal((await f.Repository.GetAsync(OfflineFixture.Index + "?offset=20"))?["items"]?[0]?["sectionId"]?.ToString(), "second");
    Equal((await f.Repository.GetAsync(OfflineFixture.Index + "/section?neighbors=true&offset=6000&sectionId=" + Uri.EscapeDataString(OfflineFixture.Section)))?["fragments"]?[0]?["quote"]?.ToString(), "原文续读");
    True(f.Repository.LastReadOffline);
}));
tests.Add(("Offline preparation reports incomplete index and coverage rather than full readiness", async () =>
{
    using var f = new Fixture(); await f.Login();
    f.Handler.Route = request => { var data = OfflineFixture.Data(request); if (request.Path == OfflineFixture.Index) { data["indexStatus"] = "building"; data["coverage"] = "partial"; } return Task.FromResult(Reply(data)); };
    var prepared = await f.Repository.PrepareProjectAsync(Project); Equal(prepared.PartialResources, 1);
    Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "partial");
}));
tests.Add(("Offline preparation rejects repeated offsets and lifecycle changes without readiness", async () =>
{
    using var f = new Fixture(); await f.Login();
    foreach (var invalid in new[] { "directory", "section", "revision" })
    {
        f.Handler.Route = request =>
        {
            var data = OfflineFixture.Data(request);
            if (invalid == "directory" && request.Path == OfflineFixture.Index) data["nextOffset"] = 0;
            if (invalid == "section" && request.Path == OfflineFixture.Index + "/section") data["nextOffset"] = 0;
            if (invalid == "revision" && request.Path == OfflineFixture.Index && OfflineFixture.Query(request).GetValueOrDefault("offset") == "20") data["revision"] = 2;
            return Task.FromResult(Reply(data));
        };
        await Reject(() => f.Repository.PrepareProjectAsync(Project));
        Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "preparing");
    }
}));
tests.Add(("Wrong-version resource response never overwrites previously valid offline snapshot", async () =>
{
    using var f = new Fixture(); await f.Login(); var path = OfflineFixture.Index + "?offset=0";
    await f.Store.SaveSnapshotAsync(path, new JsonObject { ["versionId"] = OfflineFixture.Version, ["marker"] = "preserve" });
    f.Handler.Route = request => { var data = OfflineFixture.Data(request); if (request.Path == OfflineFixture.Index) data["versionId"] = "88888888-8888-4888-8888-888888888888"; return Task.FromResult(Reply(data)); };
    await Reject(() => f.Repository.PrepareProjectAsync(Project));
    Equal((await f.Store.ReadSnapshotAsync(path))?.Data?["marker"]?.ToString(), "preserve");
}));
tests.Add(("Offline preparation enforces text request page budgets and cancellation without stale ready state", async () =>
{
    using var f = new Fixture(); await f.Login();
    f.Handler.Route = request => Task.FromResult(Reply(OfflineFixture.Data(request)));
    foreach (var limit in new[] { new OfflinePreparationLimits(MaxBytes: 1), new OfflinePreparationLimits(MaxRequests: 3), new OfflinePreparationLimits(MaxPages: 1) })
    {
        await f.Store.SaveSnapshotAsync(Root + "/offline-ready", new JsonObject { ["state"] = "text-ready" });
        await Reject(() => f.Repository.PrepareProjectAsync(Project, limits: limit));
        Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "preparing");
    }
    using var cancellation = new CancellationTokenSource();
    f.Handler.Route = request => { if (request.Path == Root + "/sources") cancellation.Cancel(); return Task.FromResult(Reply(OfflineFixture.Data(request))); };
    await Reject(() => f.Repository.PrepareProjectAsync(Project, cancellation.Token));
    Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "preparing");
}));
tests.Add(("Membership revocation during index preparation removes cached project and blocks local writes", async () =>
{
    using var f = new Fixture(); await f.Login(); await f.Store.EnqueueAsync("offline-revocation", "PATCH", TaskPath, new JsonObject { ["title"] = "local" });
    var revoked = false;
    f.Handler.Route = request =>
    {
        if (request.Path == OfflineFixture.Index) { revoked = true; return Task.FromResult(Error(403)); }
        if (revoked && request.Path == Root) return Task.FromResult(Error(403));
        return Task.FromResult(Reply(OfflineFixture.Data(request)));
    };
    await Reject(() => f.Repository.PrepareProjectAsync(Project)); True(await f.Store.IsRevokedAsync(Project));
    Equal(await f.Store.ReadSnapshotAsync(Root), null); Equal(await f.Store.ReadSnapshotAsync(Root + "/offline-ready"), null);
    Equal((await f.Store.WritesAsync()).Single().Status, "blocked");
}));
tests.Add(("Offline preparation includes fixed historical material versions not only current version", async () =>
{
    using var f = new Fixture(); await f.Login(); const string material = "99999999-9999-4999-8999-999999999999";
    const string older = "88888888-8888-4888-8888-888888888888";
    f.Handler.Route = request =>
    {
        JsonObject data;
        if (request.Path == Root + "/sources") data = new() { ["items"] = new JsonArray(), ["nextCursor"] = null };
        else if (request.Path == Root + "/materials") data = new() { ["items"] = new JsonArray(new JsonObject { ["materialId"] = material, ["currentVersionId"] = OfflineFixture.Version }), ["nextCursor"] = null };
        else if (request.Path == Root + "/materials/" + material) data = new() { ["materialId"] = material, ["currentVersionId"] = OfflineFixture.Version };
        else if (request.Path == Root + "/materials/" + material + "/versions") data = new() { ["items"] = new JsonArray(new JsonObject { ["versionId"] = older }, new JsonObject { ["versionId"] = OfflineFixture.Version }), ["nextCursor"] = null };
        else if (request.Path.StartsWith(Root + "/materials/" + material + "/versions/", StringComparison.Ordinal)) data = new() { ["versionId"] = request.Path.Split('/').Last(), ["markdown"] = "fixed historical text" };
        else if (request.Path.StartsWith(Root + "/resource-index/material/", StringComparison.Ordinal)) data = new() { ["resourceType"] = "material", ["versionId"] = request.Path.Split('/').Last(), ["resourceId"] = material, ["revision"] = 1, ["coverage"] = "ready", ["indexStatus"] = "ready", ["items"] = new JsonArray(), ["nextOffset"] = null };
        else data = OfflineFixture.Data(request);
        return Task.FromResult(Reply(data));
    };
    await f.Repository.PrepareProjectAsync(Project); f.Handler.Route = _ => throw new HttpRequestException("offline");
    Equal((await f.Repository.GetAsync(Root + "/materials/" + material + "/versions/" + older))?["markdown"]?.ToString(), "fixed historical text");
}));
tests.Add(("Known denied fixed resource purges its cached directory and sections but preserves drafts and other versions", async () =>
{
    using var f = new Fixture(); await f.Login();
    await f.Store.SaveSnapshotAsync(OfflineFixture.Index + "?offset=0", new JsonObject { ["text"] = "previous" });
    await f.Store.SaveSnapshotAsync(OfflineFixture.Index + "/section?sectionId=old&offset=0&neighbors=true", new JsonObject { ["text"] = "previous text" });
    var other = OfflineFixture.Index + "8?offset=0"; await f.Store.SaveSnapshotAsync(other, new JsonObject { ["text"] = "other version" });
    await f.Store.SaveDraftAsync("preserved-document", new JsonObject { ["text"] = "my draft" });
    f.Handler.Route = request => Task.FromResult(request.Path == Root ? Reply(new JsonObject { ["projectId"] = Project }) : Error(403));
    await Reject(() => f.Repository.GetFreshAsync(OfflineFixture.Index + "/section?sectionId=old&offset=0&neighbors=true"));
    Equal(await f.Store.ReadSnapshotAsync(OfflineFixture.Index + "?offset=0"), null);
    Equal(await f.Store.ReadSnapshotAsync(OfflineFixture.Index + "/section?sectionId=old&offset=0&neighbors=true"), null);
    Equal((await f.Store.ReadSnapshotAsync(other))?.Data?["text"]?.ToString(), "other version");
    Equal((await f.Store.LoadDraftAsync("preserved-document"))?["text"]?.ToString(), "my draft"); True(!await f.Store.IsRevokedAsync(Project));
}));
tests.Add(("Offline preparation cannot retain stale original text after a fixed index becomes unavailable", async () =>
{
    using var f = new Fixture(); await f.Login();
    var oldPath = OfflineFixture.Index + "/section?sectionId=old&offset=0&neighbors=true";
    await f.Store.SaveSnapshotAsync(oldPath, new JsonObject { ["text"] = "obsolete original" });
    f.Handler.Route = request => Task.FromResult(request.Path == OfflineFixture.Index ? Error(404) : Reply(OfflineFixture.Data(request)));
    var result = await f.Repository.PrepareProjectAsync(Project); Equal(result.PartialResources, 1);
    Equal(await f.Store.ReadSnapshotAsync(oldPath), null); True(!await f.Store.IsRevokedAsync(Project));
    Equal((await f.Store.ReadSnapshotAsync(Root + "/offline-ready"))?.Data?["state"]?.ToString(), "partial");
}));

tests.Add(("Offline submission fixes every cached page and persists without HTTP before explicit sync", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var second = new JsonObject { ["items"] = new JsonArray(SubmissionItem("55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666")), ["nextCursor"] = null };
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100", new JsonObject { ["items"] = new JsonArray(SubmissionItem()), ["nextCursor"] = "next page/中文" });
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100&cursor=" + Uri.EscapeDataString("next page/中文"), second);
    var calls = 0; f.Handler.Route = _ => { calls++; throw new HttpRequestException("offline"); };
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    Equal(review.FileSet.Files.Count, 2); True(review.FileSet.OldestSnapshotAt != null);
    var key = await f.Repository.QueueReviewedSubmissionAsync(review, "成果说明"); Equal(calls, 0);
    var row = (await f.Store.WritesAsync()).Single(); Equal(row.Id, key); Equal(row.Status, "awaiting_confirmation");
    var body = JsonNode.Parse(row.Body)!; Equal(body["expectedRevision"]!.GetValue<int>(), 7); Equal(body["materialVersionIds"]!.AsArray().Count, 2);
    f.Handler.Route = request => { Equal(request.Key, key); Equal(JsonNode.Parse(request.Body!)!["body"]!.ToJsonString(), body.ToJsonString()); throw new HttpRequestException("synthetic lost response"); };
    await f.Repository.SyncAsync(); Equal((await f.Store.WritesAsync()).Single().Status, "awaiting_confirmation");
    await Reject(() => f.Repository.ConfirmQueuedSubmissionAsync(key, false));
    await f.Repository.ConfirmQueuedSubmissionAsync(key, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
    f.Handler.Route = _ => throw new InvalidOperationException("background must not replay uncertain submission");
    await f.Repository.SyncAsync();
    await Reject(() => f.Repository.ResolveAsync(key, body.DeepClone(), false));
    f.Handler.Route = request => { Equal(request.Key, key); return Task.FromResult(Reply(SubmissionSuccess(request))); };
    await f.Repository.ConfirmQueuedSubmissionAsync(key, true); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("Offline submission rejects a missing cached continuation and fresh mode never uses cache", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100", new JsonObject { ["items"] = new JsonArray(SubmissionItem()), ["nextCursor"] = "absent" });
    f.Handler.Route = _ => throw new HttpRequestException("offline");
    await Reject(() => f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7));
    await Reject(() => f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false)); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("Submission pagination rejects duplicate materials and cycling cursors", async () =>
{
    using var f = new Fixture(); await f.Login();
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(SubmissionItem()), ["nextCursor"] = "again" }));
    await Reject(() => f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false));
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(), ["nextCursor"] = "again" }));
    await Reject(() => f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false));
}));

tests.Add(("Submission excludes archived/deleted versions and rejects invalid identity or missing pagination proof", async () =>
{
    using var f = new Fixture(); await f.Login();
    var archived = SubmissionItem(); archived["archivedAt"] = "2026-10-20"; archived["versionId"] = null;
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(archived.DeepClone()), ["nextCursor"] = null }));
    Equal((await f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false)).Files.Count, 0);
    foreach (var field in new[] { "materialId", "versionId", "taskId" })
    {
        var invalid = SubmissionItem(); invalid[field] = "bad";
        f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(invalid.DeepClone()), ["nextCursor"] = null }));
        await Reject(() => f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false));
    }
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray() }));
    await Reject(() => f.Repository.ReadSubmissionFilesAsync(Project, TaskPath.Split('/').Last(), false));
}));

tests.Add(("Offline submission rejects revision drift and changed reviewed file versions", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    await Reject(() => f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 6));
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100", new JsonObject { ["items"] = new JsonArray(SubmissionItem(version: "66666666-6666-4666-8666-666666666666")), ["nextCursor"] = null });
    await Reject(() => f.Repository.QueueReviewedSubmissionAsync(review, "body")); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("Offline submission blocks stale account and revoked membership and cancelled intent", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    using var cancelled = new CancellationTokenSource(); cancelled.Cancel(); await Reject(() => f.Repository.QueueReviewedSubmissionAsync(review, "body", cancelled.Token));
    await f.Store.RevokeAsync(Project); await Reject(() => f.Repository.QueueReviewedSubmissionAsync(review, "body"));
    await f.Login("account-b"); await Reject(() => f.Repository.QueueReviewedSubmissionAsync(review, "body")); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("Offline submission double confirmation creates one durable intent and never bypasses conflicts", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    var attempts = new[] { f.Repository.QueueReviewedSubmissionAsync(review, "first"), f.Repository.QueueReviewedSubmissionAsync(review, "second") };
    try { await Task.WhenAll(attempts); } catch (InvalidOperationException) { }
    Equal(attempts.Count(x => x.IsCompletedSuccessfully), 1); var row = (await f.Store.WritesAsync()).Single();
    await f.Store.MarkWriteAsync(row.Id, "conflict", "synthetic");
    await Reject(() => f.Repository.QueueReviewedSubmissionAsync(review, "third")); Equal((await f.Store.WritesAsync()).Count, 1);
}));

tests.Add(("Submission process interruption and error responses require original-key manual recovery", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    var id = await f.Repository.QueueReviewedSubmissionAsync(review, "body");
    foreach (var status in new[] { 408, 429, 500, 503 })
    {
        f.Handler.Route = _ => Task.FromResult(Error(status));
        await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
        f.Handler.Route = _ => throw new InvalidOperationException("unexpected automatic retry"); await f.Repository.SyncAsync();
    }
    await f.Store.MarkWriteAsync(id, "sending");
    f.Handler.Route = _ => throw new InvalidOperationException("interrupted send must not automatically restart"); await f.Repository.SyncAsync();
    f.Handler.Route = request => { if (request.Method == "GET") return Task.FromResult(Reply(new JsonObject { ["revision"] = 8 })); Equal(request.Key, id); return Task.FromResult(Error(409)); };
    await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "conflict");
}));

tests.Add(("Submission invalid response and in-progress idempotency remain uncertain without background replay", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    var id = await f.Repository.QueueReviewedSubmissionAsync(review, "body");
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject()));
    await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
    f.Handler.Route = _ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("invalid json") });
    await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
    f.Handler.Route = _ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.Conflict) { Content = new StringContent("{\"error\":{\"code\":\"INVALID_STATE\",\"message\":\"idempotency still processing\"}}", Encoding.UTF8, "application/json") });
    await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
    f.Handler.Route = _ => throw new OperationCanceledException("synthetic send interruption");
    await f.Repository.ConfirmQueuedSubmissionAsync(id, true); Equal((await f.Store.WritesAsync()).Single().Status, "uncertain");
}));

tests.Add(("Discard cannot remove an in-flight submission before its original result is recorded", async () =>
{
    using var f = new Fixture(); await f.Login(); await SubmissionCache(f);
    var review = await f.Repository.ReviewCachedSubmissionAsync(Project, TaskPath.Split('/').Last(), 7);
    var id = await f.Repository.QueueReviewedSubmissionAsync(review, "body"); var entered = NewSignal(); var release = NewSignal();
    f.Handler.Route = async request => { Equal(request.Key, id); entered.SetResult(); await release.Task; return Reply(SubmissionSuccess(request)); };
    var sending = f.Repository.ConfirmQueuedSubmissionAsync(id, true); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    Equal((await f.Store.WritesAsync()).Single().Status, "sending");
    var discard = f.Repository.ResolveAsync(id, null, true); True(!discard.IsCompleted);
    release.SetResult(); await sending; await Reject(() => discard); Equal((await f.Store.WritesAsync()).Count, 0);
}));

tests.Add(("Task file registration persists immutable upload identity without sending HTTP", async () =>
{
    using var f = new Fixture(); await f.Login(); var calls = 0; f.Handler.Route = _ => { calls++; throw new Exception("unexpected HTTP"); };
    var owned = Path.Combine(f.Store.DataDirectory, "accounts", ClientPaths.SafeSegment("account-a"), "files", "owned.docx");
    var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, "正文", recovery: new(owned, new string('a', 64)));
    var row = (await f.Store.TaskFileRequestsAsync()).Single(); Equal(row.Id, id); Equal(row.State, "waiting_upload"); Equal(row.Path, TaskPath + "/files");
    Equal(JsonNode.Parse(row.Body)!["fileId"]!.ToString(), TaskFileId); Equal(JsonNode.Parse(row.Recovery!)!["sourcePath"]!.ToString(), Path.GetFullPath(owned));
    Equal(calls, 0); Equal((await f.Store.WritesAsync()).Count, 0);
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), "88888888-8888-4888-8888-888888888888", null));
}));

tests.Add(("Task file POST and PUT use exact DTO and material revision rather than task revision", async () =>
{
    using var f = new Fixture(); await f.Login();
    var create = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, "正文");
    f.Handler.Route = request => { Equal(request.Method, "POST"); Equal(request.Key, create); Equal(request.Path, TaskPath + "/files"); Equal(JsonNode.Parse(request.Body!)!.AsObject().Count, 2); return Task.FromResult(Reply(TaskFileProof())); };
    await f.Repository.TransmitTaskFileRegistrationAsync(create, true); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
    var replace = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last(), TaskMaterialId, 5), TaskFileId, null);
    f.Handler.Route = request => { Equal(request.Method, "PUT"); Equal(request.Path, TaskPath + "/files/" + TaskMaterialId); Equal(JsonNode.Parse(request.Body!)!["expectedRevision"]!.GetValue<int>(), 5); return Task.FromResult(Reply(TaskFileProof(6))); };
    await f.Repository.TransmitTaskFileRegistrationAsync(replace, true); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
}));

tests.Add(("Task file lost response pauses automatic retry and GET-only reconciliation finds continuation", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null);
    f.Handler.Route = _ => throw new HttpRequestException("synthetic committed response lost"); await Reject(() => f.Repository.TransmitTaskFileRegistrationAsync(id, true));
    Equal((await f.Store.TaskFileRequestsAsync()).Single().State, "unknown");
    f.Handler.Route = _ => throw new Exception("background may not replay file registration"); await f.Repository.SyncAsync();
    var pages = 0; f.Handler.Route = request => { Equal(request.Method, "GET"); Equal(request.Path, TaskPath + "/files"); pages++; return Task.FromResult(Reply(request.Query.Contains("cursor=") ? new JsonObject { ["items"] = new JsonArray(TaskFileProof()), ["nextCursor"] = null } : new JsonObject { ["items"] = new JsonArray(), ["nextCursor"] = "next" })); };
    await f.Repository.ReconcileTaskFileRegistrationAsync(id); Equal(pages, 2); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
}));

tests.Add(("Task file explicit retries retain original key file ID body and require charge acknowledgement", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, "fixed body");
    await Reject(() => f.Repository.TransmitTaskFileRegistrationAsync(id, false));
    var bodies = new List<string>(); var files = new HashSet<string>();
    f.Handler.Route = request => { Equal(request.Key, id); bodies.Add(request.Body!); var file = JsonNode.Parse(request.Body!)!["fileId"]!.ToString(); if (files.Add(file)) throw new HttpRequestException("response lost after natural file mapping"); return Task.FromResult(Reply(TaskFileProof())); };
    await Reject(() => f.Repository.TransmitTaskFileRegistrationAsync(id, true)); await f.Repository.TransmitTaskFileRegistrationAsync(id, true);
    Equal(files.Count, 1); Equal(bodies[0], bodies[1]);
}));

tests.Add(("Task file late response after account switch remains with original account", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null);
    var entered = NewSignal(); var release = NewSignal(); f.Handler.Route = async _ => { entered.SetResult(); await release.Task; return Reply(TaskFileProof()); };
    var sending = f.Repository.TransmitTaskFileRegistrationAsync(id, true); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await f.Login("account-b"); release.SetResult(); await Reject(() => sending); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
    await f.Login(); Equal((await f.Store.TaskFileRequestsAsync()).Single().State, "sending");
}));

tests.Add(("Task file validates identity strict fields text limits owned recovery and revocation before persistence", async () =>
{
    using var f = new Fixture(); await f.Login();
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, "bad"), TaskFileId, null));
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last(), TaskMaterialId), TaskFileId, null));
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last(), null, 7), TaskFileId, null));
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, new string('a', 60001)));
    await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null, recovery: new(Path.Combine(f.DirectoryPath,"outside.docx"), new string('a',64))));
    await f.Store.RevokeAsync(Project); await Reject(() => f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null)); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
}));

tests.Add(("Task file send prevents simultaneous retry and abandonment", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null);
    var entered = NewSignal(); var release = NewSignal(); f.Handler.Route = async _ => { entered.SetResult(); await release.Task; return Reply(TaskFileProof()); };
    var sending = f.Repository.TransmitTaskFileRegistrationAsync(id, true); await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    await Reject(() => f.Repository.TransmitTaskFileRegistrationAsync(id, true)); await Reject(() => f.Repository.AbandonTaskFileRegistrationAsync(id, true));
    release.SetResult(); await sending; Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
}));

tests.Add(("Task file recovery reads exact original file state and avoids uploading an available file again", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last()), TaskFileId, null);
    foreach (var state in new[] { "pending", "available" })
    {
        f.Handler.Route = request => { Equal(request.Method, "GET"); Equal(request.Path, Root + "/files"); True(request.Query.Contains("fileId=" + TaskFileId)); return Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(new JsonObject { ["fileId"] = TaskFileId, ["status"] = state }), ["nextCursor"] = null })); };
        Equal(await f.Repository.TaskFileNeedsUploadAsync(id), state == "pending");
    }
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(), ["nextCursor"] = null })); await Reject(() => f.Repository.TaskFileNeedsUploadAsync(id));
}));

tests.Add(("Task file wrong completion proof cannot clear intent and manual stop preserves historical record", async () =>
{
    using var f = new Fixture(); await f.Login(); var id = await f.Repository.PrepareTaskFileRegistrationAsync(new(Project, TaskPath.Split('/').Last(), TaskMaterialId, 5), TaskFileId, null);
    f.Handler.Route = _ => Task.FromResult(Reply(TaskFileProof(5))); await Reject(() => f.Repository.TransmitTaskFileRegistrationAsync(id, true));
    Equal((await f.Store.TaskFileRequestsAsync()).Single().State, "unknown");
    f.Handler.Route = _ => Task.FromResult(Reply(new JsonObject { ["items"] = new JsonArray(), ["nextCursor"] = null })); await Reject(() => f.Repository.ReconcileTaskFileRegistrationAsync(id));
    await Reject(() => f.Repository.AbandonTaskFileRegistrationAsync(id, false)); await f.Repository.AbandonTaskFileRegistrationAsync(id, true); Equal((await f.Store.TaskFileRequestsAsync()).Count, 0);
}));

tests.Add(("Task file bounded text includes explicit truncation notice and preserves surrogate boundaries", () =>
{
    const string note = "\n\n（正文超限，仅登记开头部分；完整内容保留在原文件）";
    var boundary = ClientRepository.MaxTaskFileTextCharacters - note.Length;
    var text = new string('中', boundary - 1) + "😀" + new string('文', 100);
    var bounded = ClientRepository.BoundTaskFileText(text);
    True(bounded.Length <= 60000); True(bounded.EndsWith(note)); True(!char.IsSurrogate(bounded[boundary - 2]));
    Equal(ClientRepository.BoundTaskFileText("保持全文😀"), "保持全文😀");
    return Task.CompletedTask;
}));

tests.Add(("Account replacement cancels old transfer lifetime and gives new account an independent lifetime", async () =>
{
    using var f = new Fixture(); await f.Login(); var original = f.Repository.AccountCancellation;
    True(!original.IsCancellationRequested); await f.Login("account-b"); True(original.IsCancellationRequested); True(!f.Repository.AccountCancellation.IsCancellationRequested);
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

static JsonObject TaskFileProof(int revision = 1) => new() { ["taskId"] = TaskPath.Split('/').Last(), ["fileId"] = TaskFileId, ["materialId"] = TaskMaterialId, ["versionId"] = "77777777-7777-4777-8777-777777777777", ["revision"] = revision };
static JsonObject SubmissionSuccess(Request request)
{
    var sent = JsonNode.Parse(request.Body!)!["body"]!.DeepClone().AsObject();
    sent.Remove("expectedRevision"); sent["submissionId"] = "77777777-7777-4777-8777-777777777777";
    sent["taskId"] = TaskPath.Split('/').Last(); sent["submittedBy"] = "account-a"; return sent;
}
static JsonObject SubmissionItem(string material = "33333333-3333-4333-8333-333333333333", string version = "44444444-4444-4444-8444-444444444444") => new() { ["materialId"] = material, ["versionId"] = version, ["taskId"] = TaskPath.Split('/').Last(), ["name"] = "成果.docx", ["archivedAt"] = null, ["materialArchivedAt"] = null, ["deletedAt"] = null };
static async Task SubmissionCache(Fixture f)
{
    await f.Store.SaveSnapshotAsync(TaskPath, new JsonObject { ["taskId"] = TaskPath.Split('/').Last(), ["revision"] = 7, ["assigneeId"] = "account-a", ["lifecycleState"] = "in_progress" });
    await f.Store.SaveSnapshotAsync(TaskPath + "/files?limit=100", new JsonObject { ["items"] = new JsonArray(SubmissionItem()), ["nextCursor"] = null });
}

sealed record Request(string Method, string Path, string? Key, string? Body, string Query = "");
sealed class Handler : HttpMessageHandler
{
    public Func<Request, Task<HttpResponseMessage>> Route { get; set; } = _ => throw new InvalidOperationException("Unexpected HTTP request");
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        await Route(new(request.Method.Method, request.RequestUri!.AbsolutePath, request.Headers.TryGetValues("Idempotency-Key", out var keys) ? keys.Single() : null, request.Content == null ? null : await request.Content.ReadAsStringAsync(cancellationToken), request.RequestUri.Query));
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
