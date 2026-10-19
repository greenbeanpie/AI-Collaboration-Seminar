using System.Text.Json.Nodes;
using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Documents;
using System.Text.RegularExpressions;

namespace Buwei.Windows.Views;

internal static class Ui
{
    internal static string Text(this JsonNode? node, string key) => node?[key]?.ToString() ?? "";
    internal static bool Flag(this JsonNode? node, string key) => node?[key]?.ToString() == "true";
    internal static JsonNode? Copy(this JsonNode? node) => node?.DeepClone();
    internal static List<JsonNode> Rows(this JsonNode? node, string key = "items") =>
        (node is JsonArray array ? array : node?[key] as JsonArray)?.Where(x => x != null).Select(x => x!).ToList() ?? [];
    internal static string Id(this JsonNode? node, params string[] keys) => keys.Select(node.Text).FirstOrDefault(x => x.Length > 0) ?? "";
    internal static StackPanel Stack(params UIElement[] children)
    {
        var panel = new StackPanel { Spacing = 12, HorizontalAlignment = HorizontalAlignment.Stretch };
        foreach (var child in children) panel.Children.Add(child);
        return panel;
    }
    internal static TextBlock Label(string text, double size = 14) => new()
    { Text = text, FontSize = size, TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    internal static TextBlock Heading(string text) => new()
    { Text = text, FontSize = 26, FontWeight = Microsoft.UI.Text.FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap };
    internal static Border Card(params UIElement[] content) => new()
    {
        Padding = new Thickness(20), CornerRadius = new CornerRadius(12), BorderThickness = new Thickness(1),
        BorderBrush = new SolidColorBrush(ColorHelper.FromArgb(40, 120, 130, 125)),
        Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"], Child = Stack(content)
    };
    internal static TextBox Field(string label, string? value = "", bool multiline = false, int max = 4000)
    {
        var field = new TextBox { Header = label, Text = value ?? "", AcceptsReturn = multiline, TextWrapping = TextWrapping.Wrap,
            MaxLength = max, MinHeight = multiline ? 110 : 0, HorizontalAlignment = HorizontalAlignment.Stretch };
        AutomationProperties.SetName(field, label);
        return field;
    }
    internal static ComboBox Choice(string label, IEnumerable<(string Id, string Label)> choices, string selected = "")
    {
        var box = new ComboBox { Header = label, HorizontalAlignment = HorizontalAlignment.Stretch, MinWidth = 170 };
        foreach (var (id, title) in choices) box.Items.Add(new ComboBoxItem { Tag = id, Content = title });
        box.SelectedItem = box.Items.OfType<ComboBoxItem>().FirstOrDefault(x => (string)x.Tag == selected);
        if (box.SelectedIndex < 0 && box.Items.Count > 0) box.SelectedIndex = 0;
        return box;
    }
    internal static string Value(this ComboBox box) => (box.SelectedItem as ComboBoxItem)?.Tag?.ToString() ?? "";
    internal static Button Button(string title, Func<Task> action, bool primary = false)
    {
        var button = new Button { Content = title, MinHeight = 36, HorizontalAlignment = HorizontalAlignment.Left };
        if (primary) button.Style = (Style)Application.Current.Resources["AccentButtonStyle"];
        button.Click += async (_, _) => { button.IsEnabled = false; try { await action(); } finally { button.IsEnabled = true; } };
        return button;
    }
    internal static ScrollViewer Scroll(UIElement child) => new()
    { Content = child, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, Padding = new Thickness(28, 20, 28, 40) };
    internal static string Status(string value) => value switch
    {
        "active" => "进行中", "archived" => "已归档", "open" => "待领取", "in_progress" => "执行中",
        "submitted" => "待验收", "accepted" => "已完成", "improve" => "需改进", "rework" => "需重做",
        "pending" => "待处理", "done" => "已完成", "doing" => "执行中", "todo" => "待开始", "blocked" => "受阻",
        "succeeded" => "已成功", "failed" => "失败", "running" => "执行中", "queued" => "排队中", "cancelled" => "已取消",
        "waiting_user" => "待用户回复", "resolved" => "已解决", "closed" => "已关闭", "ready_for_review" => "待人工核对",
        _ => value
    };
    internal static UIElement Markdown(string source)
    {
        var panel = Stack(); var code = false;
        foreach (var raw in source.Replace("\r\n", "\n").Split('\n'))
        {
            if (raw.StartsWith("```", StringComparison.Ordinal)) { code = !code; continue; }
            if (raw.Length == 0) { panel.Children.Add(new Border { Height = 3 }); continue; }
            var heading = Regex.Match(raw, "^(#{1,6})\\s+(.+)$");
            var text = heading.Success ? heading.Groups[2].Value : raw.StartsWith("- ", StringComparison.Ordinal) || raw.StartsWith("* ", StringComparison.Ordinal) ? "• " + raw[2..] : raw.StartsWith("> ", StringComparison.Ordinal) ? "│ " + raw[2..] : raw;
            var block = Label("", heading.Success ? Math.Max(16, 28 - heading.Groups[1].Length * 2) : 14); if (heading.Success) block.FontWeight = Microsoft.UI.Text.FontWeights.SemiBold;
            if (code) { block.FontFamily = new FontFamily("Cascadia Mono, Consolas"); block.Text = raw; }
            else
            {
                var position = 0;
                foreach (Match match in Regex.Matches(text, "(\\*\\*([^*]+)\\*\\*|`([^`]+)`|\\[([^\\]]+)\\]\\((https?://[^ )]+)\\))"))
                {
                    if (match.Index > position) block.Inlines.Add(new Run { Text = text[position..match.Index] });
                    if (match.Groups[2].Success) block.Inlines.Add(new Run { Text = match.Groups[2].Value, FontWeight = Microsoft.UI.Text.FontWeights.Bold });
                    else if (match.Groups[3].Success) block.Inlines.Add(new Run { Text = match.Groups[3].Value, FontFamily = new FontFamily("Cascadia Mono, Consolas") });
                    else if (Uri.TryCreate(match.Groups[5].Value, UriKind.Absolute, out var uri) && uri.UserInfo.Length == 0)
                    { var link = new Hyperlink { NavigateUri = uri }; link.Inlines.Add(new Run { Text = match.Groups[4].Value }); block.Inlines.Add(link); }
                    position = match.Index + match.Length;
                }
                if (position < text.Length) block.Inlines.Add(new Run { Text = text[position..] });
            }
            panel.Children.Add(block);
        }
        return panel;
    }
}
