using System.Text.Json.Nodes;
using Buwei.Windows.Core;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Media.Core;
using Windows.Media.Playback;
using Windows.Media.SpeechSynthesis;

namespace Buwei.Windows.Platform;

/// <summary>Dedicated rehearsal voice screen. User starts transcription and separately confirms each answer.</summary>
public sealed class NativeVoiceView : UserControl
{
    private readonly ClientRepository repository;
    private readonly NativeVoice voice;
    private readonly string prefix;
    private readonly TextBlock question = new() { TextWrapping = TextWrapping.Wrap, FontSize = 18 };
    private readonly TextBlock notice = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly TextBlock partial = new() { TextWrapping = TextWrapping.Wrap, Opacity = 0.7 };
    private readonly TextBlock confirmed = new() { TextWrapping = TextWrapping.Wrap, IsTextSelectionEnabled = true };
    private readonly TextBox answer = new() { Header = "核对和编辑回答（最多 8000 字）", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 160, MaxLength = 8000 };
    private readonly Button start = new() { Content = "开始语音回答" };
    private readonly Button stop = new() { Content = "停止并完成转录", IsEnabled = false };
    private readonly Button cancel = new() { Content = "取消并转文字", IsEnabled = false };
    private readonly Button submit = new() { Content = "确认提交回答" };
    private readonly Button refresh = new() { Content = "刷新答辩状态" };
    private readonly MediaPlayer speaker = new();
    private readonly SpeechSynthesizer synthesizer = new();
    private SpeechSynthesisStream? speechStream;
    private readonly ActivityGate activity;
    private readonly string draftPath;
    private readonly SemaphoreSlim draftWrites = new(1, 1);
    private IDisposable? dirty;
    private string lastTranscript = "";
    private int sequence;
    private bool canAnswer, voiceReady, submitting, uncertain, unloaded;
    public NativeVoiceView(ClientRepository repository, string projectId, string rehearsalId, ActivityGate activity)
    {
        this.repository = repository; this.activity = activity;
        var account = repository.AccountId ?? throw new InvalidOperationException("请先登录。");
        draftPath = Path.Combine(repository.Store.DataDirectory, "accounts", ClientPaths.SafeSegment(account), "voice-drafts", Guid.Parse(rehearsalId) + ".json");
        prefix = $"/api/v1/projects/{Guid.Parse(projectId)}/rehearsals/{Guid.Parse(rehearsalId)}";
        voice = new NativeVoice(repository, projectId, rehearsalId, activity);
        var panel = new StackPanel { Spacing = 12, Padding = new Thickness(24) };
        panel.Children.Add(new TextBlock { Text = "原生语音答辩", FontSize = 26 });
        panel.Children.Add(new TextBlock { Text = "实时转录 → 核对文字 → 手动提交。问题使用设备本地朗读；语音失败后可继续文字回答。", TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(question);
        var speak = new Button { Content = "本地朗读问题" };
        var silence = new Button { Content = "停止朗读" };
        speak.Click += async (_, _) => await RunAsync(SpeakAsync);
        silence.Click += (_, _) => StopSpeech();
        foreach (var button in new[] { speak, silence, start, stop, cancel }) panel.Children.Add(button);
        panel.Children.Add(notice); panel.Children.Add(partial); panel.Children.Add(confirmed); panel.Children.Add(answer);
        panel.Children.Add(submit); panel.Children.Add(refresh);
        Content = new ScrollViewer { Content = panel, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        voice.Changed += OnState;
        start.Click += async (_, _) => await RunAsync(async () => { StopSpeech(); await voice.StartAsync(sequence); });
        stop.Click += async (_, _) => await RunAsync(voice.StopAsync);
        cancel.Click += async (_, _) => await RunAsync(voice.CancelAsync);
        submit.Click += async (_, _) => await RunAsync(SubmitAsync);
        refresh.Click += async (_, _) => await RunAsync(RefreshAsync);
        answer.TextChanged += async (_, _) =>
        {
            UpdateDirty(); Buttons();
            await PersistDraftAsync();
        };
        Loaded += async (_, _) => await RunAsync(async () =>
        {
            if (File.Exists(draftPath))
            {
                var saved = JsonNode.Parse(await File.ReadAllTextAsync(draftPath));
                uncertain = saved?["uncertain"]?.GetValue<bool>() ?? false;
                answer.Text = saved?["answer"]?.GetValue<string>() ?? "";
            }
            await RefreshAsync();
        });
        Unloaded += async (_, _) =>
        {
            unloaded = true; StopSpeech(); voice.Changed -= OnState;
            await voice.DisposeAsync(); await PersistDraftAsync(); speaker.Dispose(); synthesizer.Dispose();
        };
        Buttons();
    }
    private async Task RunAsync(Func<Task> action)
    {
        try { await action(); }
        catch (Exception error) { if (!unloaded) notice.Text = error.Message + " 可继续文字回答。"; }
        finally { if (!unloaded) Buttons(); }
    }
    private void OnState(NativeVoiceState state)
    {
        DispatcherQueue.TryEnqueue(() =>
        {
            if (unloaded) return;
            notice.Text = state.Notice; partial.Text = state.Partial.Length == 0 ? "" : "临时字幕（未写入回答）：" + state.Partial;
            confirmed.Text = state.Transcript.Length == 0 ? "" : "已确认字幕（供核对）：\n" + state.Transcript;
            if (state.Transcript.StartsWith(lastTranscript, StringComparison.Ordinal))
            {
                var added = state.Transcript[lastTranscript.Length..].Trim();
                if (added.Length != 0)
                {
                    var combined = string.Join("\n", new[] { answer.Text, added }.Where(x => !string.IsNullOrWhiteSpace(x)));
                    answer.Text = combined[..Math.Min(8000, combined.Length)];
                }
            }
            lastTranscript = state.Transcript; Buttons();
        });
    }
    private void UpdateDirty()
    {
        if (answer.Text.Length > 0 && dirty is null) dirty = activity.Enter("未提交的答辩文字");
        else if (answer.Text.Length == 0) { dirty?.Dispose(); dirty = null; }
    }
    private async Task PersistDraftAsync()
    {
        // Capture UI values before awaiting; account-bound path never changes when the repository switches accounts.
        var text = answer.Text;
        var node = new JsonObject { ["answer"] = text, ["uncertain"] = uncertain, ["sequence"] = sequence };
        await draftWrites.WaitAsync();
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(draftPath)!);
            await File.WriteAllTextAsync(draftPath + ".tmp", node.ToJsonString());
            File.Move(draftPath + ".tmp", draftPath, true);
            if (answer.Text == text) { dirty?.Dispose(); dirty = null; }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        { if (!unloaded) notice.Text = "回答尚未保存到本机，请先复制文字：" + error.Message; }
        finally { draftWrites.Release(); }
    }
    private void Buttons()
    {
        var busy = voice.State.Phase != "idle";
        start.IsEnabled = canAnswer && voiceReady && !busy && !submitting && !uncertain && DateTimeOffset.UtcNow >= voice.State.RetryAfter;
        stop.IsEnabled = voice.State.Phase == "recording";
        cancel.IsEnabled = busy;
        answer.IsEnabled = !busy && !submitting;
        submit.IsEnabled = canAnswer && !busy && !submitting && !uncertain && !string.IsNullOrWhiteSpace(answer.Text);
        refresh.IsEnabled = !busy && !submitting;
    }
    private async Task RefreshAsync()
    {
        var detail = await repository.GetAsync(prefix);
        var readiness = await repository.GetAsync(prefix + "/voice");
        if (unloaded) return;
        var turns = detail?["turns"]?.AsArray() ?? [];
        var latest = turns.OrderByDescending(t => t?["sequence"]?.GetValue<int>() ?? 0).FirstOrDefault();
        var nextSequence = latest?["sequence"]?.GetValue<int>() ?? 0;
        if (nextSequence != sequence) { await voice.CancelAsync(); StopSpeech(); }
        sequence = nextSequence;
        question.Text = latest?["content"]?.GetValue<string>() ?? "尚未生成问题，请返回答辩列表刷新。";
        canAnswer = detail?["canOperate"]?.GetValue<bool>() == true && detail?["status"]?.GetValue<string>() == "active"
            && latest?["kind"]?.GetValue<string>() is "question" or "followup"
            && detail?["processingStatus"]?.GetValue<string>() is not ("queued" or "running" or "waiting_input");
        voiceReady = readiness?["ready"]?.GetValue<bool>() == true && readiness?["mode"]?.GetValue<string>() == "voice-with-text-fallback";
        if (uncertain && turns.Any(t => t?["kind"]?.GetValue<string>() == "answer" && t?["content"]?.GetValue<string>() == answer.Text.Trim())) { uncertain = false; answer.Text = ""; }
        notice.Text = uncertain ? "上次提交结果尚未确认；不会自动再次发送。请刷新核对服务端轮次。"
            : voiceReady ? "点击开始后才会连接语音服务，可能产生平台用量。" : readiness?["reason"]?.GetValue<string>() ?? "当前未启用实时语音，请使用文字回答。";
    }
    private async Task SubmitAsync()
    {
        if (!submit.IsEnabled) return;
        submitting = true; Buttons(); StopSpeech();
        try
        {
            var previous = sequence;
            await RefreshAsync();
            if (!canAnswer || sequence != previous) throw new InvalidOperationException("答辩轮次或权限已变化，请重新核对。");
            try { await repository.SendAsync("POST", prefix + "/answers", new JsonObject { ["content"] = answer.Text.Trim() }); }
            catch { uncertain = true; await PersistDraftAsync(); throw; }
            answer.Text = ""; uncertain = false;
            await RefreshAsync();
        }
        finally { submitting = false; Buttons(); }
    }
    private async Task SpeakAsync()
    {
        if (voice.State.Phase != "idle") throw new InvalidOperationException("请先停止语音录音。");
        StopSpeech();
        var chinese = SpeechSynthesizer.AllVoices.FirstOrDefault(v => v.Language.StartsWith("zh", StringComparison.OrdinalIgnoreCase));
        if (chinese is null) throw new InvalidOperationException("本机未安装中文语音，请直接阅读问题。");
        synthesizer.Voice = chinese;
        speechStream = await synthesizer.SynthesizeTextToStreamAsync(question.Text[..Math.Min(question.Text.Length, 4000)]);
        speaker.Source = MediaSource.CreateFromStream(speechStream, speechStream.ContentType); speaker.Play();
    }
    private void StopSpeech() { speaker.Pause(); speaker.Source = null; speechStream?.Dispose(); speechStream = null; }
}
