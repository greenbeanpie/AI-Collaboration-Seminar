using System.Text.Json.Nodes;
using Windows.Devices.Enumeration;
using Windows.Media.Capture;
using Windows.Media.Devices;
using Windows.Media.MediaProperties;
using Windows.Storage;

namespace Buwei.Windows.Platform;

/// <summary>Capture is local only. Upload always requires an explicit separate user action.</summary>
public sealed class NativeMedia(string accountDirectory, ActivityGate activity) : IAsyncDisposable
{
    private MediaCapture? capture;
    private IDisposable? lease;
    private string? journal;
    private readonly SemaphoreSlim operations = new(1, 1);
    private CancellationTokenSource? segmentCancellation;
    private readonly List<string> segments = [];
    private readonly List<string> completedSegments = [];
    private bool recordingVideo;
    private string? recordingId;
    private StorageFolder? recordingFolder;
    public bool IsRecording { get; private set; }
    public bool IsPaused { get; private set; }
    public string? CurrentPath { get; private set; }
    public IReadOnlyList<string> SegmentPaths => segments.ToArray();
    public event Action<IReadOnlyList<string>>? SegmentsChanged;
    public event Action<string>? Failed;
    public static async Task<IReadOnlyList<(string Id, string Name)>> DevicesAsync(bool video)
    {
        var devices = await DeviceInformation.FindAllAsync(video ? DeviceClass.VideoCapture : DeviceClass.AudioCapture);
        return devices.Select(d => (d.Id, d.Name)).ToList();
    }
    public async Task StartAsync(bool video, string? audioDeviceId = null, string? videoDeviceId = null)
    {
        await operations.WaitAsync();
        try
        {
        if (capture is not null) throw new InvalidOperationException("录制正在进行，请先停止。");
        Directory.CreateDirectory(accountDirectory);
        recordingVideo = video; recordingId = Guid.NewGuid().ToString("N"); segments.Clear(); completedSegments.Clear(); IsPaused = false;
        recordingFolder = await StorageFolder.GetFolderFromPathAsync(Path.GetFullPath(accountDirectory));
        var file = await CreateSegmentAsync();
        CurrentPath = file.Path;
        journal = Path.Combine(accountDirectory, $"capture-{recordingId}.recovery.json");
        await WriteJournalAsync("initializing");
        capture = new MediaCapture();
        capture.Failed += OnFailed;
        try
        {
            var settings = new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = video ? StreamingCaptureMode.AudioAndVideo : StreamingCaptureMode.Audio,
                SharingMode = MediaCaptureSharingMode.ExclusiveControl,
                AudioDeviceId = audioDeviceId ?? "",
                VideoDeviceId = videoDeviceId ?? ""
            };
            await capture.InitializeAsync(settings);
            lease = activity.Enter(video ? "录像" : "录音");
            await capture.StartRecordToStorageFileAsync(video ? MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto) : MediaEncodingProfile.CreateM4a(AudioEncodingQuality.High), file);
            IsRecording = true;
            await WriteJournalAsync("recording");
            segmentCancellation = new CancellationTokenSource();
            _ = RotateSegmentsAsync(segmentCancellation.Token);
        }
        catch
        {
            await DisposeCaptureAsync();
            await WriteJournalAsync("interrupted");
            throw;
        }
        }
        finally { operations.Release(); }
    }
    public async Task<string?> StopAsync()
    {
        segmentCancellation?.Cancel();
        await operations.WaitAsync();
        try
        {
            if (capture is not null && IsRecording) { await capture.StopRecordAsync(); if (CurrentPath is not null) completedSegments.Add(CurrentPath); }
            IsRecording = false; IsPaused = false;
            await WriteJournalAsync("awaiting_confirmation");
            return CurrentPath;
        }
        catch
        {
            await WriteJournalAsync("interrupted");
            throw;
        }
        finally { await DisposeCaptureAsync(); operations.Release(); }
    }
    public async Task PauseAsync()
    {
        await operations.WaitAsync();
        try
        {
            if (capture is null || !IsRecording || IsPaused) return;
            await capture.PauseRecordAsync(MediaCapturePauseBehavior.RetainHardwareResources);
            IsPaused = true; await WriteJournalAsync("paused");
        }
        finally { operations.Release(); }
    }
    public async Task ResumeAsync()
    {
        await operations.WaitAsync();
        try
        {
            if (capture is null || !IsRecording || !IsPaused) return;
            await capture.ResumeRecordAsync(); IsPaused = false; await WriteJournalAsync("recording");
        }
        finally { operations.Release(); }
    }
    private async Task<StorageFile> CreateSegmentAsync()
    {
        var file = await recordingFolder!.CreateFileAsync($"capture-{recordingId}-{segments.Count + 1:D4}.{(recordingVideo ? "mp4" : "m4a")}", CreationCollisionOption.FailIfExists);
        segments.Add(file.Path); return file;
    }
    private async Task RotateSegmentsAsync(CancellationToken ct)
    {
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));
            while (await timer.WaitForNextTickAsync(ct))
            {
                await operations.WaitAsync(ct);
                try
                {
                    if (capture is null || !IsRecording) return;
                    if (IsPaused) continue;
                    await capture.StopRecordAsync();
                    if (CurrentPath is not null) completedSegments.Add(CurrentPath);
                    await WriteJournalAsync("rotating"); // Every prior segment is now finalized.
                    var next = await CreateSegmentAsync(); CurrentPath = next.Path;
                    await WriteJournalAsync("initializing_segment");
                    await capture.StartRecordToStorageFileAsync(recordingVideo ? MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Auto) : MediaEncodingProfile.CreateM4a(AudioEncodingQuality.High), next);
                    await WriteJournalAsync("recording"); SegmentsChanged?.Invoke(SegmentPaths);
                }
                finally { operations.Release(); }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception error)
        {
            await operations.WaitAsync();
            string? journalError = null;
            try { await WriteJournalAsync("interrupted"); }
            catch (Exception recoveryError) when (recoveryError is IOException or UnauthorizedAccessException) { journalError = recoveryError.Message; }
            finally { await DisposeCaptureAsync(); operations.Release(); }
            Failed?.Invoke("分段录制已停止，先前片段已保留：" + error.Message + (journalError is null ? "" : "；恢复记录写入失败：" + journalError));
        }
    }
    public async Task<string> PhotoAsync(string? videoDeviceId = null)
    {
        if (capture is not null) throw new InvalidOperationException("请先停止正在进行的录制。");
        Directory.CreateDirectory(accountDirectory);
        using var pending = activity.Enter("拍照");
        using var camera = new MediaCapture();
        await camera.InitializeAsync(new MediaCaptureInitializationSettings { StreamingCaptureMode = StreamingCaptureMode.Video, VideoDeviceId = videoDeviceId ?? "" });
        var folder = await StorageFolder.GetFolderFromPathAsync(Path.GetFullPath(accountDirectory));
        var file = await folder.CreateFileAsync($"photo-{Guid.NewGuid():N}.jpg");
        await camera.CapturePhotoToStorageFileAsync(ImageEncodingProperties.CreateJpeg(), file);
        return file.Path;
    }
    public IReadOnlyList<string> RecoveryFiles() => Directory.Exists(accountDirectory)
        ? Directory.GetFiles(accountDirectory, "*.recovery.json").Where(p => new FileInfo(p).Length < 64 * 1024).ToArray() : [];
    private async void OnFailed(MediaCapture sender, MediaCaptureFailedEventArgs args)
    {
        // Do not claim the media container is finalized after device loss.
        string? journalError = null;
        await operations.WaitAsync();
        try { await WriteJournalAsync("interrupted"); }
        catch (IOException error) { journalError = error.Message; }
        catch (UnauthorizedAccessException error) { journalError = error.Message; }
        finally { await DisposeCaptureAsync(); operations.Release(); }
        Failed?.Invoke(journalError is null ? args.Message : args.Message + "；恢复记录保存失败：" + journalError);
    }
    private async Task WriteJournalAsync(string state)
    {
        if (journal is null) return;
        var node = new JsonObject { ["path"] = CurrentPath, ["recordingId"] = recordingId, ["state"] = state, ["segments"] = new JsonArray(segments.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()), ["completedSegments"] = new JsonArray(completedSegments.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray()), ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"), ["segmentBoundaryNotice"] = "分段切换会有短暂设备切换间隙；前序片段独立保存。" };
        var temporary = journal + ".tmp";
        await File.WriteAllTextAsync(temporary, node.ToJsonString());
        File.Move(temporary, journal, true);
    }
    private Task DisposeCaptureAsync()
    {
        if (capture is not null) { capture.Failed -= OnFailed; capture.Dispose(); capture = null; }
        segmentCancellation?.Cancel(); segmentCancellation?.Dispose(); segmentCancellation = null;
        IsRecording = false; IsPaused = false;
        lease?.Dispose(); lease = null;
        return Task.CompletedTask;
    }
    public async ValueTask DisposeAsync()
    {
        if (IsRecording) await StopAsync();
        else await DisposeCaptureAsync();
    }
}
