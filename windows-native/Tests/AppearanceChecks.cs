using Buwei.Windows.Core;
using System.Globalization;
using System.Text.RegularExpressions;

internal static class AppearanceChecks
{
    public static async Task RunAsync(Action<bool, string> check)
    {
        var folder = Path.Combine(Path.GetTempPath(), "Buwei-Appearance-" + Guid.NewGuid().ToString("N"));
        var store = new AppearancePreferencesStore(folder);
        try
        {
            check(store.Load() == new AppearanceLoad(new()), "Appearance defaults preserve classic and system mode");
            foreach (var design in Enum.GetValues<AppearanceDesign>()) foreach (var mode in Enum.GetValues<AppearanceMode>())
            {
                var selected = new AppearancePreferences(design, mode); await store.SaveAsync(selected);
                check(new AppearancePreferencesStore(folder).Load().Preferences == selected, $"Appearance survives restart: {design}/{mode}");
            }
            var original = await File.ReadAllTextAsync(store.FilePath);
            using var stop = new CancellationTokenSource(); stop.Cancel();
            try { await store.SaveAsync(new(), stop.Token); throw new Exception("Expected cancellation"); } catch (OperationCanceledException) { }
            check(await File.ReadAllTextAsync(store.FilePath) == original, "Cancelled appearance write preserves existing selection");
            try { await store.SaveAsync(new((AppearanceDesign)999)); throw new Exception("Expected invalid design rejection"); } catch (ArgumentException) { }
            check(await File.ReadAllTextAsync(store.FilePath) == original, "Invalid appearance selection cannot overwrite settings");
            // A locked target simulates replace failure: atomic save must retain the original file.
            using (var locked = new FileStream(store.FilePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                try { await store.SaveAsync(new()); throw new Exception("Expected locked-target failure"); } catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }
            check(await File.ReadAllTextAsync(store.FilePath) == original && Directory.GetFiles(folder, "*.tmp").Length == 0, "Failed appearance replacement preserves settings and cleans temporary file");
            foreach (var corrupt in new[] { "not-json", "null", "{\"version\":2}", "{\"version\":1,\"design\":\"unknown\",\"mode\":\"dark\"}", "{\"version\":1,\"design\":\"classic\",\"mode\":0}", new string('x', 5000) })
            {
                await File.WriteAllTextAsync(store.FilePath, corrupt); var loaded = store.Load();
                check(loaded.Preferences == new AppearancePreferences() && loaded.Warning != null && await File.ReadAllTextAsync(store.FilePath) == corrupt, "Invalid/unsupported appearance file falls back without deleting original");
            }
            foreach (var design in Enum.GetValues<AppearanceDesign>()) foreach (var dark in new[] { false, true })
            {
                var p = AppearancePalette.Resolve(design, dark);
                check(Contrast(p.Text, p.Card) >= 4.5 && Contrast(p.SecondaryText, p.Card) >= 4.5 && Contrast(p.Text, p.Page) >= 4.5, $"Readable body and secondary text: {design}/{dark}");
                check(Contrast("#FFFFFF", p.Accent) >= 4.5 && Contrast("#FFFFFF", p.AccentHover) >= 4.5 && Contrast(p.AccentText, p.AccentSoft) >= 4.5 && Contrast(p.Ai, p.AiSoft) >= 4.5, $"Readable accent buttons and preview chips: {design}/{dark}");
            }
            var source = await File.ReadAllTextAsync(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../docs/ui-prototypes/buwei-dual-platform-prototype.html")));
            foreach (var dark in new[] { false, true })
            {
                var selector = dark ? "[data-theme=\"dark\"]" : ":root, [data-theme=\"light\"]";
                var css = source[(source.IndexOf(selector, StringComparison.Ordinal) + selector.Length)..].Split('}', 2)[0];
                string Token(string key) => Regex.Match(css, "--" + key + @":\s*(#[0-9A-Fa-f]{6})\s*;").Groups[1].Value;
                var p = AppearancePalette.Resolve(AppearanceDesign.PrototypeBlue, dark);
                check(p.Page == Token("bg-mica-base") && p.Navigation == Token("bg-mica-alt") && p.Card == Token("bg-layer-2") && p.Text == Token("text-primary") && p.SecondaryText == Token("text-secondary") && p.Ai == Token("ai-accent"), $"Blue theme surfaces and typography match supplied prototype: {dark}");
            }
            var repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
            var project = System.Xml.Linq.XDocument.Load(Path.Combine(repo, "windows-native/App/Buwei.Windows.csproj"));
            var winui = project.Descendants("PackageReference").Single(x => (string?)x.Attribute("Include") == "Microsoft.WindowsAppSDK.WinUI");
            var packageRoot = Environment.GetEnvironmentVariable("NUGET_PACKAGES") ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget/packages");
            var generic = await File.ReadAllTextAsync(Path.Combine(packageRoot, "microsoft.windowsappsdk.winui", (string)winui.Attribute("Version")!, "lib/native/Microsoft.UI/Themes/generic.xaml"));
            var controller = await File.ReadAllTextAsync(Path.Combine(repo, "windows-native/App/AppearanceTheme.cs"));
            var registration = controller[controller.IndexOf("foreach (var key in new[]", StringComparison.Ordinal)..controller.IndexOf("root.ActualThemeChanged +=", StringComparison.Ordinal)];
            var keys = Regex.Matches(registration, "\"([A-Za-z][A-Za-z0-9]+)\"").Select(m => m.Groups[1].Value).Where(x => !x.StartsWith("Buwei", StringComparison.Ordinal));
            check(keys.All(key => generic.Contains("x:Key=\"" + key + "\"", StringComparison.Ordinal)), "All overridden native control resources exist in the pinned WinUI templates");

        }
        finally { if (Directory.Exists(folder)) Directory.Delete(folder, true); }
    }
    private static double Contrast(string a, string b)
    {
        static double L(string hex)
        {
            double Channel(int offset) { var v = byte.Parse(hex.AsSpan(offset, 2), NumberStyles.HexNumber) / 255d; return v <= .04045 ? v / 12.92 : Math.Pow((v + .055) / 1.055, 2.4); }
            return .2126 * Channel(1) + .7152 * Channel(3) + .0722 * Channel(5);
        }
        var first = L(a); var second = L(b); return (Math.Max(first, second) + .05) / (Math.Min(first, second) + .05);
    }
}
