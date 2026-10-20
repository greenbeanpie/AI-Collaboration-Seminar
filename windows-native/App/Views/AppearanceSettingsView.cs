using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed class AppearanceSettingsView : UserControl
{
    public AppearanceSettingsView(AppearanceTheme theme)
    {
        var design = Ui.Choice("界面主题", [("classic", "经典 · 翠绿"), ("prototype-blue", "澄蓝 · 舒展（界面原型）")], theme.Preferences.Design == AppearanceDesign.PrototypeBlue ? "prototype-blue" : "classic");
        var mode = Ui.Choice("明暗模式", [("system", "跟随 Windows"), ("light", "浅色"), ("dark", "深色")], theme.Preferences.Mode.ToString().ToLowerInvariant());
        var message = Ui.Label(theme.LoadWarning ?? "即时生效并保存在本机，正在编辑的内容将保留。");
        var detail = Ui.Label("取自双端界面原型的蓝色、冷灰分区、圆角卡片与舒展留白。Windows 高对比度开启时优先采用系统对比色。");
        detail.Foreground = AppearanceTheme.Brush("BuweiSecondaryTextBrush");
        var preview = Ui.Card(Ui.Heading("任务协作"), Ui.Label("预览 · 标题、正文与卡片层次"),
            new Border { Padding = new Thickness(12), CornerRadius = new CornerRadius(7), Background = AppearanceTheme.Brush("BuweiAccentSoftBrush"), Child = new TextBlock { Text = "固定版本 · 清晰的协作工作区", TextWrapping = TextWrapping.Wrap, Foreground = AppearanceTheme.Brush("AccentTextFillColorPrimaryBrush") } },
            new Border { Padding = new Thickness(12), CornerRadius = new CornerRadius(7), Background = AppearanceTheme.Brush("BuweiAiSoftBrush"), Child = new TextBlock { Text = "AI 辅助 · 紫色辅助提示", TextWrapping = TextWrapping.Wrap, Foreground = AppearanceTheme.Brush("BuweiAiBrush") } },
            Ui.Button("主按钮预览", () => Task.CompletedTask, true));
        Content = Ui.Stack(detail, design, mode, preview, message);
        var restoring = false;
        async void Changed(object sender, SelectionChangedEventArgs args)
        {
            if (restoring) return;
            design.IsEnabled = false; mode.IsEnabled = false;
            try
            {
                await theme.SetAsync(new(design.Value() == "prototype-blue" ? AppearanceDesign.PrototypeBlue : AppearanceDesign.Classic,
                    mode.Value() switch { "light" => AppearanceMode.Light, "dark" => AppearanceMode.Dark, _ => AppearanceMode.System }));
                message.Text = "外观已保存，重启后继续使用。";
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                restoring = true;
                design.SelectedIndex = theme.Preferences.Design == AppearanceDesign.PrototypeBlue ? 1 : 0;
                mode.SelectedIndex = (int)theme.Preferences.Mode;
                message.Text = "外观未保存，继续使用原设置：" + error.Message;
            }
            finally { restoring = false; design.IsEnabled = true; mode.IsEnabled = true; }
        }
        design.SelectionChanged += Changed; mode.SelectionChanged += Changed;
    }
}
