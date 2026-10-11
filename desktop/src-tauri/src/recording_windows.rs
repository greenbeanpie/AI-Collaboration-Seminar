//! Media Foundation capture stays independent of WebView lifecycle.
use crate::{
    recording::{self, CaptureControl, RecordingState, Segment, Snapshot},
    NativeState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use windows::{
    core::{Interface, HSTRING, PCWSTR},
    Win32::{
        Media::MediaFoundation::*,
        System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED},
    },
};
type Result<T> = std::result::Result<T, String>;
type CaptureSource = (IMFMediaSource, IMFSourceReader, Vec<(u32, IMFMediaType)>);
fn ensure_space(dir: &Path) -> Result<()> {
    let path: Vec<u16> = dir
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut available = 0;
    unsafe {
        windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            PCWSTR(path.as_ptr()),
            Some(&mut available),
            None,
            None,
        )
        .map_err(err)?;
    }
    if available < 64 * 1024 * 1024 {
        return Err("存储空间不足；已完成片段保留".into());
    }
    Ok(())
}
struct Apartment;
impl Apartment {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(err)?;
            MFStartup(MF_VERSION, MFSTARTUP_FULL).map_err(err)?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
fn err(e: windows::core::Error) -> String {
    format!("原生采集失败：{e}；请检查系统相机/麦克风权限和设备")
}
unsafe fn attributes() -> windows::core::Result<IMFAttributes> {
    let mut a = None;
    unsafe {
        MFCreateAttributes(&mut a, 8)?;
    }
    a.ok_or_else(windows::core::Error::empty)
}
unsafe fn string(a: &IMFAttributes, key: &windows::core::GUID) -> windows::core::Result<String> {
    unsafe {
        let n = a.GetStringLength(key)?;
        let mut b = vec![0; n as usize + 1];
        a.GetString(key, &mut b, None)?;
        Ok(String::from_utf16_lossy(&b[..n as usize]))
    }
}
struct Device {
    id: String,
    label: String,
    kind: &'static str,
    activate: IMFActivate,
}
unsafe fn devices() -> windows::core::Result<Vec<Device>> {
    unsafe {
        let mut result = vec![];
        for (ty, key, kind) in [
            (
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_GUID,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_AUDCAP_ENDPOINT_ID,
                "audioinput",
            ),
            (
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID,
                MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK,
                "videoinput",
            ),
        ] {
            let a = attributes()?;
            a.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &ty)?;
            let mut ptr = std::ptr::null_mut();
            let mut count = 0;
            MFEnumDeviceSources(&a, &mut ptr, &mut count)?;
            if !ptr.is_null() {
                let items = std::slice::from_raw_parts_mut(ptr, count as usize);
                for activate in items.iter_mut().filter_map(Option::take) {
                    let attrs = activate.cast::<IMFAttributes>()?;
                    result.push(Device {
                        id: string(&attrs, &key)?,
                        label: string(&attrs, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME)?,
                        kind,
                        activate,
                    });
                }
                CoTaskMemFree(Some(ptr.cast()));
            }
        }
        Ok(result)
    }
}
pub fn capabilities() -> Result<Value> {
    let _com = Apartment::new()?;
    let devices = unsafe { devices().map_err(err)? };
    let audio = devices.iter().any(|d| d.kind == "audioinput");
    let video = devices.iter().any(|d| d.kind == "videoinput");
    Ok(
        json!({"audio":audio,"video":audio&&video,"photo":video,"background":true,"devices":devices.iter().map(|d|json!({"id":d.id,"label":d.label,"kind":d.kind})).collect::<Vec<_>>() }),
    )
}
pub async fn start(
    app: AppHandle,
    account: String,
    project: String,
    id: String,
    kind: String,
    audio: Option<String>,
    video: Option<String>,
) -> Result<Value> {
    let command = Arc::new(AtomicUsize::new(0));
    let devices = Arc::new(std::sync::Mutex::new(None));
    {
        let state = app.state::<RecordingState>();
        let mut active = state.active.lock().map_err(|_| "录制状态忙")?;
        if active.is_some() {
            return Err("已有录制会话，请先停止".into());
        }
        *active = Some(CaptureControl {
            account_id: account.clone(),
            id: id.clone(),
            command: command.clone(),
            devices: devices.clone(),
        });
    }
    app.state::<NativeState>()
        .active_recordings
        .store(1, Ordering::SeqCst);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let task_app = app.clone();
    let task_id = id.clone();
    let task_owner = account.clone();
    std::thread::spawn(move || {
        let mut s = Snapshot {
            id: task_id.clone(),
            account_id: task_owner.clone(),
            project_id: project,
            kind: kind.clone(),
            state: "recording".into(),
            created_at: time::OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default(),
            elapsed_ms: 0,
            segments: vec![],
            interruptions: vec![],
            incomplete_files: vec![],
            error: None,
        };
        let result = run(
            &task_app,
            &mut s,
            &command,
            audio.as_deref(),
            video.as_deref(),
            tx,
            &devices,
        );
        s.state = if result.is_ok() {
            "stopped"
        } else {
            "interrupted"
        }
        .into();
        if let Err(e) = result {
            s.error = Some(e);
        }
        if let Err(e) = recording::persist(&task_app, &s) {
            crate::runtime::diagnostic(&task_app, "capture persistence", &e);
        }
        task_app
            .state::<NativeState>()
            .active_recordings
            .store(0, Ordering::SeqCst);
        let state = task_app.state::<RecordingState>();
        if let Ok(mut active) = state.active.lock() {
            if active.as_ref().is_some_and(|a| a.id == task_id) {
                *active = None;
            }
        };
        crate::runtime::dispatch(
            &task_app,
            "recording-refresh",
            json!({"projectId":s.project_id}),
        );
    });
    match rx.await {
        Ok(result) => result,
        Err(_) => Err("采集线程中断；请检查已保存草稿".into()),
    }
}
pub fn stop_for_account_change(app: &AppHandle) {
    if let Ok(active) = app.state::<RecordingState>().active.lock() {
        if let Some(a) = active.as_ref() {
            a.command.store(2, Ordering::SeqCst);
        }
    }
}
pub async fn action(
    app: &AppHandle,
    owner: &str,
    _project: &str,
    id: &str,
    action: &str,
    audio: Option<String>,
    video: Option<String>,
) -> Result<()> {
    let command = {
        let state = app.state::<RecordingState>();
        let active = state.active.lock().map_err(|_| "录制状态忙")?;
        let a = active
            .as_ref()
            .filter(|a| a.account_id == owner && a.id == id)
            .ok_or("该会话已经停止")?;
        if action == "resume" {
            let snapshot = recording::load(app, owner, _project, id)?;
            if snapshot.state != "paused" {
                return Err("请先暂停，再切换设备".into());
            }
            if audio.is_some() || video.is_some() {
                *a.devices.lock().map_err(|_| "设备状态忙")? = Some((audio, video));
            }
        }
        a.command.clone()
    };
    let value = match action {
        "pause" => 1,
        "resume" => 0,
        "stop" | "photo" => 2,
        _ => return Err("无效操作".into()),
    };
    command.store(value, Ordering::SeqCst);
    for _ in 0..100 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let active = app
            .state::<RecordingState>()
            .active
            .lock()
            .map_err(|_| "录制状态忙")?
            .is_some();
        if !active {
            return Ok(());
        }
        if value != 2 {
            let path = recording::directory(app, owner, id)?.join("manifest.json");
            if let Ok(b) = std::fs::read(path) {
                if let Ok(s) = serde_json::from_slice::<Snapshot>(&b) {
                    if (value == 1 && s.state == "paused") || (value == 0 && s.state == "recording")
                    {
                        return Ok(());
                    }
                }
            }
        }
    }
    Err("设备仍在完成片段保存，请稍后刷新；录制状态未强制重置".into())
}
struct Writer {
    sink: IMFSinkWriter,
    tracks: Vec<(u32, u32)>,
    start_ms: u64,
    bytes: u64,
    sequence: u32,
    name: String,
}
unsafe fn writer(
    dir: &Path,
    kind: &str,
    inputs: &[(u32, IMFMediaType)],
    sequence: u32,
    start_ms: u64,
) -> windows::core::Result<Writer> {
    unsafe {
        let name = format!(
            "segment-{sequence}.{}",
            if kind == "audio" { "m4a" } else { "mp4" }
        );
        let path: Vec<u16> = dir
            .join(&name)
            .to_string_lossy()
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let attrs = attributes()?;
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        let sink = MFCreateSinkWriterFromURL(PCWSTR(path.as_ptr()), None, &attrs)?;
        let mut tracks = vec![];
        for (index, input) in inputs {
            let output = MFCreateMediaType()?;
            let major = input.GetGUID(&MF_MT_MAJOR_TYPE)?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &major)?;
            if major == MFMediaType_Audio {
                output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
                output.SetUINT32(
                    &MF_MT_AUDIO_NUM_CHANNELS,
                    input.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS)?,
                )?;
                output.SetUINT32(
                    &MF_MT_AUDIO_SAMPLES_PER_SECOND,
                    input.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND)?,
                )?;
                output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 12000)?;
                output.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
                output.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29)?;
            } else {
                output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
                for key in [MF_MT_FRAME_SIZE, MF_MT_FRAME_RATE, MF_MT_PIXEL_ASPECT_RATIO] {
                    output.SetUINT64(&key, input.GetUINT64(&key)?)?;
                }
                output.SetUINT32(&MF_MT_AVG_BITRATE, 1_500_000)?;
                output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            }
            let stream = sink.AddStream(&output)?;
            sink.SetInputMediaType(stream, input, None)?;
            tracks.push((*index, stream));
        }
        sink.BeginWriting()?;
        Ok(Writer {
            sink,
            tracks,
            start_ms,
            bytes: 0,
            sequence,
            name,
        })
    }
}
fn finish(app: &AppHandle, s: &mut Snapshot, w: Writer, end_ms: u64) -> Result<()> {
    unsafe {
        w.sink.Finalize().map_err(err)?;
    }
    let dir = recording::directory(app, &s.account_id, &s.id)?;
    let path = dir.join(&w.name);
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size == 0 || size > 50 * 1024 * 1024 {
        return Err("片段大小异常；原文件保留待导出".into());
    }
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sha.update(&b[..n]);
    }
    s.segments.push(Segment {
        sequence: w.sequence,
        name: w.name,
        size_bytes: size,
        start_ms: w.start_ms,
        end_ms,
        sha256: format!("{:x}", sha.finalize()),
        file_id: None,
    });
    s.elapsed_ms = end_ms;
    recording::persist(app, s)
}
fn run(
    app: &AppHandle,
    s: &mut Snapshot,
    command: &AtomicUsize,
    audio: Option<&str>,
    video: Option<&str>,
    ready: tokio::sync::oneshot::Sender<Result<Value>>,
    devices: &std::sync::Mutex<Option<(Option<String>, Option<String>)>>,
) -> Result<()> {
    let _com = match Apartment::new() {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let dir = recording::directory(app, &s.account_id, &s.id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ensure_space(&dir)?;
    if s.kind == "photo" {
        let result = photo(&dir, video);
        if let Ok(seg) = result.as_ref() {
            s.segments.push(seg.clone());
            s.state = "stopped".into();
            recording::persist(app, s)?;
        }
        let _ = ready.send(result.as_ref().map(|_| json!(s)).map_err(Clone::clone));
        return result.map(|_| ());
    }
    let prepared = unsafe { prepare(s, audio, video) };
    let (mut source, mut reader, mut inputs) = match prepared {
        Ok(p) => p,
        Err(e) => {
            let e = err(e);
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    let mut w = match unsafe { writer(&dir, &s.kind, &inputs, 1, 0) } {
        Ok(w) => Some(w),
        Err(e) => {
            let e = err(e);
            let _ = ready.send(Err(e.clone()));
            unsafe {
                let _ = source.Shutdown();
            }
            return Err(e);
        }
    };
    recording::persist(app, s)?;
    let _ = ready.send(Ok(json!(s)));
    let clock = Instant::now();
    let mut timestamps: std::collections::HashMap<u32, (i64, u64)> =
        std::collections::HashMap::new();
    let mut pause_start = None;
    let mut checkpoint = 0;
    let result: Result<()> = unsafe {
        (|| {
            loop {
                let elapsed = clock.elapsed().as_millis() as u64;
                let mode = command.load(Ordering::SeqCst);
                if mode == 2 {
                    break;
                }
                if mode == 1 {
                    if s.state != "paused" {
                        if let Some(old) = w.take() {
                            finish(app, s, old, elapsed)?;
                        }
                        s.state = "paused".into();
                        pause_start = Some(elapsed);
                        recording::persist(app, s)?;
                    }
                } else if s.state == "paused" {
                    if let Some((audio, video)) = devices.lock().map_err(|_| "设备状态忙")?.take()
                    {
                        source.Shutdown().map_err(err)?;
                        let (next_source, next_reader, next_inputs) = prepare(
                            s,
                            audio.as_deref().filter(|s| !s.is_empty()),
                            video.as_deref().filter(|s| !s.is_empty()),
                        )
                        .map_err(err)?;
                        source = next_source;
                        reader = next_reader;
                        inputs = next_inputs;
                        timestamps.clear();
                    }
                    let elapsed = clock.elapsed().as_millis() as u64;
                    let start = pause_start.take().unwrap_or(elapsed);
                    s.interruptions
                        .push(json!({"startMs":start,"endMs":elapsed,"reason":"用户暂停"}));
                    s.state = "recording".into();
                    w = Some(
                        writer(&dir, &s.kind, &inputs, s.segments.len() as u32 + 1, elapsed)
                            .map_err(err)?,
                    );
                    recording::persist(app, s)?;
                }
                let mut index = 0;
                let mut flags = 0;
                let mut stamp = 0;
                let mut sample = None;
                reader
                    .ReadSample(
                        MF_SOURCE_READER_ANY_STREAM.0 as u32,
                        0,
                        Some(&mut index),
                        Some(&mut flags),
                        Some(&mut stamp),
                        Some(&mut sample),
                    )
                    .map_err(err)?;
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    return Err("采集设备结束输出".into());
                }
                if mode == 1 {
                    continue;
                }
                let Some(sample) = sample else {
                    continue;
                };
                let now = clock.elapsed().as_millis() as u64;
                let (origin, offset) = *timestamps.entry(index).or_insert((stamp, now));
                let timeline = offset * 10000 + (stamp - origin).max(0) as u64;
                let current = w.as_mut().ok_or("编码器不可用")?;
                let Some((_, track)) = current.tracks.iter().find(|(i, _)| *i == index) else {
                    continue;
                };
                sample
                    .SetSampleTime(timeline.saturating_sub(current.start_ms * 10000) as i64)
                    .map_err(err)?;
                current.sink.WriteSample(*track, &sample).map_err(err)?;
                current.bytes += sample.GetTotalLength().map_err(err)? as u64;
                let size = std::fs::metadata(dir.join(&current.name))
                    .map(|m| m.len())
                    .unwrap_or(0);
                if now - current.start_ms >= 300000 || size >= 30 * 1024 * 1024 {
                    let next =
                        writer(&dir, &s.kind, &inputs, current.sequence + 1, now).map_err(err)?;
                    let old = w.replace(next).ok_or("编码器不可用")?;
                    finish(app, s, old, now)?;
                }
                s.elapsed_ms = now;
                if now.saturating_sub(checkpoint) >= 1000 {
                    ensure_space(&dir)?;
                    recording::persist(app, s)?;
                    checkpoint = now;
                }
            }
            Ok(())
        })()
    };
    let end = clock.elapsed().as_millis() as u64;
    let saved = if let Some(old) = w.take() {
        finish(app, s, old, end)
    } else {
        Ok(())
    };
    if let Some(start) = pause_start {
        s.interruptions
            .push(json!({"startMs":start,"endMs":end,"reason":"用户暂停"}));
    }
    unsafe {
        let _ = source.Shutdown();
    }
    result.and(saved)
}
unsafe fn prepare(
    s: &Snapshot,
    audio: Option<&str>,
    video: Option<&str>,
) -> windows::core::Result<CaptureSource> {
    unsafe {
        let devices = devices()?;
        let sources = MFCreateCollection()?;
        for (kind, id) in [("audioinput", audio), ("videoinput", video)] {
            if kind == "videoinput" && s.kind == "audio"
                || kind == "audioinput" && s.kind == "photo"
            {
                continue;
            }
            let device = devices
                .iter()
                .find(|d| d.kind == kind && id.is_none_or(|v| v.is_empty() || v == d.id))
                .ok_or_else(windows::core::Error::empty)?;
            let source: IMFMediaSource = device.activate.ActivateObject()?;
            sources.AddElement(&source)?;
        }
        let source = MFCreateAggregateSource(&sources)?;
        let attrs = attributes()?;
        attrs.SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)?;
        let reader = MFCreateSourceReaderFromMediaSource(&source, &attrs)?;
        reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        let mut inputs = vec![];
        for i in 0..16 {
            let Ok(native) = reader.GetNativeMediaType(i, 0) else {
                break;
            };
            let major = native.GetGUID(&MF_MT_MAJOR_TYPE)?;
            if major != MFMediaType_Audio && major != MFMediaType_Video {
                continue;
            }
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &major)?;
            if major == MFMediaType_Audio {
                input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
                input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1)?;
                input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000)?;
                input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2)?;
                input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 96000)?;
            } else {
                input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
                input.SetUINT64(&MF_MT_FRAME_SIZE, (1280u64 << 32) | 720)?;
                input.SetUINT64(&MF_MT_FRAME_RATE, (30u64 << 32) | 1)?;
            }
            reader.SetCurrentMediaType(i, None, &input)?;
            reader.SetStreamSelection(i, true)?;
            inputs.push((i, reader.GetCurrentMediaType(i)?));
        }
        if inputs.is_empty() {
            return Err(windows::core::Error::empty());
        }
        Ok((source, reader, inputs))
    }
}
fn photo(dir: &Path, video: Option<&str>) -> Result<Segment> {
    use windows::{
        Media::{
            Capture::{MediaCapture, MediaCaptureInitializationSettings, StreamingCaptureMode},
            MediaProperties::ImageEncodingProperties,
        },
        Storage::{CreationCollisionOption, StorageFolder},
    };
    let settings = MediaCaptureInitializationSettings::new().map_err(err)?;
    settings
        .SetStreamingCaptureMode(StreamingCaptureMode::Video)
        .map_err(err)?;
    if let Some(id) = video.filter(|s| !s.is_empty()) {
        settings.SetVideoDeviceId(&HSTRING::from(id)).map_err(err)?;
    }
    let capture = MediaCapture::new().map_err(err)?;
    capture
        .InitializeWithSettingsAsync(&settings)
        .map_err(err)?
        .join()
        .map_err(err)?;
    let result = (|| {
        let folder =
            StorageFolder::GetFolderFromPathAsync(&HSTRING::from(dir.to_string_lossy().as_ref()))
                .map_err(err)?
                .join()
                .map_err(err)?;
        let name = "segment-1.jpg";
        let file = folder
            .CreateFileAsync(&HSTRING::from(name), CreationCollisionOption::FailIfExists)
            .map_err(err)?
            .join()
            .map_err(err)?;
        let props = ImageEncodingProperties::CreateJpeg().map_err(err)?;
        props.SetWidth(1920).map_err(err)?;
        props.SetHeight(1080).map_err(err)?;
        capture
            .CapturePhotoToStorageFileAsync(&props, &file)
            .map_err(err)?
            .join()
            .map_err(err)?;
        let bytes = std::fs::read(dir.join(name)).map_err(|e| e.to_string())?;
        Ok(Segment {
            sequence: 1,
            name: name.into(),
            size_bytes: bytes.len() as u64,
            start_ms: 0,
            end_ms: 0,
            sha256: format!("{:x}", Sha256::digest(bytes)),
            file_id: None,
        })
    })();
    let _ = capture.Close();
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    unsafe fn sample(bytes: &[u8], time: i64, duration: i64) -> windows::core::Result<IMFSample> {
        unsafe {
            let buffer = MFCreateMemoryBuffer(bytes.len() as u32)?;
            let mut ptr = std::ptr::null_mut();
            buffer.Lock(&mut ptr, None, None)?;
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(bytes.len() as u32)?;
            let s = MFCreateSample()?;
            s.AddBuffer(&buffer)?;
            s.SetSampleTime(time)?;
            s.SetSampleDuration(duration)?;
            Ok(s)
        }
    }
    #[test]
    fn independently_playable_native_segments() {
        let _com = Apartment::new().expect("Media Foundation startup");
        let dir = std::env::temp_dir().join(format!("buwei-encoder-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        unsafe {
            let audio = MFCreateMediaType().unwrap();
            audio
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)
                .unwrap();
            audio.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).unwrap();
            audio.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 1).unwrap();
            audio
                .SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48000)
                .unwrap();
            audio.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).unwrap();
            audio.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 2).unwrap();
            audio
                .SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 96000)
                .unwrap();
            let video = MFCreateMediaType().unwrap();
            video
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .unwrap();
            video.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).unwrap();
            video
                .SetUINT64(&MF_MT_FRAME_SIZE, (320u64 << 32) | 240)
                .unwrap();
            video
                .SetUINT64(&MF_MT_FRAME_RATE, (30u64 << 32) | 1)
                .unwrap();
            video
                .SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)
                .unwrap();
            video
                .SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                .unwrap();
            for kind in ["audio", "video"] {
                for sequence in 1..=2 {
                    let inputs = if kind == "audio" {
                        vec![(0, audio.clone())]
                    } else {
                        vec![(0, audio.clone()), (1, video.clone())]
                    };
                    let w = writer(&dir, kind, &inputs, sequence, 0).expect("AAC/H264 writer");
                    for frame in 0..60 {
                        let t = frame * 333333;
                        let a = sample(&vec![0u8; 3200], t, 333333).unwrap();
                        w.sink.WriteSample(w.tracks[0].1, &a).unwrap();
                        if kind == "video" {
                            let mut bytes = vec![16u8; 320 * 240 * 3 / 2];
                            bytes[320 * 240..].fill(128);
                            let v = sample(&bytes, t, 333333).unwrap();
                            w.sink.WriteSample(w.tracks[1].1, &v).unwrap();
                        }
                    }
                    w.sink.Finalize().expect("finalize independent container");
                    let path = dir.join(&w.name);
                    let bytes = std::fs::read(&path).unwrap();
                    assert!(bytes.windows(4).any(|b| b == b"ftyp"));
                    assert!(bytes.windows(4).any(|b| b == b"moov"));
                    let wide: Vec<u16> = path
                        .to_string_lossy()
                        .encode_utf16()
                        .chain(Some(0))
                        .collect();
                    let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), None)
                        .expect("reopen independent segment");
                    let mut n = 0;
                    for i in 0..2 {
                        if let Ok(media) = reader.GetNativeMediaType(i, 0) {
                            let ty = media.GetGUID(&MF_MT_MAJOR_TYPE).unwrap();
                            assert!(ty == MFMediaType_Audio || ty == MFMediaType_Video);
                            n += 1;
                        }
                    }
                    assert_eq!(n, if kind == "audio" { 1 } else { 2 });
                }
            }
        }
        // Only remove the exact UUID-named temporary test directory.
        assert!(dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("buwei-encoder-test-"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    #[ignore = "Requires actual camera/microphone; explicitly run for hardware smoke"]
    fn hardware_capture_smoke() {
        let _com = Apartment::new().unwrap();
        for kind in ["audio", "video"] {
            let s = Snapshot {
                id: uuid::Uuid::new_v4().to_string(),
                account_id: uuid::Uuid::new_v4().to_string(),
                project_id: uuid::Uuid::new_v4().to_string(),
                kind: kind.into(),
                state: "recording".into(),
                created_at: "test".into(),
                elapsed_ms: 0,
                segments: vec![],
                interruptions: vec![],
                incomplete_files: vec![],
                error: None,
            };
            unsafe {
                let (source, reader, inputs) =
                    prepare(&s, None, None).expect("open actual capture devices");
                assert_eq!(inputs.len(), if kind == "audio" { 1 } else { 2 });
                let mut received = std::collections::HashSet::new();
                for _ in 0..100 {
                    let mut sample = None;
                    let mut index = 0;
                    let mut flags = 0;
                    let mut stamp = 0;
                    reader
                        .ReadSample(
                            MF_SOURCE_READER_ANY_STREAM.0 as u32,
                            0,
                            Some(&mut index),
                            Some(&mut flags),
                            Some(&mut stamp),
                            Some(&mut sample),
                        )
                        .unwrap();
                    assert_eq!(flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32, 0);
                    if sample.is_some() {
                        received.insert(index);
                    }
                    if received.len() == inputs.len() {
                        break;
                    }
                }
                assert_eq!(
                    received.len(),
                    inputs.len(),
                    "samples from every requested device"
                );
                source.Shutdown().unwrap();
            }
        }
    }
}
