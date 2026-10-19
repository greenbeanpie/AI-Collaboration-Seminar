using System.Text.Json.Nodes;
using Windows.Devices.Enumeration;
using Windows.Media.Capture;
using Windows.Media.MediaProperties;
using Windows.Storage;

namespace Buwei.Windows.Platform;

/// <summary>Capture is local only. Upload always requires an explicit separate user action.</summary>
public sealed class NativeMedia(string accountDirectory, ActivityGate activity) : IAsyncDisposable
{
    private MediaCapture? capture;
    private IDisposable? lease;
    private string? journal;
    public bool IsRecording { get; private set; }
    public string? CurrentPath { get; private set; }
    public event Action<string>? Failed;
    public static async Task<IReadOnlyList<(string Id, string Name)>> DevicesAsync(bool video)
    {
        var devices = await DeviceInformation.FindAllAsync(video ? DeviceClass.VideoCapture : DeviceClass.AudioCapture);
        return devices.Select(d => (d.Id, d.Name)).ToList();
    }
    public async Task StartAsync(bool video, string? audioDeviceId = null, string? videoDeviceId = null)
    {
        if (capture is not null) throw new InvalidOperationException("录制正在进行，请先停止。");
        Directory.CreateDirectory(accountDirectory);
        var folder = await StorageFolder.GetFolderFromPathAsync(Path.GetFullPath(accountDirectory));
        var file = await folder.CreateFileAsync($"capture-{DateTime.UtcNow:yyyyMMdd-HHmmss}-{Guid.NewGuid():N}.{(video ? "mp4" : "m4a")}", CreationCollisionOption.FailIfExists);
        CurrentPath = file.Path;
        journal = file.Path + ".recovery.json";
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
        }
        catch
        {
            await DisposeCaptureAsync();
            await WriteJournalAsync("interrupted");
            throw;
        }
    }
    public async Task<string?> StopAsync()
    {
        try
        {
            if (capture is not null && IsRecording) await capture.StopRecordAsync();
            IsRecording = false;
            await WriteJournalAsync("awaiting_confirmation");
            return CurrentPath;
        }
        catch
        {
            await WriteJournalAsync("interrupted");
            throw;
        }
        finally { await DisposeCaptureAsync(); }
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
        try { await WriteJournalAsync("interrupted"); }
        catch (IOException error) { journalError = error.Message; }
        catch (UnauthorizedAccessException error) { journalError = error.Message; }
        finally { await DisposeCaptureAsync(); }
        Failed?.Invoke(journalError is null ? args.Message : args.Message + "；恢复记录保存失败：" + journalError);
    }
    private async Task WriteJournalAsync(string state)
    {
        if (journal is null) return;
        var node = new JsonObject { ["path"] = CurrentPath, ["state"] = state, ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O") };
        var temporary = journal + ".tmp";
        await File.WriteAllTextAsync(temporary, node.ToJsonString());
        File.Move(temporary, journal, true);
    }
    private Task DisposeCaptureAsync()
    {
        if (capture is not null) { capture.Failed -= OnFailed; capture.Dispose(); capture = null; }
        IsRecording = false;
        lease?.Dispose(); lease = null;
        return Task.CompletedTask;
    }
    public async ValueTask DisposeAsync()
    {
        if (IsRecording) await StopAsync();
        else await DisposeCaptureAsync();
    }
}
