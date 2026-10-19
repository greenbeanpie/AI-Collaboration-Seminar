using System.Diagnostics;
using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace Buwei.Windows.App.Platform;

public sealed record NativeUpdate(string Version, Uri Url, string Signature, string Sha256, long SizeBytes);

public sealed class NativeUpdates(string dataDirectory, ActivityGate activity)
{
    public const string ManifestUrl = "https://github.com/greenbeanpie/AI-Collaboration-Seminar/releases/latest/download/windows-native.json";
    private readonly HttpClient client = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromMinutes(10) };
    private readonly SemaphoreSlim operation = new(1, 1);
    private static readonly HashSet<string> AllowedHosts = ["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"];
    public async Task<NativeUpdate?> CheckAsync(Version currentVersion, CancellationToken ct = default)
    {
        var bytes = await ReadLimitedAsync(new Uri(ManifestUrl), 128 * 1024, ct);
        var signature = System.Text.Encoding.UTF8.GetString(await ReadLimitedAsync(new Uri(ManifestUrl + ".sig"), 16 * 1024, ct));
        MinisignVerifier.Verify(bytes, signature);
        var node = JsonNode.Parse(bytes) ?? throw new InvalidDataException("更新清单为空。");
        if (node["channel"]?.GetValue<string>() != "windows-native" || node["architecture"]?.GetValue<string>() != "x64") throw new InvalidDataException("更新通道不匹配。");
        var version = node["version"]!.GetValue<string>();
        if (!Version.TryParse(version, out var parsed)) throw new InvalidDataException("更新版本无效。");
        if (parsed <= currentVersion) return null;
        var update = new NativeUpdate(version, new Uri(node["url"]!.GetValue<string>()), node["signature"]!.GetValue<string>(), node["sha256"]!.GetValue<string>(), node["sizeBytes"]!.GetValue<long>());
        ValidateUri(update.Url);
        if (update.SizeBytes <= 0 || update.SizeBytes > 2L * 1024 * 1024 * 1024 || update.Sha256.Length != 64) throw new InvalidDataException("更新文件大小或摘要无效。");
        return update;
    }
    public async Task<string> DownloadAsync(NativeUpdate update, CancellationToken ct = default)
    {
        await operation.WaitAsync(ct);
        try
        {
            using var busy = activity.Enter("更新下载");
            Directory.CreateDirectory(dataDirectory);
            var path = Path.Combine(dataDirectory, "Buwei.Windows.Native-" + Version.Parse(update.Version) + ".exe");
            var temporary = path + ".partial";
            using var response = await GetAsync(update.Url, ct);
            if (response.Content.Headers.ContentLength is long declared && declared != update.SizeBytes) throw new InvalidDataException("更新文件长度不匹配。");
            await using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true))
            {
                await using var input = await response.Content.ReadAsStreamAsync(ct);
                var buffer = new byte[65536]; long total = 0; int count;
                while ((count = await input.ReadAsync(buffer, ct)) != 0)
                { total += count; if (total > update.SizeBytes) throw new InvalidDataException("更新文件超过清单大小。"); await output.WriteAsync(buffer.AsMemory(0, count), ct); }
                if (total != update.SizeBytes) throw new InvalidDataException("更新下载不完整。");
                await output.FlushAsync(ct);
            }
            VerifyFile(temporary, update);
            File.Move(temporary, path, true);
            return path;
        }
        finally { operation.Release(); }
    }
    public void Install(string verifiedPath, NativeUpdate update)
    {
        using var restart = activity.BeginRestart();
        var expected = Path.Combine(Path.GetFullPath(dataDirectory), "Buwei.Windows.Native-" + Version.Parse(update.Version) + ".exe");
        if (!Path.GetFullPath(verifiedPath).Equals(expected, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装文件不在独立更新目录中。");
        VerifyFile(expected, update); // Recheck immediately before starting, not just at download time.
        _ = Process.Start(new ProcessStartInfo(expected) { UseShellExecute = true, Arguments = "/S" }) ?? throw new InvalidOperationException("无法启动安装程序。");
        // Caller must close the shell only after this succeeds. NSIS waits for this process to exit.
    }
    private static void VerifyFile(string path, NativeUpdate update)
    {
        if (new FileInfo(path).Length != update.SizeBytes) throw new InvalidDataException("更新文件大小不匹配。");
        var bytes = File.ReadAllBytes(path);
        if (!Convert.ToHexString(SHA256.HashData(bytes)).Equals(update.Sha256, StringComparison.OrdinalIgnoreCase)) throw new CryptographicException("更新摘要不匹配。");
        MinisignVerifier.Verify(bytes, update.Signature);
    }
    private async Task<byte[]> ReadLimitedAsync(Uri uri, int maximum, CancellationToken ct)
    {
        using var response = await GetAsync(uri, ct);
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var memory = new MemoryStream(); var buffer = new byte[4096]; int count;
        while ((count = await stream.ReadAsync(buffer, ct)) != 0)
        { if (memory.Length + count > maximum) throw new InvalidDataException("更新清单过大。"); memory.Write(buffer, 0, count); }
        return memory.ToArray();
    }
    private async Task<HttpResponseMessage> GetAsync(Uri uri, CancellationToken ct)
    {
        for (var redirect = 0; redirect < 5; redirect++)
        {
            ValidateUri(uri);
            var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, ct);
            if ((int)response.StatusCode is >= 300 and < 400)
            {
                var location = response.Headers.Location; response.Dispose();
                if (location is null) throw new InvalidDataException("更新重定向缺少地址。");
                uri = location.IsAbsoluteUri ? location : new Uri(uri, location); continue;
            }
            try { response.EnsureSuccessStatusCode(); return response; } catch { response.Dispose(); throw; }
        }
        throw new InvalidDataException("更新重定向过多。");
    }
    private static void ValidateUri(Uri uri)
    {
        if (uri.Scheme != "https" || !uri.IsDefaultPort || !AllowedHosts.Contains(uri.Host) || uri.UserInfo.Length != 0) throw new InvalidDataException("更新地址不受信任。");
    }
}
