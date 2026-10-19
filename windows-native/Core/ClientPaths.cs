using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Buwei.Windows.Core;

public static partial class ClientPaths
{
    public const string ProductionOrigin = "https://greenbp-team-office.hddhp.workers.dev";
    public const string Callback = "buwei-windows-native://auth/callback";
    public static string Normalize(string path)
    {
        var decoded = Uri.UnescapeDataString(path.Split('?', 2)[0]);
        if (!path.StartsWith('/') || path.StartsWith("//") || path.Contains('#') || path.Any(char.IsControl) || decoded.Contains('\\') || decoded.Contains('#') || decoded.Contains("..") || decoded.Any(char.IsControl))
            throw new ArgumentException("只允许应用内接口路径", nameof(path));
        return path.StartsWith("/api/v1/", StringComparison.Ordinal) ? path : "/api/v1" + path;
    }
    public static string? Project(string path) => ProjectPattern().Match(path) is { Success: true } match ? match.Groups[1].Value : null;
    public static string? ResourceIndexScope(string path) => ResourceIndexPattern().Match(path) is { Success: true } match ? match.Groups[1].Value : null;
    public static bool Writable(string method, string path)
    {
        if (path.Contains('?')) return false;
        var match = TailPattern().Match(path);
        if (!match.Success) return false;
        var tail = match.Groups[1].Value;
        return method == "PUT" && Regex.IsMatch(tail, "^materials/[a-zA-Z0-9-]+$") ||
            method == "PATCH" && Regex.IsMatch(tail, "^(?:collaboration/)?tasks/[a-zA-Z0-9-]+$") ||
            method == "POST" && Regex.IsMatch(tail, "^(?:tasks|comments|collaboration/tasks|(?:collaboration/)?tasks/[a-zA-Z0-9-]+/(?:claim|submissions))$");
    }
    public static bool Cacheable(string path) => path == "/api/v1/projects" || path.StartsWith("/api/v1/projects?", StringComparison.Ordinal) ||
        Project(path) != null && !Regex.IsMatch(path, "/(?:content|voice-sessions|agent-sessions|export|exports|uploads|ai)(?:/|\\?|$)");
    public static string SafeSegment(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
    public static string SnapshotKey(string path)
    {
        var parts = path.Split('?', 2);
        if (parts.Length == 1) return path;
        var query = parts[1].Split('&', StringSplitOptions.RemoveEmptyEntries).Select(x => x.Split('=', 2))
            .Where(x => x.Length == 2 && x[1].Length > 0).OrderBy(x => x[0], StringComparer.Ordinal).ThenBy(x => x[1], StringComparer.Ordinal)
            .Select(x => x[0] + "=" + x[1]).ToArray();
        return parts[0] + (query.Length == 0 ? "" : "?" + string.Join('&', query));
    }
    [GeneratedRegex("^/api/v1/projects/([a-zA-Z0-9-]+)(?:/|\\?|$)")] private static partial Regex ProjectPattern();
    [GeneratedRegex("^(/api/v1/projects/[a-zA-Z0-9-]+/resource-index/(?:source|material)/[a-zA-Z0-9-]+)(?:/|\\?|$)")] private static partial Regex ResourceIndexPattern();
    [GeneratedRegex("^/api/v1/projects/[a-zA-Z0-9-]+/(.+)$")] private static partial Regex TailPattern();
}
