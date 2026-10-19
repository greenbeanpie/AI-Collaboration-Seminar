using System.Diagnostics;
using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Buwei.Windows.Platform;
using Buwei.Windows.Views;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using Windows.Storage;

namespace Buwei.Windows;

public sealed class MainWindow : Window
{
    private readonly Grid layout = new() { RowDefinitions = { new() { Height = GridLength.Auto }, new() { Height = new GridLength(1, GridUnitType.Star) }, new() { Height = GridLength.Auto } } };
    private readonly ContentControl content = new() { HorizontalContentAlignment = HorizontalAlignment.Stretch, VerticalContentAlignment = VerticalAlignment.Stretch };
    private readonly InfoBar status = new() { IsOpen = true, IsClosable = false, Message = "正在恢复账户" };
    private readonly ActivityGate activity = new();
    private readonly ClientRepository repository;
    private readonly NativeAuth auth;
    private readonly NativeFiles files;
    private readonly NativeUpdates updates;
    private readonly NativeTray tray;
    private NativeNotifications? notifications;
    private NativeMedia? media;
    private WorkspaceView? workspace;
    private bool exiting, hidden, polling, initialized, checkingUpdate;
    private DateTimeOffset hiddenAt, nextUpdate = DateTimeOffset.MinValue;
    private readonly HashSet<string> seen = [];
    private string? seenAccount;
    private readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromMinutes(1) };
    private NativeUpdate? readyUpdate;
    private string? readyInstaller;
    private bool autoRestart = true;
    public MainWindow()
    {
        Title = "补位 · Windows 原生";
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Buwei.Windows.Native");
        Uri? origin = null;
        if (Environment.GetCommandLineArgs().Contains("--benchmark")) directory = Path.Combine(Path.GetTempPath(), "Buwei.Windows.Native.Benchmark");
#if DEBUG
        if (Environment.GetEnvironmentVariable("BUWEI_WINDOWS_SMOKE") == "1")
        {
            directory = Path.Combine(Path.GetTempPath(), "Buwei.Windows.Native.Smoke");
            origin = new Uri("http://127.0.0.1:5188");
        }
#endif
        var secrets = new SecretStore(Path.Combine(directory, "credentials"));
#if DEBUG
        if (origin != null) secrets.Write("session", new JsonObject { ["cookie"] = "ai_office_session=synthetic-fixture", ["user"] = new JsonObject { ["id"] = "00000000-0000-4000-8000-000000000001", ["displayName"] = "本机验收账号", ["role"] = "super_admin", ["isAdmin"] = true } }.ToJsonString());
#endif
        repository = new ClientRepository(new LocalStore(directory), secrets, origin: origin);
        auth = new NativeAuth(repository, secrets); files = new NativeFiles(this);
        updates = new NativeUpdates(Path.Combine(directory, "updates"), activity);
        var preference = Path.Combine(directory, "auto-update.txt");
        if (File.Exists(preference) && bool.TryParse(File.ReadAllText(preference), out var saved)) autoRestart = saved;
        repository.StatusChanged += message => DispatcherQueue.TryEnqueue(() => SetStatus(message));
        repository.AccountChanged += () => { if (initialized) DispatcherQueue.TryEnqueue(async () => await RunAsync(AccountChangedAsync)); };
        var bar = new StackPanel { Orientation = Orientation.Horizontal, Spacing = 8, Padding = new Thickness(16, 8, 16, 8) };
        bar.Children.Add(new TextBlock { Text = "补位", FontSize = 22, Margin = new Thickness(0, 0, 12, 0), VerticalAlignment = VerticalAlignment.Center });
        bar.Children.Add(Button("同步与冲突", SynchronizeAsync)); bar.Children.Add(Button("保存项目供离线使用", PrepareAsync));
        bar.Children.Add(Button("录制与恢复", CaptureAsync)); bar.Children.Add(Button("检查更新", () => UpdateAsync(true)));
        var theme = new ComboBox { ItemsSource = new[] { "跟随系统", "浅色", "深色" }, SelectedIndex = 0, MinWidth = 110 };
        theme.SelectionChanged += (_, _) => layout.RequestedTheme = theme.SelectedIndex switch { 1 => ElementTheme.Light, 2 => ElementTheme.Dark, _ => ElementTheme.Default };
        bar.Children.Add(theme);
        bar.Children.Add(Button("退出登录", async () => { RequireSafe(); await repository.LogoutAsync(); SetStatus("已退出。本机草稿保留，重新授权同一账号后可继续。"); }));
        Grid.SetRow(content, 1); Grid.SetRow(status, 2); layout.Children.Add(bar); layout.Children.Add(content); layout.Children.Add(status);
        layout.Background = (Brush)Application.Current.Resources["ApplicationPageBackgroundThemeBrush"];
        Content = layout; AppWindow.Resize(new global::Windows.Graphics.SizeInt32(1440, 960));
        tray = new NativeTray(this);
        tray.ShowRequested += () => { hidden = false; hiddenAt = DateTimeOffset.MinValue; };
        tray.ExitRequested += async () => await RunAsync(async () => { RequireSafe(); exiting = true; if (media != null) await media.DisposeAsync(); Close(); });
        AppWindow.Closing += (_, args) => { if (!exiting) { args.Cancel = true; hidden = true; hiddenAt = DateTimeOffset.UtcNow; tray.HideWindow(); } };
        Closed += (_, _) => { timer.Stop(); notifications?.Dispose(); tray.Dispose(); repository.Dispose(); };
        timer.Tick += async (_, _) => await BackgroundAsync();
    }
    public async Task InitializeAsync(string arguments)
    {
        try { notifications = new NativeNotifications(); notifications.Activated += route => DispatcherQueue.TryEnqueue(async () => { tray.ShowWindow(); if (workspace != null) await workspace.NavigateAsync(route); }); }
        catch (Exception ex) { SetStatus("系统通知尚未就绪：" + ex.Message); }
        await RunAsync(async () => { await repository.RestoreAsync(); await AccountChangedAsync(); initialized = true; await HandleActivationAsync(arguments); });
        initialized = true; timer.Start();
    }
    private Button Button(string label, Func<Task> work)
    {
        var button = new Button { Content = label, VerticalAlignment = VerticalAlignment.Center };
        button.Click += async (_, _) => { button.IsEnabled = false; try { await RunAsync(work); } finally { button.IsEnabled = true; } }; return button;
    }
    private async Task RunAsync(Func<Task> work)
    { try { await work(); } catch (OperationCanceledException) { SetStatus("操作已取消"); } catch (Exception ex) { SetStatus(ex.Message, true); } }
    private void SetStatus(string message, bool error = false) { status.Message = message; status.Severity = error ? InfoBarSeverity.Warning : InfoBarSeverity.Informational; }
    private void RequireSafe()
    {
        activity.RequireIdle();
        if (workspace?.HasUnsavedChanges == true) throw new InvalidOperationException("当前页面有未保存内容或敏感输入，请先保存或清空后操作");
    }
    private async Task AccountChangedAsync()
    {
        seen.Clear(); seenAccount = null;
        if (media != null) { await media.DisposeAsync(); media = null; }
        if (repository.AccountId == null)
        {
            workspace = null;
            var panel = new StackPanel { Spacing = 20, MaxWidth = 620, Margin = new Thickness(40), VerticalAlignment = VerticalAlignment.Center, HorizontalAlignment = HorizontalAlignment.Center };
            panel.Children.Add(new TextBlock { Text = "把协作留给团队，把补位交给 AI", FontSize = 30, TextWrapping = TextWrapping.Wrap });
            panel.Children.Add(new TextBlock { Text = "Windows 原生工作区", FontSize = 20 });
            panel.Children.Add(new TextBlock { Text = "在系统浏览器中确认现有账号，即可打开项目、任务和资料。此版本独立安装，旧客户端的草稿和文件仍保留在原处。", TextWrapping = TextWrapping.Wrap, FontSize = 16 });
            panel.Children.Add(Button("使用现有账号登录", async () => { var uri = await auth.BeginAsync(); Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); SetStatus("请在浏览器确认登录，然后返回应用"); }));
            panel.Children.Add(new TextBlock { Text = "首次登录需要网络。完成离线准备后，可继续处理本机保存的内容。", TextWrapping = TextWrapping.Wrap });
            content.Content = new Border { Background = (Brush)Application.Current.Resources["CardBackgroundFillColorDefaultBrush"], BorderBrush = (Brush)Application.Current.Resources["CardStrokeColorDefaultBrush"], BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(16), Child = panel, MaxWidth = 780, Margin = new Thickness(32), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            SetStatus("首次使用请授权现有账号"); return;
        }
        media = new NativeMedia(Path.Combine(AccountDirectory(), "media"), activity);
        media.Failed += message => DispatcherQueue.TryEnqueue(() => SetStatus(message, true));
        workspace = new WorkspaceView(repository);
        workspace.StatusChanged += message => SetStatus(message);
        workspace.AddFileRequested = AddFileAsync; workspace.CaptureRequested = CaptureAsync; workspace.OpenAttachmentRequested = OpenAttachmentAsync;
        content.Content = workspace; await workspace.NavigateAsync("projects");
        SetStatus(repository.LastReadOffline ? "本机缓存版本" : "已连接现有项目服务");
    }
    private string AccountDirectory() => Path.Combine(repository.Store.DataDirectory, "accounts", ClientPaths.SafeSegment(repository.AccountId ?? throw new InvalidOperationException("请先登录")));
    public async Task HandleActivationAsync(string arguments)
    {
        if (arguments.Contains("--tray", StringComparison.Ordinal)) { hidden = true; hiddenAt = DateTimeOffset.UtcNow; tray.HideWindow(); return; }
        var candidate = arguments.Trim().Trim('"');
        if (Uri.TryCreate(candidate, UriKind.Absolute, out var uri) && uri.Scheme == "buwei-windows-native")
            await RunAsync(async () => { await auth.FinishAsync(uri); tray.ShowWindow(); });
        else if (!string.IsNullOrEmpty(arguments)) tray.ShowWindow();
    }
    private async Task SynchronizeAsync()
    {
        using var busy = activity.Enter("同步"); await repository.SyncAsync();
        var rows = await repository.Store.WritesAsync(); var panel = new StackPanel { Spacing = 12, Width = 560 };
        panel.Children.Add(new TextBlock { Text = rows.Count == 0 ? "所有修改均已提交至服务端" : $"本机保留 {rows.Count} 项待处理修改", TextWrapping = TextWrapping.Wrap });
        foreach (var row in rows)
        {
            var group = new StackPanel { Spacing = 6 };
            group.Children.Add(new TextBlock { Text = row.Status == "pending" ? "等待网络同步" : "需要人工核对：" + row.Error, TextWrapping = TextWrapping.Wrap });
            group.Children.Add(new TextBlock { Text = "本机修改：" + Summary(JsonNode.Parse(row.Body)), TextWrapping = TextWrapping.Wrap });
            if (row.Server != null) group.Children.Add(new TextBlock { Text = "服务端当前版本：" + Summary(JsonNode.Parse(row.Server)), TextWrapping = TextWrapping.Wrap });
            group.Children.Add(Button("导出本机修改", async () => { var file = await files.SaveAsync("补位-待同步修改", ".json"); if (file != null) await File.WriteAllTextAsync(file.Path, row.Body); }));
            panel.Children.Add(group);
        }
        await ShowAsync("同步与冲突", panel);
    }
    private static string Summary(JsonNode? node)
    {
        var text = new List<string>();
        void Visit(JsonNode? value)
        {
            if (value is JsonObject obj) foreach (var pair in obj) { if (pair.Value is JsonValue v && pair.Key is "text" or "title" or "message" or "revision" or "expectedRevision") text.Add(v.ToString()); else if (pair.Value is JsonObject or JsonArray) Visit(pair.Value); }
            else if (value is JsonArray array) foreach (var child in array) Visit(child);
        }
        Visit(node); var result = string.Join("；", text); return result.Length == 0 ? "完整结构已保留，可导出核对" : result[..Math.Min(3000, result.Length)];
    }
    private async Task PrepareAsync()
    {
        var project = workspace?.CurrentProjectId ?? throw new InvalidOperationException("请先打开一个项目");
        using var busy = activity.Enter("离线准备"); await repository.PrepareProjectAsync(project);
        SetStatus("项目文本已保存供离线使用；原文件需要另外下载");
    }
    private NativeTransfers Transfers() => new(repository.Http, Path.Combine(AccountDirectory(), "files"), activity);
    private async Task AddFileAsync()
    {
        var project = workspace?.CurrentProjectId ?? throw new InvalidOperationException("请先打开项目");
        var file = await files.PickAsync(); if (file != null) await ConfirmUploadAsync(project, file.Path, file.ContentType);
    }
    private async Task ConfirmUploadAsync(string project, string source, string contentType)
    {
        var account = repository.AccountId ?? throw new InvalidOperationException("请先登录"); var info = new FileInfo(source);
        var dialog = new ContentDialog { XamlRoot = layout.XamlRoot, Title = "确认上传原文件", Content = $"{info.Name}\n{info.Length / 1048576.0:F2} MiB\n不会自动调用 AI。", PrimaryButtonText = "上传", CloseButtonText = "保留在本机" };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
        using var busy = activity.Enter("文件暂存与上传");
        var owned = Path.Combine(AccountDirectory(), "files", "pending-" + Guid.NewGuid().ToString("N") + Path.GetExtension(source));
        Directory.CreateDirectory(Path.GetDirectoryName(owned)!);
        await using (var input = File.OpenRead(source)) await using (var output = File.Create(owned)) await input.CopyToAsync(output);
        if (account != repository.AccountId) throw new InvalidOperationException("账号已变化，文件保留在原账号目录");
        var created = await repository.SendAsync("POST", $"/projects/{project}/files", new JsonObject { ["fileName"] = info.Name, ["contentType"] = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType });
        var fileId = created?["fileId"]?.GetValue<string>() ?? throw new InvalidDataException("服务未分配文件");
        await Transfers().UploadAsync(project, fileId, owned, new Progress<double>(value => SetStatus($"上传进度 {value:P0}")));
        SetStatus("原文件上传完成，本机副本已保留");
    }
    private async Task CaptureAsync()
    {
        if (media == null) throw new InvalidOperationException("请先登录");
        var panel = new StackPanel { Spacing = 12, Width = 560 };
        var label = new TextBlock { Text = media.IsRecording ? "正在录制" : "录制先保存在本机，确认后才上传", TextWrapping = TextWrapping.Wrap }; panel.Children.Add(label);
        var microphones = await NativeMedia.DevicesAsync(false); var cameras = await NativeMedia.DevicesAsync(true);
        var microphone = new ComboBox { Header = "麦克风", ItemsSource = microphones.Select(x => x.Name).ToArray(), SelectedIndex = microphones.Count > 0 ? 0 : -1 };
        var camera = new ComboBox { Header = "摄像头", ItemsSource = cameras.Select(x => x.Name).ToArray(), SelectedIndex = cameras.Count > 0 ? 0 : -1 };
        panel.Children.Add(microphone); panel.Children.Add(camera);
        string? Mic() => microphone.SelectedIndex >= 0 ? microphones[microphone.SelectedIndex].Id : null;
        string? Cam() => camera.SelectedIndex >= 0 ? cameras[camera.SelectedIndex].Id : null;
        panel.Children.Add(Button("开始录音", async () => { await media.StartAsync(false, Mic()); label.Text = "正在录音，可关闭此面板继续"; }));
        panel.Children.Add(Button("开始录像", async () => { await media.StartAsync(true, Mic(), Cam()); label.Text = "正在录像，可关闭此面板继续"; }));
        panel.Children.Add(Button("拍照", async () => { var path = await media.PhotoAsync(Cam()); label.Text = "已保存：" + Path.GetFileName(path); }));
        panel.Children.Add(Button("停止并保留", async () => { await media.StopAsync(); label.Text = "已保存，请重新打开面板确认上传"; }));
        foreach (var path in media.RecoveryFiles()) panel.Children.Add(Button("本机文件：" + Path.GetFileName(path), async () => await ConfirmUploadAsync(workspace?.CurrentProjectId ?? throw new InvalidOperationException("请先选择项目"), path, path.EndsWith(".mp4") ? "video/mp4" : "audio/mp4")));
        await ShowAsync("录制与恢复", panel);
    }
    private async Task OpenAttachmentAsync(string project, string fileId)
    {
        var chosen = await files.SaveAsync("补位附件-" + fileId, ".bin"); if (chosen == null) return;
        using var busy = activity.Enter("附件下载"); await Transfers().DownloadAsync($"/api/v1/projects/{project}/files/{fileId}/content", chosen.Path); SetStatus("原文件已保存");
    }
    private async Task ShowAsync(string title, UIElement body) => await new ContentDialog { XamlRoot = layout.XamlRoot, Title = title, Content = new ScrollViewer { Content = body, MaxHeight = 550 }, CloseButtonText = "关闭" }.ShowAsync();
    private async Task UpdateAsync(bool interactive)
    {
        if (checkingUpdate) return; checkingUpdate = true;
        try
        {
            readyUpdate = await updates.CheckAsync(new Version(0, 1, 0));
            if (readyUpdate == null) { if (interactive) SetStatus("当前已是最新原生版本"); return; }
            readyInstaller = await updates.DownloadAsync(readyUpdate); SetStatus("更新已验签并缓存，等待安全重启");
            if (!interactive) return;
            var toggle = new ToggleSwitch { Header = "托盘安全空闲五分钟后自动安装", IsOn = autoRestart };
            toggle.Toggled += (_, _) => { autoRestart = toggle.IsOn; File.WriteAllText(Path.Combine(repository.Store.DataDirectory, "auto-update.txt"), autoRestart.ToString()); };
            await ShowAsync("原生客户端更新", new StackPanel { Spacing = 12, Children = { new TextBlock { Text = "新版本 " + readyUpdate.Version }, toggle, Button("重启并更新", async () => { RequireSafe(); updates.Install(readyInstaller, readyUpdate); exiting = true; Close(); await Task.CompletedTask; }) } });
        }
        finally { checkingUpdate = false; nextUpdate = DateTimeOffset.UtcNow.AddHours(6); }
    }
    private async Task BackgroundAsync()
    {
        if (polling) return; polling = true;
        try
        {
            if (repository.AccountId != null)
            {
                await repository.SyncAsync(); var account = repository.AccountId;
                var settings = await repository.GetAsync("/notifications/settings"); var data = await repository.GetAsync("/notifications?limit=100");
                if (account != repository.AccountId) return;
                var first = seenAccount != account; if (first) { seen.Clear(); seenAccount = account; }
                var fresh = new List<JsonNode>();
                foreach (var row in data?["items"]?.AsArray() ?? []) if (row?["id"]?.GetValue<string>() is { } id && seen.Add(id) && !first && row["readAt"] == null && row["dismissedAt"] == null) fresh.Add(row);
                if (seen.Count > 2000) { seen.Clear(); foreach (var row in data?["items"]?.AsArray() ?? []) if (row?["id"]?.GetValue<string>() is { } id) seen.Add(id); }
                if (fresh.Count > 0 && settings?["pushEnabled"]?.GetValue<bool>() == true) notifications?.Show("补位", $"收到 {fresh.Count} 条新通知", fresh[0]["url"]?.GetValue<string>() ?? "/app/profile/settings/notifications");
            }
            if (!Environment.GetCommandLineArgs().Contains("--benchmark") && DateTimeOffset.UtcNow >= nextUpdate) await UpdateAsync(false);
            if (hidden && autoRestart && readyInstaller != null && readyUpdate != null && DateTimeOffset.UtcNow - hiddenAt >= TimeSpan.FromMinutes(5) && activity.CanRestart && (await repository.Store.WritesAsync()).Count == 0)
            { RequireSafe(); updates.Install(readyInstaller, readyUpdate); exiting = true; Close(); }
        }
        catch (Exception ex) { SetStatus("后台操作暂未完成：" + ex.Message); }
        finally { polling = false; }
    }
}
