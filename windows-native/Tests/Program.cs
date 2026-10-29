using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;

var results = new List<string>();
void Check(bool condition, string name) { if (!condition) throw new Exception(name); results.Add(name); }
Check(ClientPaths.Normalize("/projects") == "/api/v1/projects", "API prefix");
Check(ClientPaths.Normalize("/projects?q=%23note%20..") == "/api/v1/projects?q=%23note%20..", "Encoded search content is not interpreted as a path");
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
await store.EnqueueAsync("local-task", "POST", "/api/v1/projects/p/tasks", new JsonObject { ["title"] = "新任务" });
await store.EnqueueAsync("dependent", "PATCH", "/api/v1/projects/p/tasks/local-task", new JsonObject { ["dependsOnTaskIds"] = new JsonArray("local-task") });
var created = (await store.WritesAsync()).Single(x => x.Id == "local-task");
await store.ConfirmWriteAsync(created, new JsonObject { ["taskId"] = "server-task", ["title"] = "新任务", ["revision"] = 1 });
var dependent = (await store.WritesAsync()).Single(x => x.Id == "dependent");
Check(dependent.Path.EndsWith("/server-task") && JsonNode.Parse(dependent.Body)?["dependsOnTaskIds"]?[0]?.ToString() == "server-task", "Create confirmation atomically remaps dependent task identities");
await store.SaveSnapshotAsync("/api/v1/projects/p/tasks?limit=50&q=", new JsonObject { ["items"] = new JsonArray(new JsonObject { ["taskId"] = "server-task", ["title"] = "旧标题" }) });
await store.ConfirmWriteAsync(dependent, new JsonObject { ["taskId"] = "server-task", ["title"] = "服务端已提交", ["revision"] = 2 });
Check((await store.ReadSnapshotAsync("/api/v1/projects/p/tasks?q=&limit=50"))?.Data?["items"]?[0]?["title"]?.ToString() == "服务端已提交", "Acknowledged server result refreshes cached list independent of query order");
if (OperatingSystem.IsWindows())
{
    var secrets = new SecretStore(Path.Combine(directory, "secrets"));
    secrets.Write("session", "private-cookie");
    Check(secrets.Read("session") == "private-cookie" && !Encoding.UTF8.GetString(File.ReadAllBytes(Directory.GetFiles(secrets.DirectoryPath).Single())).Contains("private-cookie"), "DPAPI encrypted persistence");
    secrets.Write("session", null); Check(secrets.Read("session") == null, "Logout removes secret");
    using var repository = new ClientRepository(store, secrets, new FixtureHandler());
    Check((await repository.GetAsync("/capabilities"))?["ok"]?.GetValue<bool>() == true, "HTTP envelope contract");
}
var originalProposal = new JsonObject { ["taskId"] = "child", ["title"] = "Keep this" };
var removedParent = TaskProposalParent.Apply(originalProposal, "parentTaskId", "parent", "");
Check(removedParent.ContainsKey("parentTaskId") && removedParent["parentTaskId"] == null, "Clear inherited proposal parent explicitly writes null");
Check(!originalProposal.ContainsKey("parentTaskId"), "Parent edits preserve proposal baseline after failed requests");
Check(!TaskProposalParent.Apply(originalProposal, "parentTaskId", "parent", "parent").ContainsKey("parentTaskId"), "Unchanged inherited parent retains omission");
Check(TaskProposalParent.Apply(originalProposal, "parentTaskId", "parent", "another")["parentTaskId"]?.ToString() == "another", "Changed proposal parent is explicit");
Check(TaskProposalParent.Apply(removedParent, "parentTaskId", "", "").ContainsKey("parentTaskId"), "Explicit null proposal parent remains null");
await AppearanceChecks.RunAsync(Check);
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed = results.Count, tests = results }));

sealed class FixtureHandler : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"data\":{\"ok\":true}}", Encoding.UTF8, "application/json") });
}
