//! Account-scoped capture IPC. Recording never implies consent to upload.
use crate::{runtime, NativeState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[cfg(windows)]
use std::sync::Mutex;
use std::{path::PathBuf, sync::atomic::Ordering};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
pub struct RecordingState {
    #[cfg(windows)]
    pub active: Mutex<Option<crate::recording::CaptureControl>>,
    pub transfer: tokio::sync::Mutex<()>,
}
#[cfg(windows)]
pub struct CaptureControl {
    pub account_id: String,
    pub id: String,
    pub command: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pub devices: std::sync::Arc<Mutex<Option<DeviceSelection>>>,
}
#[cfg(windows)]
pub type DeviceSelection = (Option<String>, Option<String>);
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub sequence: u32,
    pub name: String,
    pub size_bytes: u64,
    pub start_ms: u64,
    pub end_ms: u64,
    pub sha256: String,
    #[serde(default)]
    pub file_id: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub account_id: String,
    pub project_id: String,
    pub kind: String,
    pub state: String,
    pub created_at: String,
    pub elapsed_ms: u64,
    pub segments: Vec<Segment>,
    pub interruptions: Vec<Value>,
    #[serde(default)]
    pub incomplete_files: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}
fn valid(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "无效录制标识".into())
}
fn account(app: &AppHandle, window: &WebviewWindow, project: &str) -> Result<String> {
    runtime::validate_source(window)?;
    valid(project)?;
    let id = app
        .state::<NativeState>()
        .page
        .lock()
        .map_err(|_| "账户状态不可用")?
        .account_id
        .clone()
        .ok_or("请先登录")?;
    valid(&id)?;
    Ok(id)
}
pub fn root(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map(|p| p.join("recordings"))
        .map_err(|e| e.to_string())
}
pub fn directory(app: &AppHandle, account: &str, id: &str) -> Result<PathBuf> {
    valid(account)?;
    valid(id)?;
    Ok(root(app)?.join(account).join(id))
}
pub fn persist(app: &AppHandle, s: &Snapshot) -> Result<()> {
    use std::io::Write;
    let dir = directory(app, &s.account_id, &s.id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("manifest.json");
    let tmp = dir.join("manifest.tmp");
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec(s).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
pub(crate) fn load(app: &AppHandle, account: &str, project: &str, id: &str) -> Result<Snapshot> {
    let p = directory(app, account, id)?.join("manifest.json");
    let size = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if size > 16 * 1024 * 1024 {
        return Err("录制清单过大，请导出后联系支持".into());
    }
    let s: Snapshot = serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if s.id != id || s.account_id != account || s.project_id != project {
        return Err("录制账户或项目不匹配".into());
    }
    Ok(s)
}
fn segment_path(app: &AppHandle, s: &Snapshot, seq: u32) -> Result<(Segment, PathBuf)> {
    let seg = s
        .segments
        .iter()
        .find(|r| r.sequence == seq)
        .ok_or("片段不存在")?
        .clone();
    if seg.name
        != format!(
            "segment-{}.{}",
            seq,
            match s.kind.as_str() {
                "audio" => "m4a",
                "video" => "mp4",
                "photo" => "jpg",
                _ => return Err("录制类型无效".into()),
            }
        )
        || seg.size_bytes == 0
        || seg.size_bytes > 50 * 1024 * 1024
    {
        return Err("片段名称或大小无效".into());
    }
    let p = directory(app, &s.account_id, &s.id)?.join(&seg.name);
    Ok((seg, p))
}
#[tauri::command]
pub async fn recording_capabilities(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
) -> Result<Value> {
    account(&app, &window, &project_id)?;
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(crate::recording_windows::capabilities)
            .await
            .map_err(|e| e.to_string())?
    }
    #[cfg(target_os = "android")]
    {
        crate::android::recording(&app, "recordingCapabilities", json!({})).await
    }
}
#[tauri::command]
pub async fn recording_start(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    kind: String,
    input_device_id: Option<String>,
    camera_device_id: Option<String>,
) -> Result<Value> {
    let owner = account(&app, &window, &project_id)?;
    if !["audio", "video", "photo"].contains(&kind.as_str()) {
        return Err("录制类型无效".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    #[cfg(windows)]
    {
        crate::recording_windows::start(
            app.clone(),
            owner,
            project_id,
            id,
            kind,
            input_device_id,
            camera_device_id,
        )
        .await
    }
    #[cfg(target_os = "android")]
    {
        let result=crate::android::recording(&app,"recordingStart",json!({"id":id,"accountId":owner,"projectId":project_id,"kind":kind,"inputDeviceId":input_device_id,"cameraDeviceId":camera_device_id,"root":root(&app)?})).await?;
        app.state::<NativeState>().active_recordings.store(
            usize::from(result["state"] == "recording" || result["state"] == "paused"),
            Ordering::SeqCst,
        );
        Ok(result)
    }
}
#[tauri::command]
pub async fn recording_action(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    action: String,
    input_device_id: Option<String>,
    camera_device_id: Option<String>,
) -> Result<Value> {
    let owner = account(&app, &window, &project_id)?;
    valid(&id)?;
    if !["pause", "resume", "stop", "photo"].contains(&action.as_str()) {
        return Err("未知录制操作".into());
    }
    #[cfg(windows)]
    {
        crate::recording_windows::action(
            &app,
            &owner,
            &project_id,
            &id,
            &action,
            input_device_id,
            camera_device_id,
        )
        .await?;
        serde_json::to_value(load(&app, &owner, &project_id, &id)?).map_err(|e| e.to_string())
    }
    #[cfg(target_os = "android")]
    {
        let mut args = json!({"id":id,"accountId":owner,"projectId":project_id,"action":action,"root":root(&app)?});
        if action == "resume" {
            if let Some(id) = input_device_id {
                args["inputDeviceId"] = json!(id);
            }
            if let Some(id) = camera_device_id {
                args["cameraDeviceId"] = json!(id);
            }
        }
        let value = crate::android::recording(&app, "recordingAction", args).await?;
        app.state::<NativeState>().active_recordings.store(
            usize::from(value["state"] == "recording" || value["state"] == "paused"),
            Ordering::SeqCst,
        );
        Ok(value)
    }
}
#[tauri::command]
pub async fn recording_list(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
) -> Result<Value> {
    let owner = account(&app, &window, &project_id)?;
    #[cfg(target_os = "android")]
    {
        let value = crate::android::recording(
            &app,
            "recordingList",
            json!({"accountId":owner,"projectId":project_id,"root":root(&app)?}),
        )
        .await?;
        let active = value.as_array().is_some_and(|rows| {
            rows.iter()
                .any(|s| s["state"] == "recording" || s["state"] == "paused")
        });
        app.state::<NativeState>()
            .active_recordings
            .store(usize::from(active), Ordering::SeqCst);
        Ok(value)
    }
    #[cfg(windows)]
    {
        let dir = root(&app)?.join(&owner);
        let mut rows = vec![];
        if dir.exists() {
            for item in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
                let item = item.map_err(|e| e.to_string())?;
                let id = item.file_name().to_string_lossy().into_owned();
                if valid(&id).is_err() {
                    continue;
                }
                if let Ok(mut s) = load(&app, &owner, &project_id, &id) {
                    let active = app
                        .state::<RecordingState>()
                        .active
                        .lock()
                        .map_err(|_| "录制状态忙")?
                        .as_ref()
                        .is_some_and(|a| a.id == id && a.account_id == owner);
                    if !active && ["recording", "paused", "uploading"].contains(&s.state.as_str()) {
                        s.state = "interrupted".into();
                        s.error = Some("录制或上传意外终止；已完成片段保留".into());
                        persist(&app, &s)?;
                    }
                    if !active {
                        let dir = directory(&app, &owner, &id)?;
                        s.incomplete_files = std::fs::read_dir(dir)
                            .map_err(|e| e.to_string())?
                            .filter_map(|e| e.ok())
                            .filter_map(|e| e.file_name().to_str().map(str::to_string))
                            .filter(|name| {
                                tail_name(name) && !s.segments.iter().any(|g| &g.name == name)
                            })
                            .collect();
                    }
                    rows.push(s);
                }
            }
        }
        serde_json::to_value(rows).map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub async fn recording_preview(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    sequence: u32,
) -> Result<Value> {
    use base64::Engine;
    let owner = account(&app, &window, &project_id)?;
    let s = load(&app, &owner, &project_id, &id)?;
    let (seg, path) = segment_path(&app, &s, sequence)?;
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 != seg.size_bytes {
        return Err("片段长度发生变化".into());
    }
    let mime = match s.kind.as_str() {
        "audio" => "audio/mp4",
        "video" => "video/mp4",
        _ => "image/jpeg",
    };
    Ok(
        json!({"mime":mime,"dataUrl":format!("data:{mime};base64,{}",base64::engine::general_purpose::STANDARD.encode(bytes))}),
    )
}
#[tauri::command]
pub async fn recording_export(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    sequence: u32,
) -> Result<()> {
    let owner = account(&app, &window, &project_id)?;
    let s = load(&app, &owner, &project_id, &id)?;
    let (seg, path) = segment_path(&app, &s, sequence)?;
    #[cfg(windows)]
    {
        if let Some(dest) = rfd::AsyncFileDialog::new()
            .set_file_name(seg.name)
            .save_file()
            .await
        {
            if owner != account(&app, &window, &project_id)? {
                return Err("账户已变化".into());
            }
            tokio::fs::copy(path, dest.path())
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        crate::android::export_file(&app, &path, &seg.name).await
    }
}
#[tauri::command]
pub async fn recording_remove(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
) -> Result<()> {
    let owner = account(&app, &window, &project_id)?;
    let s = load(&app, &owner, &project_id, &id)?;
    if ["recording", "paused", "uploading"].contains(&s.state.as_str()) {
        return Err("请先停止录制或上传".into());
    }
    let dir = directory(&app, &owner, &id)?;
    let base = root(&app)?.join(&owner);
    if !dir.starts_with(base) || dir.file_name().and_then(|s| s.to_str()) != Some(id.as_str()) {
        return Err("无效清理目录".into());
    }
    std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
}
fn url(project: &str, tail: &str) -> String {
    format!(
        "{}/api/v1/projects/{project}{tail}",
        crate::PRODUCTION_ORIGIN
    )
}
async fn api(req: reqwest::RequestBuilder) -> Result<Value> {
    crate::cache::api(req).await
}
fn still_current(app: &AppHandle, owner: &str) -> Result<()> {
    if app
        .state::<NativeState>()
        .page
        .lock()
        .map_err(|_| "账户状态忙")?
        .account_id
        .as_deref()
        != Some(owner)
    {
        return Err("账户已变化，上传停止".into());
    }
    #[cfg(target_os = "android")]
    if !crate::android::is_foreground() {
        return Err("上传在后台暂停，返回前台后可重试".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn recording_upload(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    session_id: String,
    contributor_ids: Option<Vec<String>>,
) -> Result<Value> {
    valid(&session_id)?;
    let owner = account(&app, &window, &project_id)?;
    let contributor_ids = contributor_ids.unwrap_or_else(|| vec![owner.clone()]);
    let state = app.state::<RecordingState>();
    let _guard = state.transfer.lock().await;
    let mut s = load(&app, &owner, &project_id, &id)?;
    if ["recording", "paused"].contains(&s.state.as_str()) || s.segments.is_empty() {
        return Err("请先停止并保存录制".into());
    }
    for c in &contributor_ids {
        valid(c)?;
    }
    if contributor_ids.is_empty() {
        return Err("请选择贡献成员".into());
    }
    let dir = directory(&app, &owner, &id)?;
    let upload_manifest = dir.join("upload.json");
    let mut upload: Value = if upload_manifest.exists() {
        serde_json::from_slice(&std::fs::read(&upload_manifest).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
    } else {
        json!({"sessionId":session_id,"contributors":contributor_ids,"parts":{}})
    };
    if upload["sessionId"] != session_id || upload["contributors"] != json!(contributor_ids) {
        return Err("上传已绑定原会话和贡献人，请使用原记录重试".into());
    }
    let (client, _) = runtime::session_client(&app, &owner).await?;
    app.state::<NativeState>()
        .active_transfers
        .fetch_add(1, Ordering::SeqCst);
    let result:Result<()>=async {
 s.state="uploading".into();s.error=None;persist(&app,&s)?;
 for i in 0..s.segments.len(){still_current(&app,&owner)?;let (seg,path)=segment_path(&app,&s,s.segments[i].sequence)?;let key=seg.sequence.to_string();
 if upload["parts"][&key].is_null(){let response=api(client.post(url(&project_id,"/files")).header("Idempotency-Key",format!("{id}-{}",seg.sequence)).json(&json!({"fileName":seg.name,"contributorIds":contributor_ids,"purpose":"reference"}))).await?;upload["parts"][&key]=json!({"fileId":response["fileId"]});save_upload(&upload_manifest,&upload)?;}
 let file_id=upload["parts"][&key]["fileId"].as_str().ok_or("文件标识缺失")?.to_string();valid(&file_id)?;
 let base=url(&project_id,&format!("/files/{file_id}/uploads"));
 if upload["parts"][&key]["uploadId"].is_null(){let init=api(client.post(&base).json(&json!({"sizeBytes":seg.size_bytes}))).await?;upload["parts"][&key]["uploadId"]=init["sessionId"].clone();save_upload(&upload_manifest,&upload)?;}
 let upload_id=upload["parts"][&key]["uploadId"].as_str().ok_or("上传标识缺失")?;valid(upload_id)?;let base=format!("{base}/{upload_id}");let status=api(client.get(&base)).await?;
 if status["status"]!="complete"{let part_size=status["partBytes"].as_u64().filter(|n|*n>0&&*n<=8*1024*1024).ok_or("无效上传分片大小")?;let parts=status["parts"].as_array().ok_or("缺少上传分片清单")?;
 for part in 1..=seg.size_bytes.div_ceil(part_size){still_current(&app,&owner)?;let size=part_size.min(seg.size_bytes-(part-1)*part_size);if parts.iter().any(|p|p["partNumber"].as_u64()==Some(part)&&p["sizeBytes"].as_u64()==Some(size)){continue;}
 let mut file=tokio::fs::File::open(&path).await.map_err(|e|e.to_string())?;file.seek(std::io::SeekFrom::Start((part-1)*part_size)).await.map_err(|e|e.to_string())?;
 use futures_util::StreamExt;let stream_app=app.clone();let stream_owner=owner.clone();let stream=tokio_util::io::ReaderStream::with_capacity(file.take(size),64*1024).map(move|b|{still_current(&stream_app,&stream_owner).map_err(std::io::Error::other)?;b});
 api(client.put(format!("{base}/parts/{part}")).header("x-part-size",size).header("Content-Length",size).body(reqwest::Body::wrap_stream(stream))).await?;}
 still_current(&app,&owner)?;api(client.post(format!("{base}/complete"))).await?;}
 s.segments[i].file_id=Some(file_id);persist(&app,&s)?;}
 s.state="uploaded".into();persist(&app,&s)?;Ok(())
 }.await;
    app.state::<NativeState>()
        .active_transfers
        .fetch_sub(1, Ordering::SeqCst);
    if let Err(e) = result {
        s.state = "stopped".into();
        s.error = Some(e.clone());
        persist(&app, &s)?;
        return Err(e);
    }
    serde_json::to_value(s).map_err(|e| e.to_string())
}
fn tail_name(name: &str) -> bool {
    let name = name.strip_suffix(".partial").unwrap_or(name);
    let Some((base, ext)) = name.rsplit_once('.') else {
        return false;
    };
    ["m4a", "mp4", "jpg"].contains(&ext)
        && base
            .strip_prefix("segment-")
            .is_some_and(|n| n.parse::<u32>().is_ok_and(|n| n > 0))
}
#[tauri::command]
pub async fn recording_export_tail(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    name: String,
) -> Result<()> {
    let owner = account(&app, &window, &project_id)?;
    let snapshot = load(&app, &owner, &project_id, &id)?;
    if !tail_name(&name)
        || snapshot.segments.iter().any(|s| s.name == name)
        || ["recording", "paused", "uploading"].contains(&snapshot.state.as_str())
    {
        return Err("不是可导出的未完成尾段".into());
    }
    let path = directory(&app, &owner, &id)?.join(&name);
    if !path.is_file() {
        return Err("尾段文件不存在".into());
    }
    #[cfg(windows)]
    {
        if let Some(dest) = rfd::AsyncFileDialog::new()
            .set_file_name(&name)
            .save_file()
            .await
        {
            if owner != account(&app, &window, &project_id)? {
                return Err("账户已变化".into());
            }
            tokio::fs::copy(path, dest.path())
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(target_os = "android")]
    {
        crate::android::export_file(&app, &path, &name).await
    }
}
fn save_upload(path: &std::path::Path, value: &Value) -> Result<()> {
    use std::io::Write;
    let temp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    f.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_path_ids() {
        assert!(valid("../file").is_err());
        assert!(valid("C:/secret").is_err());
        assert!(valid(&uuid::Uuid::new_v4().to_string()).is_ok());
    }
}
