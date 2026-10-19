using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Buwei.Windows.App.Platform;

public sealed class NativeTransfers(HttpClient http, string accountDirectory, ActivityGate activity)
{
    public async Task UploadAsync(string projectId, string fileId, string sourcePath, IProgress<double>? progress = null, CancellationToken ct = default)
    {
        // File ID must first be allocated with the ordinary file-init endpoint by the business layer.
        var project = Guid.Parse(projectId); var file = Guid.Parse(fileId);
        using var busy = activity.Enter("文件上传");
        await using var source = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true);
        if (source.Length == 0) throw new InvalidOperationException("不能上传空文件。");
        var digest = Convert.ToHexString(await SHA256.HashDataAsync(source, ct)); source.Position = 0;
        Directory.CreateDirectory(accountDirectory);
        var journal = Path.Combine(accountDirectory, $"upload-{project}-{file}.json");
        if (File.Exists(journal))
        {
            var old = JsonNode.Parse(await File.ReadAllTextAsync(journal, ct));
            if (old?["sha256"]?.GetValue<string>() != digest) throw new InvalidOperationException("源文件已变化，请创建新的文件上传，不得覆盖原上传会话。");
        }
        var basis = $"/api/v1/projects/{project}/files/{file}/uploads";
        var init = await JsonAsync(HttpMethod.Post, basis, new JsonObject { ["sizeBytes"] = source.Length }, ct);
        var sessionId = Guid.Parse(init["sessionId"]!.GetValue<string>());
        var partBytes = init["partBytes"]!.GetValue<int>();
        if (partBytes < 1 || partBytes > 100_000_000) throw new InvalidDataException("服务器分片大小无效。");
        var session = $"{basis}/{sessionId}";
        var state = await JsonAsync(HttpMethod.Get, session, null, ct);
        if (state["status"]?.GetValue<string>() == "complete") { if (File.Exists(journal)) File.Delete(journal); return; }
        if (state["status"]?.GetValue<string>() != "uploading") throw new InvalidOperationException("上传正在完成或取消，请稍后重新读取状态。");
        await AtomicWriteAsync(journal, new JsonObject { ["projectId"] = project.ToString(), ["fileId"] = file.ToString(), ["sourcePath"] = Path.GetFullPath(sourcePath), ["sha256"] = digest, ["sessionId"] = sessionId.ToString() }.ToJsonString(), ct);
        var parts = state["parts"]?.AsArray() ?? [];
        for (long offset = 0, number = 1; offset < source.Length; offset += partBytes, number++)
        {
            ct.ThrowIfCancellationRequested();
            var count = (int)Math.Min(partBytes, source.Length - offset);
            if (parts.Any(p => p?["partNumber"]?.GetValue<int>() == number && p?["sizeBytes"]?.GetValue<long>() == count))
            { progress?.Report((double)(offset + count) / source.Length); continue; }
            source.Position = offset;
            using var request = new HttpRequestMessage(HttpMethod.Put, $"{session}/parts/{number}");
            request.Headers.Add("X-Part-Size", count.ToString(System.Globalization.CultureInfo.InvariantCulture));
            request.Content = new StreamContent(new SegmentStream(source, count));
            request.Content.Headers.ContentLength = count;
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();
            progress?.Report((double)(offset + count) / source.Length);
        }
        await JsonAsync(HttpMethod.Post, session + "/complete", null, ct);
        File.Delete(journal);
    }
    public async Task DownloadAsync(string apiPath, string destination, string? expectedSha256 = null, CancellationToken ct = default)
    {
        RequireApiPath(apiPath);
        using var busy = activity.Enter("文件下载");
        var temporary = destination + ".partial"; var metadata = temporary + ".etag";
        var offset = File.Exists(temporary) && File.Exists(metadata) ? new FileInfo(temporary).Length : 0;
        using var request = new HttpRequestMessage(HttpMethod.Get, apiPath);
        if (offset > 0)
        {
            request.Headers.Range = new RangeHeaderValue(offset, null);
            request.Headers.TryAddWithoutValidation("If-Range", await File.ReadAllTextAsync(metadata, ct));
        }
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        var append = response.StatusCode == HttpStatusCode.PartialContent && offset > 0;
        if (response.StatusCode == HttpStatusCode.PartialContent && (!append || response.Content.Headers.ContentRange?.From != offset))
            throw new InvalidDataException("下载范围不匹配，保留原文件供重试。");
        var etag = response.Headers.ETag;
        if (etag is { IsWeak: false }) await AtomicWriteAsync(metadata, etag.ToString(), ct);
        else if (File.Exists(metadata)) File.Delete(metadata);
        await using (var output = new FileStream(temporary, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
        {
            await using var input = await response.Content.ReadAsStreamAsync(ct);
            await input.CopyToAsync(output, ct);
            await output.FlushAsync(ct);
        }
        if (expectedSha256 is not null)
        {
            await using var downloaded = File.OpenRead(temporary);
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(downloaded, ct));
            if (!actual.Equals(expectedSha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("下载校验失败，原文件未替换。");
        }
        File.Move(temporary, destination, true);
        if (File.Exists(metadata)) File.Delete(metadata);
    }
    private async Task<JsonObject> JsonAsync(HttpMethod method, string path, JsonObject? body, CancellationToken ct)
    {
        RequireApiPath(path);
        using var request = new HttpRequestMessage(method, path);
        if (body is not null) request.Content = new StringContent(body.ToJsonString(), System.Text.Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, ct); response.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct));
        return (json?["data"] ?? json)?.AsObject() ?? throw new InvalidDataException("服务器响应为空。");
    }
    public static void RequireApiPath(string path)
    {
        var decoded = Uri.UnescapeDataString(path);
        if (!path.StartsWith("/api/v1/", StringComparison.Ordinal) || decoded.Contains('\\') || decoded.Contains('#') || decoded.Contains("..", StringComparison.Ordinal) || decoded.StartsWith("//", StringComparison.Ordinal))
            throw new ArgumentException("传输仅允许固定服务的 API 路径。", nameof(path));
    }
    private static async Task AtomicWriteAsync(string path, string value, CancellationToken ct)
    { await File.WriteAllTextAsync(path + ".tmp", value, ct); File.Move(path + ".tmp", path, true); }
    private sealed class SegmentStream(Stream inner, long remaining) : Stream
    {
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) { var n = inner.Read(buffer, offset, (int)Math.Min(count, remaining)); remaining -= n; return n; }
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
        { var n = await inner.ReadAsync(buffer[..(int)Math.Min(buffer.Length, remaining)], ct); remaining -= n; return n; }
        public override void Flush() => throw new NotSupportedException(); public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
