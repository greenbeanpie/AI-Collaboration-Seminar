using System.ComponentModel;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.UI;
using Windows.UI.ViewManagement;

namespace Buwei.Windows;

public sealed class AppearanceTheme : INotifyPropertyChanged, IDisposable
{
    public static AppearanceTheme? Current { get; private set; }
    private readonly FrameworkElement root;
    private readonly Window window;
    private readonly AppearancePreferencesStore store;
    private readonly AccessibilitySettings accessibility = new();
    private readonly UISettings system = new();
    private bool disposed;
    public AppearancePreferences Preferences { get; private set; }
    public string? LoadWarning { get; private set; }
    public event PropertyChangedEventHandler? PropertyChanged;
    private bool Spacious => Preferences.Design == AppearanceDesign.PrototypeBlue;
    public Thickness CardPadding => Spacious ? new(24, 20, 24, 20) : new(20);
    public CornerRadius CardCorner => new(Spacious ? 10 : 12);
    public CornerRadius ControlCorner => new(Spacious ? 7 : 4);
    public Thickness PagePadding => Spacious ? new(30, 26, 30, 40) : new(28, 20, 28, 40);
    public double StackSpacing => Spacious ? 16 : 12;
    public double NavigationWidth => Spacious ? 236 : 218;
    public double HeadingSize => Spacious ? 24 : 26;
    public ElementTheme EffectiveTheme => root.ActualTheme == ElementTheme.Dark ? ElementTheme.Dark : ElementTheme.Light;
    public Thickness ButtonPadding => Spacious ? new(14, 7, 14, 7) : new(12, 5, 12, 5);

