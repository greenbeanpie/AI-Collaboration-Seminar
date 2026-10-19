using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Buwei.Windows.Views;

public sealed partial class WorkspaceView : UserControl
{
    private readonly ClientRepository repository;
    private readonly NavigationView navigation = new() { IsBackButtonVisible = NavigationViewBackButtonVisible.Collapsed, IsSettingsVisible = false,
        PaneDisplayMode = NavigationViewPaneDisplayMode.Left, OpenPaneLength = 218, CompactModeThresholdWidth = 900, ExpandedModeThresholdWidth = 1150 };
    private readonly Grid surface = new();
    private CancellationTokenSource pageLifetime = new();
    private string currentRoute = "projects";
    private string? projectId;
    private JsonNode? project;
    private JsonNode? membership;
    private bool active;
    private long accountGeneration;
    private Func<Task>? saveCurrentDraft;
    private readonly List<Task> draftWrites = [];
    private bool draftDirty;
    private bool sensitiveInput;
    public bool HasUnsavedChanges => draftDirty || sensitiveInput || draftWrites.Any(x => !x.IsCompletedSuccessfully);
    public async Task<bool> SaveBeforeCloseAsync()
    {
        if (sensitiveInput) return false;
        try { if (draftDirty && saveCurrentDraft != null) await saveCurrentDraft(); await Task.WhenAll(draftWrites); draftWrites.Clear(); draftDirty = false; return true; }
        catch (Exception e) { StatusChanged?.Invoke("本机草稿尚未保存：" + e.Message); return false; }
    }
    private CancellationToken PageToken => pageLifetime.Token;
    private string Base => "/projects/" + Escape(projectId ?? throw new InvalidOperationException("请先选择项目"));
    public event Action<string>? StatusChanged;

