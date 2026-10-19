using System.Net;
using System.Text;
using Buwei.Windows.App.Platform;

static void Reject(Action action)
{
    try { action(); } catch { return; }
    throw new Exception("Expected operation to be rejected.");
}
if (args.Length > 0 && args[0] == "--verify-release")
{
    if (args.Length != 5) throw new ArgumentException("--verify-release installer signature manifest manifest-signature");
    MinisignVerifier.Verify(File.ReadAllBytes(args[1]), File.ReadAllText(args[2]));
    MinisignVerifier.Verify(File.ReadAllBytes(args[3]), File.ReadAllText(args[4]));
    Console.WriteLine("PASS: installer and independent update manifest signatures.");
    return;
}
var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
var fixture = Path.Combine(root, "desktop", "src-tauri", "tests", "fixtures", "update-test.bin");
var signature = File.ReadAllText(fixture + ".sig");
var key = File.ReadAllText(Path.ChangeExtension(fixture, ".pub"));
var bytes = File.ReadAllBytes(fixture);
MinisignVerifier.Verify(bytes, signature, key);
MinisignVerifier.Verify(bytes, signature); // Existing production public key matches the historical signed fixture.
var tampered = (byte[])bytes.Clone(); tampered[0] ^= 1;
Reject(() => MinisignVerifier.Verify(tampered, signature, key));
Reject(() => MinisignVerifier.Verify(bytes, Convert.ToBase64String(Encoding.UTF8.GetBytes("broken")), key));
var gate = new ActivityGate();
using (gate.Enter("录制")) { Reject(gate.RequireIdle); Reject(() => gate.BeginRestart()); }
gate.RequireIdle();
using (gate.BeginRestart()) Reject(() => gate.Enter("上传"));
using (gate.Enter("草稿")) { }
foreach (var path in new[] { "https://example.com/api/v1/", "//example.com/api/v1/", "/api/v1/../admin", "/api/v1/files#secret", "/api/v1/\\evil", "/api/v1/%2e%2e/admin" }) Reject(() => NativeTransfers.RequireApiPath(path));
NativeTransfers.RequireApiPath("/api/v1/projects/123/files");
var temp = Path.Combine(Path.GetTempPath(), "buwei-platform-tests-" + Guid.NewGuid().ToString("N")); Directory.CreateDirectory(temp);
try
{
    var handler = new DownloadHandler();
    using var http = new HttpClient(handler) { BaseAddress = new Uri("https://test.invalid") };
    var transfers = new NativeTransfers(http, temp, gate);
    var destination = Path.Combine(temp, "file.txt");
    await File.WriteAllTextAsync(destination + ".partial", "abc"); await File.WriteAllTextAsync(destination + ".partial.etag", "\"v1\"");
    await transfers.DownloadAsync("/api/v1/files/one", destination);
    if (await File.ReadAllTextAsync(destination) != "abcdef" || !handler.RangeSeen) throw new Exception("Range resume failed.");
    await File.WriteAllTextAsync(destination, "original");
    try { await transfers.DownloadAsync("/api/v1/files/one", destination, new string('0', 64)); throw new Exception("hash check accepted"); }
    catch (System.IO.InvalidDataException) { }
    if (await File.ReadAllTextAsync(destination) != "original") throw new Exception("Bad download replaced destination.");
}
finally { Directory.Delete(temp, true); }
Console.WriteLine("PASS: production fixture, tampering, activity/restart gate, path confinement, range resume and hash failure preservation.");

sealed class DownloadHandler : HttpMessageHandler
{
    public bool RangeSeen { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var range = request.Headers.Range;
        RangeSeen |= range?.Ranges.First().From == 3;
        var response = new HttpResponseMessage(range is null ? HttpStatusCode.OK : HttpStatusCode.PartialContent) { Content = new StringContent(range is null ? "abcdef" : "def") };
        response.Headers.ETag = new("\"v1\"");
        if (range is not null) response.Content.Headers.ContentRange = new(3, 5, 6);
        return Task.FromResult(response);
    }
}
