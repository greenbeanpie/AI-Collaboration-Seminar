using System.Net;
using System.Text;
using Buwei.Windows.Platform;

static void Reject(Action action)
{
    try { action(); } catch { return; }
    throw new Exception("Expected operation to be rejected.");
}
if (args.Length > 0 && args[0] == "--verify-release")
{
    if (args.Length != 5) throw new ArgumentException("--verify-release installer signature manifest manifest-signature");
    MinisignVerifier.VerifyFile(args[1], File.ReadAllText(args[2]));
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
MinisignVerifier.VerifyFile(fixture, signature, key);
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
    // Ephemeral test key only; production key and release signing material are untouched.
    using var pair = Sodium.PublicKeyAuth.GenerateKeyPair();
    var keyPacket = new byte[42]; keyPacket[0] = (byte)'E'; keyPacket[1] = (byte)'d'; pair.PublicKey.CopyTo(keyPacket, 10);
    var prehash = Sodium.GenericHash.Hash(bytes, null, 64);
    var detached = Sodium.PublicKeyAuth.SignDetached(prehash, pair.PrivateKey);
    var sigPacket = new byte[74]; sigPacket[0] = (byte)'E'; sigPacket[1] = (byte)'D'; detached.CopyTo(sigPacket, 10);
    var comment = Encoding.UTF8.GetBytes("test-only"); var globalInput = detached.Concat(comment).ToArray();
    var globalSignature = Sodium.PublicKeyAuth.SignDetached(globalInput, pair.PrivateKey);
    var testKey = Convert.ToBase64String(Encoding.UTF8.GetBytes("untrusted comment: test\n" + Convert.ToBase64String(keyPacket) + "\n"));
    var testSignature = Convert.ToBase64String(Encoding.UTF8.GetBytes("untrusted comment: test\n" + Convert.ToBase64String(sigPacket) + "\ntrusted comment: test-only\n" + Convert.ToBase64String(globalSignature) + "\n"));
    MinisignVerifier.Verify(bytes, testSignature, testKey);
    MinisignVerifier.VerifyFile(fixture, testSignature, testKey);
    Reject(() => MinisignVerifier.Verify(tampered, testSignature, testKey));
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
    var uploadHandler = new UploadHandler();
    using var uploadHttp = new HttpClient(uploadHandler) { BaseAddress = new Uri("https://test.invalid") };
    var upload = new NativeTransfers(uploadHttp, temp, gate);
    var source = Path.Combine(temp, "upload.txt"); await File.WriteAllTextAsync(source, "abcdef");
    await upload.UploadAsync(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), source);
    if (uploadHandler.UploadedParts != 1 || !uploadHandler.Completed) throw new Exception("Multipart resume did not skip the persisted server part.");
    var uncertainHandler = new UploadHandler { FailCompletionOnce = true };
    using var uncertainHttp = new HttpClient(uncertainHandler) { BaseAddress = new Uri("https://test.invalid") };
    var uncertainUpload = new NativeTransfers(uncertainHttp, temp, gate);
    var uncertainProject = Guid.NewGuid().ToString(); var uncertainFile = Guid.NewGuid().ToString();
    try { await uncertainUpload.UploadAsync(uncertainProject, uncertainFile, source); throw new Exception("Expected simulated response loss."); }
    catch (HttpRequestException) { }
    await uncertainUpload.UploadAsync(uncertainProject, uncertainFile, source);
    if (uncertainHandler.Begins != 1 || uncertainHandler.UploadedParts != 1) throw new Exception("Lost completion response replayed upload instead of reconciling durable session.");
    using var accountStop = new CancellationTokenSource(); var cancelledHandler = new CancelTransferHandler(accountStop);
    using var cancelledHttp = new HttpClient(cancelledHandler) { BaseAddress = new Uri("https://test.invalid") };
    var cancelledTransfer = new NativeTransfers(cancelledHttp, temp, gate, accountStop.Token);
    try { await cancelledTransfer.UploadAsync(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), source); throw new Exception("Expected account cancellation."); } catch (OperationCanceledException) { }
    try { await cancelledTransfer.UploadAsync(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), source); throw new Exception("Expected old transfer lifetime rejection."); } catch (OperationCanceledException) { }
    try { await cancelledTransfer.DownloadAsync("/api/v1/files/a/content", Path.Combine(temp, "cancelled-download")); throw new Exception("Expected old download lifetime rejection."); } catch (OperationCanceledException) { }
    if (cancelledHandler.Calls != 1 || File.Exists(Path.Combine(temp, "cancelled-download"))) throw new Exception("Cancelled account issued later transfer requests or wrote a final file.");

}
finally { Directory.Delete(temp, true); }
Console.WriteLine("PASS: production fixture, tampering, activity/restart gate, path confinement, range resume, hash failure preservation multipart resume and account cancellation.");

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

sealed class UploadHandler : HttpMessageHandler
{
    private readonly string session = Guid.NewGuid().ToString();
    public int UploadedParts { get; private set; }
    public bool Completed { get; private set; }
    public bool FailCompletionOnce { get; init; }
    public int Begins { get; private set; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri!.AbsolutePath;
        string payload;
        if (request.Method == HttpMethod.Post && path.EndsWith("/uploads")) { Begins++; payload = $"{{\"sessionId\":\"{session}\",\"partBytes\":3}}"; }
        else if (request.Method == HttpMethod.Get) payload = Completed ? "{\"status\":\"complete\"}" : "{\"status\":\"uploading\",\"partBytes\":3,\"parts\":[{\"partNumber\":1,\"sizeBytes\":3}]}";
        else if (request.Method == HttpMethod.Put)
        {
            if (!path.EndsWith("/parts/2") || request.Headers.GetValues("X-Part-Size").Single() != "3" || await request.Content!.ReadAsStringAsync(cancellationToken) != "def") throw new Exception("Bad multipart chunk.");
            UploadedParts++; payload = "{}";
        }
        else if (path.EndsWith("/complete")) { Completed = true; if (FailCompletionOnce) throw new HttpRequestException("Simulated response loss after server commit."); payload = "{}"; }
        else throw new Exception("Unexpected upload request.");
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent("{\"data\":" + payload + "}", Encoding.UTF8, "application/json") };
    }
}

sealed class CancelTransferHandler(CancellationTokenSource accountStop) : HttpMessageHandler
{
    public int Calls { get; private set; }
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Calls++; accountStop.Cancel(); cancellationToken.ThrowIfCancellationRequested(); throw new Exception("Cancellation not propagated.");
    }
}
