using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;

var results = new List<string>();
void Check(bool condition, string name) { if (!condition) throw new Exception(name); results.Add(name); }
Check(ClientPaths.Normalize("/projects") == "/api/v1/projects", "API prefix");
foreach (var path in new[] { "https://evil.test", "//evil.test/a", "/../x", "/projects#x", "/projects\\x" })
{
    var rejected = false; try { ClientPaths.Normalize(path); } catch (ArgumentException) { rejected = true; }
    Check(rejected, "Reject path " + path);
}
Check(ClientPaths.Writable("PUT", "/api/v1/projects/p/materials/m"), "Offline material permitted");
Check(!ClientPaths.Writable("POST", "/api/v1/projects/p/ai/messages"), "AI cannot queue");
Check(!ClientPaths.Writable("POST", "/api/v1/projects/p/tasks?t=x"), "Query write cannot queue");
Check(!ClientPaths.Cacheable("/api/v1/projects/p/files/f/content"), "Binary cannot snapshot");
var directory = Path.Combine(Path.GetTempPath(), "buwei-winui-tests-" + Guid.NewGuid().ToString("N"));
using var store = new LocalStore(directory);
store.SetAccount("account-a");
await store.SaveSnapshotAsync("/api/v1/projects/p", new JsonObject { ["title"] = "A" });
await store.SaveDraftAsync("material-m", new JsonObject { ["text"] = "草稿" });
await store.EnqueueAsync("same-key", "PATCH", "/api/v1/projects/p/tasks/t", new JsonObject { ["expectedRevision"] = 3, ["title"] = "修改" });
await store.EnqueueAsync("same-key", "PATCH", "/api/v1/projects/p/tasks/t", new JsonObject());
Check((await store.WritesAsync()).Count == 1, "Durable idempotency key deduplicates");
store.SetAccount("account-b");
Check(await store.ReadSnapshotAsync("/api/v1/projects/p") == null && await store.LoadDraftAsync("material-m") == null && (await store.WritesAsync()).Count == 0, "Account isolation");
store.SetAccount("account-a");
Check((await store.LoadDraftAsync("material-m"))?["text"]?.GetValue<string>() == "草稿", "Draft survives account switch");
await store.MarkWriteAsync("same-key", "conflict", "版本变化", new JsonObject { ["revision"] = 4 });
var conflict = (await store.WritesAsync()).Single();
Check(JsonNode.Parse(conflict.Body)?["title"]?.GetValue<string>() == "修改" && JsonNode.Parse(conflict.Server!)?["revision"]?.GetValue<int>() == 4, "Conflict retains local and server versions");
await store.RevokeAsync("p");
Check(await store.ReadSnapshotAsync("/api/v1/projects/p") == null && (await store.WritesAsync()).Single().Status == "blocked", "Revocation removes snapshots and preserves blocked write");
var denied = false; try { await store.EnqueueAsync("new", "POST", "/api/v1/projects/p/tasks", new JsonObject()); } catch (InvalidOperationException) { denied = true; }
Check(denied, "Revocation prevents enqueue");
await store.RestoreAccessAsync("p");
Check(!await store.IsRevokedAsync("p"), "Successful project access restores permission marker");
if (OperatingSystem.IsWindows())
{
    var secrets = new SecretStore(Path.Combine(directory, "secrets"));
    secrets.Write("session", "private-cookie");
    Check(secrets.Read("session") == "private-cookie" && !Encoding.UTF8.GetString(File.ReadAllBytes(Directory.GetFiles(secrets.DirectoryPath).Single())).Contains("private-cookie"), "DPAPI encrypted persistence");
    secrets.Write("session", null); Check(secrets.Read("session") == null, "Logout removes secret");
    using var repository = new ClientRepository(store, secrets, new FixtureHandler());
    Check((await repository.GetAsync("/capabilities"))?["ok"]?.GetValue<bool>() == true, "HTTP envelope contract");
}
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed = results.Count, tests = results }));

sealed class FixtureHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"data\":{\"ok\":true}}", Encoding.UTF8, "application/json") });
}