    public AppearanceTheme(Window window, FrameworkElement root, string directory)
    {
        this.window = window; this.root = root; store = new(directory);
        var loaded = store.Load(); Preferences = loaded.Preferences; LoadWarning = loaded.Warning;
        Current = this;
        // Own these brushes explicitly: built-in aliases may be AcrylicBrush or shared objects.
        foreach (var key in new[] { "BuweiPageBrush", "BuweiSurfaceBrush", "BuweiCardBrush", "BuweiStrokeBrush", "BuweiTextBrush", "BuweiSecondaryTextBrush", "BuweiNavigationBrush", "BuweiAccentSoftBrush", "BuweiAiBrush", "BuweiAiSoftBrush",
            "AccentFillColorDefaultBrush", "SystemControlHighlightAccentBrush", "NavigationViewSelectionIndicatorForeground", "AccentFillColorSecondaryBrush", "AccentFillColorTertiaryBrush", "AccentTextFillColorPrimaryBrush", "TextOnAccentFillColorPrimaryBrush", "TextOnAccentFillColorSecondaryBrush",
            "NavigationViewDefaultPaneBackground", "NavigationViewExpandedPaneBackground", "NavigationViewItemBackgroundSelected", "NavigationViewItemBackgroundPointerOver", "NavigationViewItemBackgroundSelectedPointerOver",
            "AccentButtonBackground", "AccentButtonBackgroundPointerOver", "AccentButtonBackgroundPressed", "AccentButtonForeground", "AccentButtonForegroundPointerOver", "AccentButtonForegroundPressed", "ButtonBackground", "ButtonBackgroundPointerOver", "ButtonForeground", "ButtonBorderBrush" })
            Application.Current.Resources[key] = new SolidColorBrush();
        root.ActualThemeChanged += ThemeChanged; root.Loaded += Loaded;
        accessibility.HighContrastChanged += HighContrastChanged;
        system.ColorValuesChanged += SystemColorsChanged;
        Apply();
    }
    public async Task SetAsync(AppearancePreferences value)
    {
        await store.SaveAsync(value); // Persist first; a failed save never silently changes the active theme.
        if (disposed) return;
        Preferences = value; LoadWarning = null; Apply();
        PropertyChanged?.Invoke(this, new(null));
    }
    public static Brush Brush(string key)
    {
        var resources = Application.Current.Resources;
        if (!resources.ContainsKey(key)) resources[key] = new SolidColorBrush();
        return (Brush)resources[key];
    }
    public static void Bind(FrameworkElement element, DependencyProperty property, string name)
    {
        if (Current != null) element.SetBinding(property, new Binding { Source = Current, Path = new PropertyPath(name), Mode = BindingMode.OneWay });
    }
    public static async Task<ContentDialogResult> ShowDialogAsync(ContentDialog dialog)
    {
        Bind(dialog, FrameworkElement.RequestedThemeProperty, nameof(EffectiveTheme));
        return await dialog.ShowAsync();
    }
    private static Color Color(string hex) => Microsoft.UI.ColorHelper.FromArgb(255, Convert.ToByte(hex.Substring(1, 2), 16), Convert.ToByte(hex.Substring(3, 2), 16), Convert.ToByte(hex.Substring(5, 2), 16));
    private static void Paint(string key, Color color) => ((SolidColorBrush)Brush(key)).Color = color;
    private void Apply()
    {
        root.RequestedTheme = Preferences.Mode switch { AppearanceMode.Light => ElementTheme.Light, AppearanceMode.Dark => ElementTheme.Dark, _ => ElementTheme.Default };
        ApplyPalette();
    }
    private void ApplyPalette()
    {
        if (disposed) return;
        var palette = AppearancePalette.Resolve(Preferences.Design, root.ActualTheme == ElementTheme.Dark);
        var highContrast = accessibility.HighContrast;
        var background = highContrast ? system.GetColorValue(UIColorType.Background) : Color(palette.Page);
        var foreground = highContrast ? system.GetColorValue(UIColorType.Foreground) : Color(palette.Text);
        var accent = highContrast ? foreground : Color(palette.Accent);
        var secondary = highContrast ? foreground : Color(palette.SecondaryText);
        Paint("BuweiPageBrush", background);
        Paint("BuweiSurfaceBrush", highContrast ? background : Color(palette.Surface));
        Paint("BuweiCardBrush", highContrast ? background : Color(palette.Card));
        Paint("BuweiStrokeBrush", highContrast ? foreground : Color(palette.Stroke));
        Paint("BuweiTextBrush", foreground); Paint("BuweiSecondaryTextBrush", secondary);
        Paint("BuweiAccentSoftBrush", highContrast ? background : Color(palette.AccentSoft));
        Paint("BuweiAiBrush", highContrast ? foreground : Color(palette.Ai));
        Paint("BuweiAiSoftBrush", highContrast ? background : Color(palette.AiSoft));
        foreach (var key in new[] { "AccentFillColorDefaultBrush", "SystemControlHighlightAccentBrush", "NavigationViewSelectionIndicatorForeground" }) Paint(key, accent);
        foreach (var key in new[] { "AccentFillColorSecondaryBrush", "AccentFillColorTertiaryBrush" }) Paint(key, highContrast ? foreground : Color(palette.AccentHover));
        Paint("AccentTextFillColorPrimaryBrush", highContrast ? foreground : Color(palette.AccentText));
        Paint("TextOnAccentFillColorPrimaryBrush", highContrast ? background : Microsoft.UI.Colors.White);
        Paint("TextOnAccentFillColorSecondaryBrush", highContrast ? background : Microsoft.UI.Colors.White);
        Paint("AccentButtonBackground", accent);
        foreach (var key in new[] { "AccentButtonBackgroundPointerOver", "AccentButtonBackgroundPressed" }) Paint(key, highContrast ? foreground : Color(palette.AccentHover));
        foreach (var key in new[] { "AccentButtonForeground", "AccentButtonForegroundPointerOver", "AccentButtonForegroundPressed" }) Paint(key, highContrast ? background : Microsoft.UI.Colors.White);
        Paint("ButtonBackground", highContrast ? background : Color(palette.Card)); Paint("ButtonBackgroundPointerOver", highContrast ? background : Color(palette.Hover));
        Paint("ButtonForeground", foreground); Paint("ButtonBorderBrush", highContrast ? foreground : Color(palette.Stroke));
        foreach (var key in new[] { "NavigationViewDefaultPaneBackground", "NavigationViewExpandedPaneBackground", "BuweiNavigationBrush" }) Paint(key, highContrast ? background : Color(palette.Navigation));
        Paint("NavigationViewItemBackgroundSelected", highContrast ? background : Color(palette.Card));
        foreach (var key in new[] { "NavigationViewItemBackgroundPointerOver", "NavigationViewItemBackgroundSelectedPointerOver" }) Paint(key, highContrast ? background : Color(palette.Hover));
        Application.Current.Resources["SystemAccentColor"] = accent;
        if (!Microsoft.UI.Windowing.AppWindowTitleBar.IsCustomizationSupported()) return;
        var title = window.AppWindow.TitleBar;
        title.BackgroundColor = highContrast ? background : Color(palette.Navigation); title.ForegroundColor = foreground;
        title.InactiveBackgroundColor = title.BackgroundColor; title.InactiveForegroundColor = secondary;
        title.ButtonBackgroundColor = title.BackgroundColor; title.ButtonForegroundColor = foreground;
        title.ButtonHoverBackgroundColor = highContrast ? background : Color(palette.Hover); title.ButtonHoverForegroundColor = foreground;
        title.ButtonInactiveBackgroundColor = title.BackgroundColor; title.ButtonInactiveForegroundColor = secondary;
    }
    private void ThemeChanged(FrameworkElement sender, object args) { ApplyPalette(); PropertyChanged?.Invoke(this, new(nameof(EffectiveTheme))); }
    private void Loaded(object sender, RoutedEventArgs args) => ApplyPalette();
    private void HighContrastChanged(AccessibilitySettings sender, object args) => root.DispatcherQueue.TryEnqueue(ApplyPalette);
    private void SystemColorsChanged(UISettings sender, object args) => root.DispatcherQueue.TryEnqueue(ApplyPalette);
    public void Dispose()
    {
        disposed = true;
        root.ActualThemeChanged -= ThemeChanged; root.Loaded -= Loaded;
        accessibility.HighContrastChanged -= HighContrastChanged; system.ColorValuesChanged -= SystemColorsChanged;
        if (Current == this) Current = null;
    }
}
