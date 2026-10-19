using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Buwei.Windows.Core;

public sealed class NativeAuth(ClientRepository repository, SecretStore secrets)
{
    private static string Random() => Base64(RandomNumberGenerator.GetBytes(32));
    private static string Base64(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public async Task<Uri> BeginAsync(CancellationToken ct = default)
    {
        var verifier = Random(); var state = Random();
        var result = await repository.SendAsync("POST", "/auth/native/transactions", new JsonObject { ["codeChallenge"] = Base64(SHA256.HashData(Encoding.ASCII.GetBytes(verifier))), ["state"] = state, ["clientType"] = "windows" }, ct: ct);
        var path = result?["authorizationPath"]?.GetValue<string>() ?? throw new InvalidDataException("授权地址缺失");
        if (!path.StartsWith("/app/native-authorize?", StringComparison.Ordinal) || path.Contains("://")) throw new InvalidDataException("无效授权地址");
        secrets.Write("pkce", new JsonObject { ["verifier"] = verifier, ["state"] = state, ["started"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() }.ToJsonString());
        return new Uri(repository.Http.BaseAddress!, path);
    }
    public async Task FinishAsync(Uri uri, CancellationToken ct = default)
    {
        if (!string.Equals(uri.GetLeftPart(UriPartial.Path), ClientPaths.Callback, StringComparison.Ordinal) || uri.Fragment.Length != 0 || uri.UserInfo.Length != 0) throw new InvalidDataException("无效授权回调");
        var pending = JsonNode.Parse(secrets.Read("pkce") ?? "null") ?? throw new InvalidOperationException("请重新发起登录");
        var query = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split('=', 2)).ToDictionary(x => Uri.UnescapeDataString(x[0]), x => x.Length == 2 ? Uri.UnescapeDataString(x[1]) : "");
        if (query.Count != 2 || query.Keys.Any(x => x is not ("state" or "code" or "error")) ||
            query.TryGetValue("code", out var candidate) && !System.Text.RegularExpressions.Regex.IsMatch(candidate, "^[A-Za-z0-9_-]{43}$") ||
            query.TryGetValue("error", out var error) && error != "access_denied")
            throw new InvalidDataException("无效授权回调参数");
        var expected = pending["state"]!.GetValue<string>();
        if (!query.TryGetValue("state", out var state) || !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(expected), Encoding.UTF8.GetBytes(state))) throw new InvalidDataException("授权状态不匹配");
        var age = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - pending["started"]!.GetValue<long>();
        if (age < 0 || age >= 300) { secrets.Write("pkce", null); throw new InvalidOperationException("授权请求已过期"); }
        secrets.Write("pkce", null);
        if (query.ContainsKey("error")) throw new OperationCanceledException("已取消登录");
        if (!query.TryGetValue("code", out var code)) throw new InvalidDataException("授权码缺失");
        await repository.ExchangeAsync(code, pending["verifier"]!.GetValue<string>(), ct);
    }
}