    public WorkspaceView(ClientRepository repository)
    {
        this.repository = repository;
        navigation.PaneHeader = Ui.Stack(Ui.Heading("补位"), Ui.Label("项目协作 · Windows", 12));
        navigation.Content = surface;
        navigation.ItemInvoked += async (_, e) => { if (e.InvokedItemContainer?.Tag is string route) await NavigateAsync(route); };
        Content = navigation;
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
        BuildNavigation();
    }
    private void OnLoaded(object sender, RoutedEventArgs e)
    {
        if (active) return;
        active = true;
        repository.AccountChanged += AccountChanged;
    }
    private void OnUnloaded(object sender, RoutedEventArgs e)
    {
        active = false;
        repository.AccountChanged -= AccountChanged;
        pageLifetime.Cancel();
    }
    private void AccountChanged()
    {
        Interlocked.Increment(ref accountGeneration);
        pageLifetime.Cancel();
        DispatcherQueue.TryEnqueue(() => { saveCurrentDraft = null; draftWrites.Clear(); draftDirty = false; sensitiveInput = false; projectId = null; project = null; membership = null; surface.Children.Clear(); BuildNavigation(); _ = NavigateAsync("projects"); });
    }
    private void BuildNavigation()
    {
        navigation.MenuItems.Clear(); navigation.FooterMenuItems.Clear();
        Add("我的项目", "projects", Symbol.Home);
        Add("加入团队", "join", Symbol.AddFriend);
        if (projectId != null)
        {
            navigation.MenuItems.Add(new NavigationViewItemSeparator());
            navigation.MenuItems.Add(new NavigationViewItemHeader { Content = project.Text("name") });
            foreach (var item in new[] { ("项目概览", "overview", Symbol.View), ("任务协作", "tasks", Symbol.Accept),
                ("项目资料", "data", Symbol.Document), ("团队成员", "team", Symbol.People), ("标准与评估", "assessment", Symbol.Favorite),
                ("项目 AI", "ai", Symbol.Message), ("答辩演练", "rehearsals", Symbol.Microphone), ("项目活动", "activity", Symbol.Clock), ("成果导出", "export", Symbol.Download), ("项目设置", "project-settings", Symbol.Setting) }) Add(item.Item1, item.Item2, item.Item3);
        }
        Add("通知", "notifications", Symbol.Message, true);
        Add("Agent Bridge", "bridge", Symbol.Link, true);
        Add("账户与安全", "account", Symbol.Contact, true);
        Add("帮助与工单", "support", Symbol.Help, true);
        if (repository.User.Text("role") is "admin" or "super_admin") Add("系统管理", "admin", Symbol.Admin, true);
        void Add(string title, string route, Symbol icon, bool footer = false)
        { var item = new NavigationViewItem { Content = title, Tag = route, Icon = new SymbolIcon(icon) }; if (footer) navigation.FooterMenuItems.Add(item); else navigation.MenuItems.Add(item); }
    }
    public async Task NavigateAsync(string route)
    {
        if (!await SaveBeforeCloseAsync()) { StatusChanged?.Invoke("请先完成或清空当前敏感输入，或处理本机草稿保存错误后再切换页面。"); return; }
        saveCurrentDraft = null;
        pageLifetime.Cancel(); pageLifetime.Dispose(); pageLifetime = new CancellationTokenSource();
        var token = PageToken;
        var generation = accountGeneration;
        currentRoute = route;
        surface.Children.Clear();
        surface.Children.Add(new ProgressRing { IsActive = true, Width = 36, Height = 36 });
        try
        {
            if (repository.AccountId == null) { Show(Ui.Stack(Ui.Heading("欢迎使用补位"), Ui.Label("请先使用窗口顶部的登录按钮授权此客户端。")), token); return; }
            if (route.StartsWith("/app/")) route = route[5..];
            if (route is "/app" or "app" or "") route = "projects";
            route = route switch { "profile" or "profile/settings" => "account", "profile/settings/notifications" => "notifications", "profile/settings/security" => "account", "profile/settings/personal-profile" => "personal-profile", _ => route };
            if (route.StartsWith("projects/"))
            {
                var parts = route.Split('/');
                projectId = Uri.UnescapeDataString(parts[1]);
                project = await repository.GetAsync(Base, token); membership = await repository.GetAsync(Base + "/members/me", token);
                token.ThrowIfCancellationRequested(); BuildNavigation();
                route = parts.Length > 2 ? parts[2] : "overview";
                if (route == "tasks" && parts.Length > 3) { Show(await TaskDetailAsync(parts[3], token), token); return; }
            }
            if (projectId == null && route is "overview" or "tasks" or "data" or "team" or "assessment" or "ai" or "activity" or "project-settings" or "rehearsals" or "export") route = "projects";
            var content = route switch
            {
                "projects" or "dashboard" => await DashboardAsync(token), "create-project" => await CreateProjectAsync(token),
                "join" => await JoinAsync(token), "overview" => await OverviewAsync(token), "tasks" => await TasksAsync(token),
                "data" or "materials" or "sources" => await DataAsync(token), "team" => await TeamAsync(token),
                "assessment" or "assessments" or "reviews" => await AssessmentAsync(token), "ai" or "ai-chat" => await AiAsync(token),
                "activity" or "ledger" => await ActivityAsync(token), "project-settings" => await ProjectSettingsAsync(token),
                "rehearsals" or "rehearsal" => await RehearsalsAsync(token), "export" => await ExportAsync(token),
                "account" or "settings" => await AccountAsync(token), "personal-profile" => await PersonalProfileAsync(token), "notifications" => await NotificationsAsync(token),
                "support" or "help" => await SupportAsync(token), "bridge" or "agent-bridges" => await BridgeAsync(token),
                "admin" => await AdminAsync(token), _ => Ui.Stack(Ui.Heading("暂不支持此入口"), Ui.Label("请从侧栏选择当前原生客户端已提供的页面。"))
            };
            if (generation == accountGeneration) Show(content, token);
        }
        catch (OperationCanceledException) { }
        catch (Exception error) { if (!token.IsCancellationRequested) Show(Ui.Stack(Ui.Heading("页面暂不可用"), Ui.Label(error.Message), Ui.Button("重新读取", () => NavigateAsync(currentRoute))), token); }
    }
    private void Show(UIElement content, CancellationToken token)
    { token.ThrowIfCancellationRequested(); surface.Children.Clear(); surface.Children.Add(Ui.Scroll(content)); }
    private static string Escape(string id) => Uri.EscapeDataString(id);
    private bool Can(string key) => membership.Text("role") == "owner" || membership?["permissions"].Flag(key) == true;
    private StackPanel Page(string title, string description) => Ui.Stack(Ui.Heading(title), Ui.Label(description), Ui.Button("刷新", () => NavigateAsync(currentRoute)));
    private Button Action(string title, Func<Task> work, string? confirmation = null, bool primary = false)
    {
        var owner = repository.AccountId;
        var generation = accountGeneration;
        var lifetime = PageToken;
        return Ui.Button(title, async () =>
        {
            try
            {
                lifetime.ThrowIfCancellationRequested();
                if (owner != repository.AccountId || generation != accountGeneration) return;
                if (confirmation != null)
                {
                    var dialog = new ContentDialog { Title = title, Content = confirmation, PrimaryButtonText = "确认", CloseButtonText = "取消", XamlRoot = XamlRoot, DefaultButton = ContentDialogButton.Close };
                    if (await dialog.ShowAsync() != ContentDialogResult.Primary) return;
                }
                lifetime.ThrowIfCancellationRequested();
                if (owner != repository.AccountId || generation != accountGeneration) return;
                await work();
            }
            catch (OperationCanceledException) { }
            catch (Exception error)
            {
                if (lifetime.IsCancellationRequested || owner != repository.AccountId || generation != accountGeneration) return;
                StatusChanged?.Invoke(error.Message);
                await new ContentDialog { Title = "操作未完成", Content = error.Message + "\n填写内容仍保留。提交结果不明时，请先刷新核对服务端记录，再决定是否重试。", CloseButtonText = "知道了", XamlRoot = XamlRoot }.ShowAsync();
            }
        }, primary);
    }
    private async Task<JsonNode?> WriteAsync(string method, string path, JsonNode? body = null, bool offline = false)
    { var result = await repository.SendAsync(method, path, body, offline, PageToken); StatusChanged?.Invoke("请求已处理，请以页面刷新后的服务端状态为准。"); return result; }
    private async Task AddPagedAsync(StackPanel parent, string path, Func<JsonNode, UIElement> row, CancellationToken token)
    {
        var list = new StackPanel { Spacing = 12 };
        parent.Children.Add(list);
        var more = Ui.Button("加载更多", () => Task.CompletedTask);
        string? cursor = null;
        var seenCursors = new HashSet<string>(); var seenRows = new HashSet<string>();
        async Task LoadAsync()
        {
            var page = await repository.GetAsync(path + (cursor == null ? "" : (path.Contains('?') ? "&" : "?") + "cursor=" + Escape(cursor)), token);
            token.ThrowIfCancellationRequested();
            var next = page.Text("nextCursor");
            if (next.Length > 0 && !seenCursors.Add(next)) throw new InvalidOperationException("分页游标重复，请刷新页面后重试。");
            var rows = page.Rows();
            foreach (var item in rows) { var id = item.Id("id", "taskId", "resourceId", "userId", "materialId", "assessmentId", "reviewId", "standardId", "sessionId"); if (id.Length == 0 || seenRows.Add(id)) list.Children.Add(row(item)); }
            if (list.Children.Count == 0) list.Children.Add(Ui.Label("当前没有记录。"));
            cursor = next.Length == 0 ? null : next;
            more.Visibility = cursor == null ? Visibility.Collapsed : Visibility.Visible;
        }
        more.Click += async (_, _) => { more.IsEnabled = false; try { await LoadAsync(); } catch (OperationCanceledException) { } catch (Exception e) { StatusChanged?.Invoke(e.Message); } finally { more.IsEnabled = true; } };
        parent.Children.Add(more);
        await LoadAsync();
    }
    private async Task OpenProjectAsync(string id)
    { await NavigateAsync("projects/" + Escape(id)); }
    private async Task ReplaceAsync(Func<CancellationToken, Task<UIElement>> render)
    { if (!await SaveBeforeCloseAsync()) return; saveCurrentDraft = null; var token = PageToken; var content = await render(token); Show(content, token); }
    private void TrackDraft(string key, Func<JsonNode> content, params Control[] fields)
    {
        var owner = repository.AccountId; var generation = accountGeneration;
        async Task SaveAsync()
        {
            if (owner != repository.AccountId || generation != accountGeneration) return;
            await repository.Store.SaveDraftAsync(key, content()); draftDirty = false;
        }
        var previous = saveCurrentDraft;
        saveCurrentDraft = async () => { if (previous != null) await previous(); await SaveAsync(); };
        void Changed()
        {
            if (owner != repository.AccountId || generation != accountGeneration) return;
            draftDirty = true; RegisterDraftWrite(SaveAsync());
        }
        foreach (var field in fields)
        {
            if (field is TextBox text) text.TextChanged += (_, _) => Changed();
            if (field is ComboBox combo) combo.SelectionChanged += (_, _) => Changed();
            if (field is ToggleSwitch toggle) toggle.Toggled += (_, _) => Changed();
            if (field is CheckBox check) { check.Checked += (_, _) => Changed(); check.Unchecked += (_, _) => Changed(); }
        }
    }
    private void RegisterDraftWrite(Task pending)
    {
        var generation = accountGeneration; draftWrites.Add(pending); _ = ObserveAsync();
        async Task ObserveAsync()
        {
            try { await pending; }
            catch (Exception error) { if (generation == accountGeneration) { draftDirty = true; StatusChanged?.Invoke("本机草稿尚未保存：" + error.Message); } }
            finally { draftWrites.Remove(pending); }
        }
    }
}
