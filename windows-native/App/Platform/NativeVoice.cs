using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Buwei.Windows.Core;
using Windows.Media;
using Windows.Media.Audio;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using WinRT;

namespace Buwei.Windows.Platform;

public sealed record NativeVoiceState(string Phase = "idle", string Partial = "", string Transcript = "", string Notice = "", DateTimeOffset RetryAfter = default);

/// <summary>Matches the rehearsal PCM16/16kHz mono websocket protocol. No offline or automatic reconnect.</summary>
public sealed class NativeVoice(ClientRepository repository, string projectId, string rehearsalId, ActivityGate activity) : IAsyncDisposable
{
    private readonly string prefix = $"/api/v1/projects/{Guid.Parse(projectId)}/rehearsals/{Guid.Parse(rehearsalId)}";
    private readonly string? owner = repository.AccountId;
    private CancellationTokenSource? lifetime;
    private ClientWebSocket? socket;
    private AudioGraph? graph;
    private AudioDeviceInputNode? input;
    private AudioFrameOutputNode? output;
    private IDisposable? lease;
    private Channel<byte[]>? frames;
    private Task? sending;
    private Task? receiving;
    private string? sessionId;
    private int audioSequence;
    private long audioBytes;
    private readonly HashSet<int> seen = [];
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private bool finalizing;
    private long lastAudio;
    private bool heardAudio;
    private int starting;
    private int releasing;
    public NativeVoiceState State { get; private set; } = new();
    public event Action<NativeVoiceState>? Changed;
    private bool Owned => owner is not null && repository.AccountId == owner;
    private void Update(NativeVoiceState state) { State = state; Changed?.Invoke(state); }
    public static string StreamPath(string returnedPath, string prefix, string sessionId)
    {
        if (!Guid.TryParse(sessionId, out _) || returnedPath != $"{prefix}/voice-sessions/{sessionId}/stream") throw new InvalidDataException("语音服务返回了无效的私有资源路径。");
        NativeTransfers.RequireApiPath(returnedPath); return returnedPath;
    }
    public async Task StartAsync(int sequence)
    {
        if (Interlocked.CompareExchange(ref starting, 1, 0) != 0) throw new InvalidOperationException("语音正在准备，请稍候。");
        try { await StartCoreAsync(sequence); }
        finally { Interlocked.Exchange(ref starting, 0); }
    }
    private async Task StartCoreAsync(int sequence)
    {
        if (!Owned) throw new InvalidOperationException("请重新登录后打开答辩。");
        if (State.Phase != "idle" || DateTimeOffset.UtcNow < State.RetryAfter) throw new InvalidOperationException("语音正在进行或处于重试冷却期。");
        if (State.Transcript.Length >= 64000) throw new InvalidOperationException("请先整理已确认字幕，再重新进入本页继续。");
        var readiness = await repository.GetAsync(prefix + "/voice");
        if (readiness?["ready"]?.GetValue<bool>() != true || readiness?["mode"]?.GetValue<string>() != "voice-with-text-fallback") throw new InvalidOperationException(readiness?["reason"]?.GetValue<string>() ?? "当前未启用实时语音，可继续文字回答。");
        lifetime?.Dispose(); lifetime = new CancellationTokenSource(); var ct = lifetime.Token;
        repository.AccountChanged += AccountChanged;
        seen.Clear(); audioSequence = 0; audioBytes = 0; finalizing = false; heardAudio = false;
        Update(State with { Phase = "connecting", Partial = "", Notice = "正在连接；语音转录可能产生平台用量。" });
        try
        {
            lease = activity.Enter("实时语音");
            await InitializeMicrophoneAsync();
            EnsureOwned(); ct.ThrowIfCancellationRequested();
            var result = await repository.SendAsync("POST", prefix + "/voice-sessions", new JsonObject { ["sequence"] = sequence }, false, ct);
            sessionId = result?["sessionId"]?.GetValue<string>() ?? throw new InvalidDataException("未返回语音会话。");
            var path = StreamPath(result!["webSocketPath"]!.GetValue<string>(), prefix, sessionId);
            EnsureOwned(); ct.ThrowIfCancellationRequested();
            var origin = repository.Http.BaseAddress!;
            var uri = new UriBuilder(new Uri(origin, path)) { Scheme = origin.Scheme == "https" ? "wss" : "ws" }.Uri;
            socket = new ClientWebSocket();
            // HttpClient's fixed-origin handler carries the existing session cookies. No token copy or URL credential.
            using (var connecting = CancellationTokenSource.CreateLinkedTokenSource(ct))
            { connecting.CancelAfter(TimeSpan.FromSeconds(15)); await socket.ConnectAsync(uri, repository.Http, connecting.Token); }
            lastAudio = Environment.TickCount64;
            receiving = ReceiveAsync(ct);
            _ = WatchdogAsync(ct);
        }
        catch (Exception error) when (error is not OperationCanceledException || !ct.IsCancellationRequested)
        { await FailAsync(error.Message); }
    }
    private async Task InitializeMicrophoneAsync()
    {
        // AudioGraph operates on Float32 even when PCM is requested. Convert explicitly at the transport boundary.
        var encoding = AudioEncodingProperties.CreatePcm(16000, 1, 32); encoding.Subtype = MediaEncodingSubtypes.Float;
        var result = await AudioGraph.CreateAsync(new AudioGraphSettings(global::Windows.Media.Render.AudioRenderCategory.Speech)
        { EncodingProperties = encoding, QuantumSizeSelectionMode = QuantumSizeSelectionMode.ClosestToDesired, DesiredSamplesPerQuantum = 1600 });
        if (result.Status != AudioGraphCreationStatus.Success) throw new InvalidOperationException("无法创建原生音频图：" + result.Status);
        graph = result.Graph;
        var device = await graph.CreateDeviceInputNodeAsync(MediaCategory.Speech, encoding);
        if (device.Status != AudioDeviceNodeCreationStatus.Success) throw new InvalidOperationException("无法访问麦克风：" + device.Status);
        input = device.DeviceInputNode;
        output = graph.CreateFrameOutputNode(encoding); input.AddOutgoingConnection(output);
        if (output.EncodingProperties.SampleRate != 16000 || output.EncodingProperties.ChannelCount != 1 || output.EncodingProperties.BitsPerSample != 32)
            throw new InvalidDataException("麦克风无法提供 16kHz 单声道 Float32 音频。");
        frames = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(5) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
        graph.QuantumStarted += QuantumStarted;
        graph.UnrecoverableErrorOccurred += GraphFailed;
    }
    private void GraphFailed(AudioGraph sender, AudioGraphUnrecoverableErrorOccurredEventArgs args) => _ = Task.Run(() => FailAsync("音频设备断开：" + args.Error));
    private void QuantumStarted(AudioGraph sender, object args)
    {
        if (finalizing || output is null || frames is null) return;
        try
        {
            using var frame = output.GetFrame(); using var buffer = frame.LockBuffer(AudioBufferAccessMode.Read); using var reference = buffer.CreateReference();
            reference.As<IMemoryBufferByteAccess>().GetBuffer(out var pointer, out var capacity);
            var length = checked((int)Math.Min(buffer.Length, capacity));
            if (length <= 0) return;
            if (length > 64000 || length % 4 != 0) throw new InvalidDataException("麦克风 Float32 帧长度无效。");
            var samples = new float[length / 4]; Marshal.Copy(pointer, samples, 0, samples.Length);
            var bytes = FloatToPcm16(samples);
            if (!frames.Writer.TryWrite(bytes)) throw new IOException("音频发送阻塞，已停止录音。");
        }
        catch (Exception error) { if (lifetime?.IsCancellationRequested == false) _ = Task.Run(() => FailAsync(error.Message)); }
    }
    public static byte[] FloatToPcm16(ReadOnlySpan<float> samples)
    {
        var bytes = new byte[samples.Length * 2];
        for (var index = 0; index < samples.Length; index++)
        {
            var sample = float.IsFinite(samples[index]) ? Math.Clamp(samples[index], -1f, 1f) : 0f;
            var pcm = (short)Math.Clamp((int)Math.Round(sample * 32768f), short.MinValue, short.MaxValue);
            System.Buffers.Binary.BinaryPrimitives.WriteInt16LittleEndian(bytes.AsSpan(index * 2, 2), pcm);
        }
        return bytes;
    }
    private async Task SendAudioAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var bytes in frames!.Reader.ReadAllAsync(ct))
            {
                EnsureOwned();
                audioBytes += bytes.Length;
                if (audioBytes > 32000L * 600) throw new InvalidOperationException("本轮达到服务端十分钟语音额度，可整理字幕后继续文字回答。");
                for (var i = 0; i + 1 < bytes.Length; i += 2) if (Math.Abs((int)(short)(bytes[i] | bytes[i + 1] << 8)) > 100) { heardAudio = true; break; }
                await SendAsync(new JsonObject { ["type"] = "audio", ["sequence"] = ++audioSequence, ["data"] = Convert.ToBase64String(bytes) }, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error) { if (!ct.IsCancellationRequested) await FailAsync(error.Message); }
    }
    private async Task ReceiveAsync(CancellationToken ct)
    {
        try
        {
            var buffer = new byte[8192];
            while (!ct.IsCancellationRequested)
            {
                EnsureOwned(); using var message = new MemoryStream(); WebSocketReceiveResult part;
                do
                {
                    part = await socket!.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                    if (part.MessageType != WebSocketMessageType.Text) throw new IOException("语音连接已关闭或返回非文本消息。");
                    if (message.Length + part.Count > 256 * 1024) throw new InvalidDataException("语音消息过大。");
                    message.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);
                var evt = JsonNode.Parse(message.ToArray()) ?? throw new InvalidDataException("语音消息为空。");
                switch (evt["type"]?.GetValue<string>())
                {
                    case "ready":
                        if (State.Phase != "connecting") break;
                        await SendAsync(new JsonObject { ["type"] = "start" }, ct);
                        Update(State with { Phase = "recording", Notice = "正在录音；停止后核对字幕再手动提交。" });
                        lastAudio = Environment.TickCount64; sending = SendAudioAsync(ct); graph!.Start(); break;
                    case "partial":
                        var partial = evt["text"]!.GetValue<string>(); ValidateText(partial);
                        Update(State with { Partial = partial }); break;
                    case "final":
                        var sequence = evt["sequence"]!.GetValue<int>();
                        if (sequence < 1) throw new InvalidDataException("最终字幕序号无效。");
                        if (!seen.Add(sequence)) break;
                        var text = evt["text"]!.GetValue<string>().Trim(); ValidateText(text);
                        var transcript = string.Join("\n", new[] { State.Transcript, text }.Where(x => !string.IsNullOrWhiteSpace(x)));
                        if (transcript.Length > 64000) throw new InvalidDataException("已确认字幕过长，请整理后继续。");
                        Update(State with { Partial = "", Transcript = transcript }); break;
                    case "complete":
                        await ReleaseAsync(); Update(State with { Phase = "idle", Partial = "", Notice = "转录完成，请核对和编辑字幕后手动提交。", RetryAfter = default }); return;
                    case "error": throw new IOException(evt["message"]?.GetValue<string>() ?? "实时转录失败。");
                    default: throw new InvalidDataException("语音服务返回了不支持的消息。");
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error) { if (!ct.IsCancellationRequested) await FailAsync(error.Message); }
    }
    private static void ValidateText(string text) { if (text.Length > 8000) throw new InvalidDataException("字幕内容过长。"); }
    public async Task StopAsync()
    {
        if (State.Phase != "recording") return;
        finalizing = true; StopMicrophone(); frames?.Writer.TryComplete();
        Update(State with { Phase = "finalizing", Notice = "等待最终字幕。" }); lastAudio = Environment.TickCount64;
        try { if (sending is not null) await sending; await SendAsync(new JsonObject { ["type"] = "stop" }, lifetime!.Token); }
        catch (Exception error) { if (lifetime?.IsCancellationRequested == false) await FailAsync(error.Message); }
    }
    private async Task SendAsync(JsonObject message, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct); deadline.CancelAfter(TimeSpan.FromSeconds(5));
        await sendLock.WaitAsync(deadline.Token);
        try { await socket!.SendAsync(Encoding.UTF8.GetBytes(message.ToJsonString()), WebSocketMessageType.Text, true, deadline.Token); }
        finally { sendLock.Release(); }
    }
    private async Task WatchdogAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(250, ct); EnsureOwned();
                if (Environment.TickCount64 - lastAudio > 15000 && (State.Phase is "connecting" or "finalizing" || !heardAudio)) { await FailAsync("语音连接或音频等待超过 15 秒。"); return; }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error) { if (!ct.IsCancellationRequested) await FailAsync(error.Message); }
    }
    private void AccountChanged() => _ = CancelAsync();
    private void EnsureOwned() { if (!Owned) throw new InvalidOperationException("账户已变化，语音已停止。"); }
    private async Task FailAsync(string message)
    {
        await ReleaseAsync(); Update(State with { Phase = "idle", Partial = "", Notice = message + " 可继续文字回答；已确认字幕已保留。", RetryAfter = DateTimeOffset.UtcNow.AddMinutes(1) });
    }
    public async Task CancelAsync()
    { await ReleaseAsync(); Update(State with { Phase = "idle", Partial = "", Notice = "录音已取消；已确认字幕已保留。" }); }
    private void StopMicrophone()
    {
        if (graph is not null) { graph.QuantumStarted -= QuantumStarted; graph.UnrecoverableErrorOccurred -= GraphFailed; graph.Stop(); }
        input?.Dispose(); input = null; output?.Dispose(); output = null; graph?.Dispose(); graph = null;
    }
    private async Task ReleaseAsync()
    {
        if (Interlocked.Exchange(ref releasing, 1) != 0) return;
        try
        {
        repository.AccountChanged -= AccountChanged;
        var previous = Interlocked.Exchange(ref sessionId, null);
        lifetime?.Cancel(); finalizing = true; StopMicrophone(); frames?.Writer.TryComplete();
        socket?.Abort(); socket?.Dispose(); socket = null; lease?.Dispose(); lease = null;
        if (previous is not null && Owned)
        {
            using var closeDeadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await repository.SendAsync("POST", prefix + "/voice-sessions/" + previous + "/close", new JsonObject(), false, closeDeadline.Token); }
            catch (Exception error) when (error is HttpRequestException or OperationCanceledException or ApiException or InvalidOperationException) { /* Local microphone/socket are released even if server close cannot be confirmed. */ }
        }
        }
        finally { Interlocked.Exchange(ref releasing, 0); }
    }
    public async ValueTask DisposeAsync()
    {
        await CancelAsync();
        if (receiving is not null) await receiving;
        if (sending is not null) await sending;
        lifetime?.Dispose();
    }
    [ComImport, Guid("5B0D3235-4DBA-4D44-8656-1D76F6B698A8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMemoryBufferByteAccess { void GetBuffer(out nint buffer, out uint capacity); }
}
