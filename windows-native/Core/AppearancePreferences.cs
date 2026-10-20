using System.Text.Json.Nodes;

namespace Buwei.Windows.Core;

public enum AppearanceDesign { Classic, PrototypeBlue }
public enum AppearanceMode { System, Light, Dark }
public sealed record AppearancePreferences(AppearanceDesign Design = AppearanceDesign.Classic, AppearanceMode Mode = AppearanceMode.System);
public sealed record AppearanceLoad(AppearancePreferences Preferences, string? Warning = null);

/// <summary>Device-local presentation preferences; independent of account data and server settings.</summary>
public sealed class AppearancePreferencesStore(string directory)
{
    private readonly SemaphoreSlim saving = new(1);
    public string FilePath { get; } = Path.Combine(directory, "appearance.json");
    public AppearanceLoad Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new(new());
            if (new FileInfo(FilePath).Length > 4096) throw new InvalidDataException("外观配置过大");
            var json = JsonNode.Parse(File.ReadAllText(FilePath)) ?? throw new InvalidDataException("外观配置为空");
            if (json["version"]?.GetValue<int>() != 1) throw new InvalidDataException("外观配置版本暂不支持");
            var design = json["design"]?.GetValue<string>() switch { "classic" => AppearanceDesign.Classic, "prototype-blue" => AppearanceDesign.PrototypeBlue, _ => throw new InvalidDataException("主题无效") };
            var mode = json["mode"]?.GetValue<string>() switch { "system" => AppearanceMode.System, "light" => AppearanceMode.Light, "dark" => AppearanceMode.Dark, _ => throw new InvalidDataException("明暗模式无效") };
            return new(new(design, mode));
        }
        catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException or OverflowException)
        { return new(new(), "已使用默认外观，原配置保留：" + e.Message); }
    }
    public async Task SaveAsync(AppearancePreferences value, CancellationToken ct = default)
    {
        if (!Enum.IsDefined(value.Design) || !Enum.IsDefined(value.Mode)) throw new ArgumentException("外观选项无效");
        await saving.WaitAsync(ct);
        var temporary = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var json = new JsonObject { ["version"] = 1, ["design"] = value.Design == AppearanceDesign.PrototypeBlue ? "prototype-blue" : "classic", ["mode"] = value.Mode.ToString().ToLowerInvariant() };
            await File.WriteAllTextAsync(temporary, json.ToJsonString(), ct);
            ct.ThrowIfCancellationRequested();
            File.Move(temporary, FilePath, true);
        }
        finally { try { if (File.Exists(temporary)) File.Delete(temporary); } finally { saving.Release(); } }
    }
}

public sealed record AppearancePalette(string Page, string Surface, string Navigation, string Card, string Stroke,
    string Text, string SecondaryText, string Accent, string AccentHover, string AccentText, string AccentSoft, string Hover, string Ai, string AiSoft)
{
    // Opaque surface equivalents of docs/ui-prototypes/buwei-dual-platform-prototype.html.
    // Dark filled buttons retain the readable blue/white pair; links use the lighter blue.
    public static AppearancePalette Resolve(AppearanceDesign design, bool dark) => (design, dark) switch
    {
        (AppearanceDesign.PrototypeBlue, false) => new("#F5F7FB", "#F7F9FC", "#ECF0F7", "#FFFFFF", "#E6EAF2", "#141824", "#4E586E", "#2563EB", "#1D4ED8", "#2563EB", "#EBF2FF", "#F3F7FF", "#6D28D9", "#F3E8FF"),
        (AppearanceDesign.PrototypeBlue, true) => new("#161B26", "#1A2130", "#10141D", "#222A3B", "#3B4559", "#F1F5F9", "#94A3B8", "#2563EB", "#1D4ED8", "#60A5FA", "#223652", "#283248", "#A78BFA", "#332C50"),
        (_, true) => new("#202020", "#202020", "#202020", "#2B2B2B", "#484848", "#FFFFFF", "#C5C5C5", "#168560", "#12704F", "#5DCBA4", "#183D31", "#383838", "#C4ADFF", "#332B43"),
        _ => new("#F3F3F3", "#F9F9F9", "#EEEEEE", "#FFFFFF", "#E0E0E0", "#1B1B1B", "#5D5D5D", "#168560", "#237B5D", "#12704F", "#E9F5EF", "#F0F0F0", "#6D28D9", "#F3E8FF")
    };
}
