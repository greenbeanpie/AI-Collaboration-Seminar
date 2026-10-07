//! Account-scoped disk spool. Web commands never accept filesystem paths or URLs.
use crate::{runtime, NativeState};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::Ordering, Mutex},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

#[derive(Default)]
pub struct CacheState {
    manifests: Mutex<HashMap<String, Vec<NativeFile>>>,
    transfer: tokio::sync::Mutex<()>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeFile {
    pub id: String,
    pub account_id: String,
    pub project_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replace_material_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_id: Option<String>,
    pub name: String,
    pub size_bytes: u64,
    pub direction: String,
    pub status: String,
    pub transferred_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing)]
    pub session_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheFile {
    file_id: String,
    name: String,
    size_bytes: u64,
}
type Result<T> = std::result::Result<T, String>;
struct TransferActivity(AppHandle);
impl TransferActivity {
    fn start(app: &AppHandle) -> Self {
        app.state::<NativeState>()
            .active_transfers
            .fetch_add(1, Ordering::Relaxed);
        Self(app.clone())
    }
}
impl Drop for TransferActivity {
    fn drop(&mut self) {
        let native = self.0.state::<NativeState>();
        let previous = native.active_transfers.fetch_sub(1, Ordering::Relaxed);
        if previous == 1 {
            let mut hidden_since = native.hidden_since.lock().unwrap();
            if hidden_since.is_some() {
                *hidden_since = Some(std::time::Instant::now());
            }
        }
    }
}
fn valid_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "无效标识".into())
}
fn account(app: &AppHandle, window: &WebviewWindow, project: &str) -> Result<String> {
    runtime::validate_source(window)?;
    valid_id(project)?;
    app.state::<NativeState>()
        .page
        .lock()
        .map_err(|_| "状态不可用")?
        .account_id
        .clone()
        .ok_or_else(|| "请先登录此设备".into())
}
fn root(app: &AppHandle, account: &str) -> Result<PathBuf> {
    valid_id(account)?;
    let path = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("attachments")
        .join(account);
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn blob(app: &AppHandle, row: &NativeFile) -> Result<PathBuf> {
    valid_id(&row.id)?;
    Ok(root(app, &row.account_id)?.join(format!("{}.blob", row.id)))
}
fn load(app: &AppHandle, account: &str) -> Result<()> {
    let state = app.state::<CacheState>();
    let mut manifests = state.manifests.lock().map_err(|_| "缓存忙")?;
    if !manifests.contains_key(account) {
        let path = root(app, account)?.join("manifest.json");
        let mut rows: Vec<NativeFile> = if path.exists() {
            serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("缓存清单损坏，请保留数据并联系支持：{e}"))?
        } else {
            vec![]
        };
        for row in &mut rows {
            if row.account_id != account {
                return Err("缓存账户不匹配".into());
            }
            valid_id(&row.id)?;
            valid_id(&row.project_id)?;
            if row.status == "transferring" {
                row.status = "waiting".into();
            }
        }
        manifests.insert(account.to_string(), rows);
    }
    Ok(())
}
fn persist(app: &AppHandle, account: &str, rows: &[NativeFile]) -> Result<()> {
    let path = root(app, account)?.join("manifest.json");
    let temp = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temp).map_err(|e| e.to_string())?;
    // Persist session IDs, which are deliberately absent from IPC responses.
    let mut value = serde_json::to_value(rows).map_err(|e| e.to_string())?;
    for (item, row) in value.as_array_mut().ok_or("无效清单")?.iter_mut().zip(rows) {
        item["sessionId"] = json!(row.session_id);
    }
    use std::io::Write;
    file.write_all(&serde_json::to_vec(&value).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(temp, path).map_err(|e| e.to_string())
}
fn change<F: FnOnce(&mut Vec<NativeFile>) -> Result<()>>(
    app: &AppHandle,
    account: &str,
    f: F,
) -> Result<()> {
    load(app, account)?;
    let state = app.state::<CacheState>();
    let mut manifests = state.manifests.lock().map_err(|_| "缓存忙")?;
    let rows = manifests.get_mut(account).ok_or("缓存不可用")?;
    transaction(rows, f, |next| persist(app, account, next))
}
fn transaction<
    F: FnOnce(&mut Vec<NativeFile>) -> Result<()>,
    P: FnOnce(&[NativeFile]) -> Result<()>,
>(
    rows: &mut Vec<NativeFile>,
    change: F,
    persist: P,
) -> Result<()> {
    let mut next = rows.clone();
    change(&mut next)?;
    persist(&next)?;
    *rows = next;
    Ok(())
}
fn list(app: &AppHandle, account: &str, project: &str) -> Result<Vec<NativeFile>> {
    load(app, account)?;
    Ok(app
        .state::<CacheState>()
        .manifests
        .lock()
        .map_err(|_| "缓存忙")?
        .get(account)
        .ok_or("缓存不可用")?
        .iter()
        .filter(|row| row.project_id == project)
        .cloned()
        .collect())
}
fn update(app: &AppHandle, row: &NativeFile) -> Result<()> {
    change(app, &row.account_id, |rows| {
        let current = rows
            .iter_mut()
            .find(|r| r.id == row.id)
            .ok_or("缓存不存在")?;
        if current.status == "paused" && row.status != "complete" {
            let mut next = row.clone();
            next.status = "paused".into();
            *current = next;
        } else {
            *current = row.clone();
        }
        Ok(())
    })
}
fn still_active(app: &AppHandle, row: &NativeFile) -> Result<()> {
    let native = app.state::<NativeState>();
    if native.exiting.load(Ordering::Relaxed)
        || native
            .page
            .lock()
            .map_err(|_| "状态不可用")?
            .account_id
            .as_deref()
            != Some(&row.account_id)
    {
        return Err("登录账户已变化，传输已停止".into());
    }
    if app
        .state::<CacheState>()
        .manifests
        .lock()
        .map_err(|_| "缓存忙")?
        .get(&row.account_id)
        .and_then(|rows| rows.iter().find(|r| r.id == row.id))
        .is_none_or(|r| r.status == "paused")
    {
        return Err("传输已暂停".into());
    }
    Ok(())
}
async fn api(request: reqwest::RequestBuilder) -> Result<Value> {
    let response = request
        .send()
        .await
        .map_err(|_| "网络连接中断，内容已保留；恢复前将查询服务器状态")?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| "服务器响应无法识别")?;
    if !status.is_success() {
        return Err(format!(
            "{} ({status})",
            value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("请求失败")
        ));
    }
    value
        .get("data")
        .cloned()
        .ok_or_else(|| "服务器响应缺少数据".into())
}
fn url(project: &str, tail: &str) -> String {
    format!(
        "{}/api/v1/projects/{project}{tail}",
        crate::PRODUCTION_ORIGIN
    )
}

#[tauri::command]
pub async fn desktop_list_files(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
) -> Result<Vec<NativeFile>> {
    let account = account(&app, &window, &project_id)?;
    list(&app, &account, &project_id)
}
#[tauri::command]
pub async fn desktop_stage_files(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    task_id: Option<String>,
    replace_material_id: Option<String>,
    expected_revision: Option<u64>,
    max_files: Option<usize>,
) -> Result<Vec<NativeFile>> {
    let account = account(&app, &window, &project_id)?;
    if let Some(id) = &task_id {
        valid_id(id)?;
    }
    if let Some(id) = &replace_material_id {
        valid_id(id)?;
    }
    let _activity = TransferActivity::start(&app);
    let paths = rfd::AsyncFileDialog::new()
        .set_title("选择离线附件")
        .pick_files()
        .await
        .unwrap_or_default();
    if paths.len() > max_files.unwrap_or(10).min(10) {
        return Err("每轮最多提交10个文件".into());
    }
    if replace_material_id.is_none()
        && task_id.is_some()
        && list(&app, &account, &project_id)?
            .iter()
            .filter(|r| r.direction == "upload" && r.task_id == task_id && r.status != "complete")
            .count()
            + paths.len()
            > 10
    {
        return Err("待上传附件不能超过10个".into());
    }
    let mut staged = vec![];
    for path in paths {
        if account != self::account(&app, &window, &project_id)? {
            return Err("登录账户已变化".into());
        }
        let name = path.file_name();
        if name.len() > 255 {
            return Err("文件名过长".into());
        }
        let before = tokio::fs::metadata(path.path())
            .await
            .map_err(|e| e.to_string())?;
        let size = before.len();
        if size == 0 {
            return Err("不能上传空文件".into());
        }
        let row = NativeFile {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: account.clone(),
            project_id: project_id.clone(),
            task_id: task_id.clone(),
            replace_material_id: replace_material_id.clone(),
            expected_revision,
            file_id: None,
            name,
            size_bytes: size,
            direction: "upload".into(),
            status: "waiting".into(),
            transferred_bytes: 0,
            error: None,
            session_id: None,
        };
        let target = blob(&app, &row)?;
        tokio::fs::copy(path.path(), &target)
            .await
            .map_err(|e| e.to_string())?;
        let copied = tokio::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&target)
            .await
            .map_err(|e| e.to_string())?;
        copied.sync_all().await.map_err(|e| e.to_string())?;
        let after = tokio::fs::metadata(path.path())
            .await
            .map_err(|e| e.to_string())?;
        if copied.metadata().await.map_err(|e| e.to_string())?.len() != size
            || after.len() != size
            || before.modified().ok() != after.modified().ok()
        {
            drop(copied);
            let _ = tokio::fs::remove_file(&target).await;
            return Err("源文件在复制期间变化，请关闭编辑后重新添加".into());
        }
        drop(copied);
        if let Err(error) = change(&app, &account, |rows| {
            rows.push(row.clone());
            Ok(())
        }) {
            let _ = tokio::fs::remove_file(blob(&app, &row)?).await;
            return Err(error);
        }
        staged.push(row);
    }
    Ok(staged)
}
#[tauri::command]
pub async fn desktop_cache_project(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    files: Vec<CacheFile>,
) -> Result<Vec<NativeFile>> {
    let account = account(&app, &window, &project_id)?;
    if files.len() > 10000 {
        return Err("文件清单过大".into());
    }
    for f in &files {
        valid_id(&f.file_id)?;
        if f.name.len() > 255 {
            return Err("文件名过长".into());
        }
    }
    change(&app, &account, |rows| {
        for f in files {
            if rows.iter().any(|r| {
                r.project_id == project_id
                    && r.direction == "download"
                    && r.file_id.as_deref() == Some(&f.file_id)
            }) {
                continue;
            }
            rows.push(NativeFile {
                id: uuid::Uuid::new_v4().to_string(),
                account_id: account.clone(),
                project_id: project_id.clone(),
                task_id: None,
                replace_material_id: None,
                expected_revision: None,
                file_id: Some(f.file_id),
                name: f.name,
                size_bytes: f.size_bytes,
                direction: "download".into(),
                status: "waiting".into(),
                transferred_bytes: 0,
                error: None,
                session_id: None,
            });
        }
        Ok(())
    })?;
    list(&app, &account, &project_id)
}
#[tauri::command]
pub async fn desktop_pause_file(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
) -> Result<()> {
    let account = account(&app, &window, &project_id)?;
    change(&app, &account, |rows| {
        let row = rows
            .iter_mut()
            .find(|r| r.id == id && r.project_id == project_id)
            .ok_or("缓存不存在")?;
        if row.status != "complete" {
            row.status = "paused".into();
        }
        Ok(())
    })
}
#[tauri::command]
pub async fn desktop_resume_file(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
) -> Result<()> {
    let account = account(&app, &window, &project_id)?;
    change(&app, &account, |rows| {
        let row = rows
            .iter_mut()
            .find(|r| r.id == id && r.project_id == project_id)
            .ok_or("缓存不存在")?;
        if row.status != "complete" {
            row.status = "waiting".into();
            row.error = None;
        }
        Ok(())
    })?;
    desktop_transfer_files(app, window, project_id).await
}
#[tauri::command]
pub async fn desktop_remove_file(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
    discard: Option<bool>,
) -> Result<()> {
    let account = account(&app, &window, &project_id)?;
    let mut path = None;
    change(&app, &account, |rows| {
        let row = rows
            .iter()
            .find(|r| r.id == id && r.project_id == project_id)
            .ok_or("缓存不存在")?;
        if row.status == "transferring" {
            return Err("请先暂停传输再删除".into());
        }
        if row.direction == "upload" && row.status != "complete" && !discard.unwrap_or(false) {
            return Err("待上传附件不能作为缓存清理".into());
        }
        path = Some(blob(&app, row)?);
        rows.retain(|r| r.id != id);
        Ok(())
    })?;
    if let Some(path) = path {
        if path.exists() {
            std::fs::remove_file(path)
                .map_err(|e| format!("清单已移除，文件清理失败，可稍后重试：{e}"))?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_export_file(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
    id: String,
) -> Result<()> {
    let account = account(&app, &window, &project_id)?;
    let _activity = TransferActivity::start(&app);
    let row = list(&app, &account, &project_id)?
        .into_iter()
        .find(|r| r.id == id && r.status == "complete")
        .ok_or("文件尚未完成")?;
    let name = PathBuf::from(&row.name)
        .file_name()
        .ok_or("文件名无效")?
        .to_string_lossy()
        .into_owned();
    if let Some(path) = rfd::AsyncFileDialog::new()
        .set_file_name(name)
        .save_file()
        .await
    {
        if account != self::account(&app, &window, &project_id)? {
            return Err("登录账户已变化，导出已取消".into());
        }
        tokio::fs::copy(blob(&app, &row)?, path.path())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_cache_usage(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
) -> Result<Value> {
    let account = account(&app, &window, &project_id)?;
    let rows = list(&app, &account, &project_id)?;
    Ok(
        json!({"files":rows.len(),"sizeBytes":rows.iter().map(|r| if r.direction=="upload"{r.size_bytes}else{r.transferred_bytes}).sum::<u64>(),"pendingUploads":rows.iter().filter(|r|r.direction=="upload"&&r.status!="complete").count()}),
    )
}

#[tauri::command]
pub async fn desktop_pending_files(app: AppHandle, window: WebviewWindow) -> Result<Value> {
    runtime::validate_source(&window)?;
    let account = app
        .state::<NativeState>()
        .page
        .lock()
        .map_err(|_| "状态不可用")?
        .account_id
        .clone()
        .ok_or("请先登录")?;
    load(&app, &account)?;
    let count = app
        .state::<CacheState>()
        .manifests
        .lock()
        .map_err(|_| "缓存忙")?
        .get(&account)
        .ok_or("缓存不可用")?
        .iter()
        .filter(|r| r.direction == "upload" && r.status != "complete")
        .count();
    Ok(json!({"pendingUploads":count}))
}

/// Called by the native bounded poll loop, independent of which React panel is mounted.
pub async fn resume_account_transfers(app: &AppHandle) -> Result<()> {
    let native = app.state::<NativeState>();
    if native.exiting.load(Ordering::Relaxed) || native.active_transfers.load(Ordering::Relaxed) > 0
    {
        return Ok(());
    }
    let account = native
        .page
        .lock()
        .map_err(|_| "状态不可用")?
        .account_id
        .clone();
    let Some(account) = account else {
        return Ok(());
    };
    load(app, &account)?;
    let projects: std::collections::HashSet<String> = app
        .state::<CacheState>()
        .manifests
        .lock()
        .map_err(|_| "缓存忙")?
        .get(&account)
        .ok_or("缓存不可用")?
        .iter()
        .filter(|r| {
            r.status == "waiting"
                || (r.status == "failed"
                    && r.error
                        .as_deref()
                        .is_some_and(|e| e.starts_with("网络") || e.starts_with("下载中断")))
        })
        .map(|r| r.project_id.clone())
        .collect();
    let window = app.get_webview_window("main").ok_or("主窗口不存在")?;
    for project in projects {
        desktop_transfer_files(app.clone(), window.clone(), project).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_transfer_files(
    app: AppHandle,
    window: WebviewWindow,
    project_id: String,
) -> Result<()> {
    let account = account(&app, &window, &project_id)?;
    let state = app.state::<CacheState>();
    let _guard = state
        .transfer
        .try_lock()
        .map_err(|_| "已有文件正在传输，请稍候")?;
    let _active = TransferActivity::start(&app);
    for mut row in list(&app, &account, &project_id)? {
        if row.status == "complete"
            || row.status == "paused"
            || (row.status == "failed"
                && !row
                    .error
                    .as_deref()
                    .is_some_and(|e| e.starts_with("网络") || e.starts_with("下载中断")))
        {
            continue;
        }
        still_active(&app, &row)?;
        row.status = "transferring".into();
        row.error = None;
        update(&app, &row)?;
        let result = transfer(&app, &mut row).await;
        if let Err(error) = result {
            row.status = "failed".into();
            row.error = Some(error.clone());
            update(&app, &row)?;
            return Err(error);
        }
        row.status = "complete".into();
        row.transferred_bytes = row.size_bytes;
        update(&app, &row)?;
    }
    Ok(())
}
async fn transfer(app: &AppHandle, row: &mut NativeFile) -> Result<()> {
    let (client, _) = runtime::session_client(app, &row.account_id).await?;
    still_active(app, row)?;
    if row.direction == "download" {
        return download(app, &client, row).await;
    }
    if row.file_id.is_none() {
        let data = api(client
            .post(url(&row.project_id, "/files"))
            .header("Idempotency-Key", &row.id)
            .json(&json!({"fileName":row.name})))
        .await?;
        let id = data["fileId"].as_str().ok_or("缺少文件标识")?;
        valid_id(id)?;
        row.file_id = Some(id.into());
        update(app, row)?;
    }
    let base = url(
        &row.project_id,
        &format!(
            "/files/{}/uploads",
            row.file_id.as_deref().ok_or("缺少文件标识")?
        ),
    );
    if row.session_id.is_none() {
        still_active(app, row)?;
        let init = api(client
            .post(&base)
            .json(&json!({"sizeBytes":row.size_bytes})))
        .await?;
        row.session_id = Some(init["sessionId"].as_str().ok_or("缺少会话标识")?.into());
        update(app, row)?;
    }
    let session = row.session_id.clone().ok_or("缺少会话标识")?;
    valid_id(&session)?;
    let path = format!("{base}/{session}");
    // Every attempt reconciles accepted parts before sending any bytes, including uncertain previous failures.
    still_active(app, row)?;
    let status = api(client.get(&path)).await?;
    if status["status"] != "complete" {
        let part_bytes = status["partBytes"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= 100_000_000)
            .ok_or("无效分片大小")?;
        let parts = status["parts"].as_array().ok_or("缺少分片清单")?;
        for part in 1..=row.size_bytes.div_ceil(part_bytes) {
            still_active(app, row)?;
            let size = part_bytes.min(row.size_bytes - (part - 1) * part_bytes);
            if !parts.iter().any(|p| {
                p["partNumber"].as_u64() == Some(part) && p["sizeBytes"].as_u64() == Some(size)
            }) {
                let mut input = tokio::fs::File::open(blob(app, row)?)
                    .await
                    .map_err(|e| e.to_string())?;
                input
                    .seek(std::io::SeekFrom::Start((part - 1) * part_bytes))
                    .await
                    .map_err(|e| e.to_string())?;
                let stream_app = app.clone();
                let stream_row = row.clone();
                let stream = tokio_util::io::ReaderStream::with_capacity(
                    input.take(size),
                    64 * 1024,
                )
                .map(move |chunk| {
                    still_active(&stream_app, &stream_row).map_err(std::io::Error::other)?;
                    chunk
                });
                api(client
                    .put(format!("{path}/parts/{part}"))
                    .header("x-part-size", size)
                    .header("Content-Length", size)
                    .body(reqwest::Body::wrap_stream(stream)))
                .await?;
            }
            row.transferred_bytes = (part * part_bytes).min(row.size_bytes);
            update(app, row)?;
        }
        still_active(app, row)?;
        api(client.post(format!("{path}/complete"))).await?;
    }
    if let Some(task) = &row.task_id {
        valid_id(task)?;
        still_active(app, row)?;
        let suffix = row
            .replace_material_id
            .as_ref()
            .map(|id| format!("/{id}"))
            .unwrap_or_default();
        let request = if row.replace_material_id.is_some() {
            client.put(url(
                &row.project_id,
                &format!("/tasks/{task}/files{suffix}"),
            ))
        } else {
            client.post(url(&row.project_id, &format!("/tasks/{task}/files")))
        };
        let mut body = json!({"fileId":row.file_id});
        if let Some(rev) = row.expected_revision {
            body["expectedRevision"] = json!(rev);
        }
        api(request
            .header("Idempotency-Key", format!("{}-register", row.id))
            .json(&body))
        .await?;
    }
    Ok(())
}
async fn download(app: &AppHandle, client: &reqwest::Client, row: &mut NativeFile) -> Result<()> {
    still_active(app, row)?;
    let path = blob(app, row)?;
    let saved = tokio::fs::metadata(&path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let offset = if row.size_bytes > 0 && saved >= row.size_bytes {
        0
    } else {
        saved
    };
    let id = row.file_id.as_deref().ok_or("缺少文件标识")?;
    valid_id(id)?;
    let response = client
        .get(url(&row.project_id, &format!("/files/{id}/content")))
        .header("Range", format!("bytes={offset}-"))
        .send()
        .await
        .map_err(|_| "网络连接中断")?;
    if !response.status().is_success() {
        return Err(format!("文件读取失败 ({})", response.status()));
    }
    let append = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    let total = if append {
        range_total(
            response
                .headers()
                .get("content-range")
                .and_then(|h| h.to_str().ok())
                .ok_or("缺少下载范围")?,
            offset,
        )?
    } else {
        response
            .content_length()
            .ok_or("缺少文件长度，无法安全下载")?
    };
    row.size_bytes = total;
    let mut output = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .await
        .map_err(|e| e.to_string())?;
    row.transferred_bytes = if append { offset } else { 0 };
    let mut stream = response.bytes_stream();
    let mut checkpoint = row.transferred_bytes;
    while let Some(bytes) = stream.next().await {
        still_active(app, row)?;
        let bytes = bytes.map_err(|_| "下载中断，内容已保留")?;
        if row.transferred_bytes.saturating_add(bytes.len() as u64) > total {
            return Err("下载超出服务器声明长度".into());
        }
        output.write_all(&bytes).await.map_err(|e| e.to_string())?;
        row.transferred_bytes += bytes.len() as u64;
        if row.transferred_bytes - checkpoint >= 1048576 {
            update(app, row)?;
            checkpoint = row.transferred_bytes;
        }
    }
    output.sync_all().await.map_err(|e| e.to_string())?;
    if row.size_bytes != 0 && row.transferred_bytes != row.size_bytes {
        return Err("下载长度变化，请重新下载".into());
    }
    row.size_bytes = row.transferred_bytes;
    Ok(())
}
fn range_total(header: &str, offset: u64) -> Result<u64> {
    let rest = header.strip_prefix("bytes ").ok_or("下载范围无效")?;
    let (bounds, total) = rest.split_once('/').ok_or("下载范围无效")?;
    let (start, end) = bounds.split_once('-').ok_or("下载范围无效")?;
    let start = start.parse::<u64>().map_err(|_| "下载范围无效")?;
    let end = end.parse::<u64>().map_err(|_| "下载范围无效")?;
    let total = total.parse::<u64>().map_err(|_| "下载范围无效")?;
    if start != offset || end < start || end >= total || end.checked_add(1) != Some(total) {
        return Err("下载范围不匹配".into());
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identifiers_cannot_escape_cache_root() {
        assert!(valid_id("../x").is_err());
        assert!(valid_id("C:\\file").is_err());
        assert!(valid_id(&uuid::Uuid::new_v4().to_string()).is_ok());
    }
    #[test]
    fn failed_persistence_cannot_mutate_memory() {
        let mut rows = vec![fixture()];
        let result = transaction(
            &mut rows,
            |next| {
                next.clear();
                Ok(())
            },
            |_| Err("disk full".into()),
        );
        assert!(result.is_err());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "test.pdf");
    }
    #[test]
    fn range_validation_rejects_wrong_start_and_partial_end() {
        assert_eq!(range_total("bytes 5-9/10", 5).unwrap(), 10);
        assert!(range_total("bytes 4-9/10", 5).is_err());
        assert!(range_total("bytes 5-10/10", 5).is_err());
        assert!(range_total("bytes 5-8/10", 5).is_err());
        assert!(range_total("bytes */10", 5).is_err());
    }
    #[test]
    fn ipc_never_exposes_upload_session() {
        assert!(serde_json::to_value(fixture())
            .unwrap()
            .get("sessionId")
            .is_none());
    }
    fn fixture() -> NativeFile {
        NativeFile {
            id: uuid::Uuid::new_v4().to_string(),
            account_id: uuid::Uuid::new_v4().to_string(),
            project_id: uuid::Uuid::new_v4().to_string(),
            task_id: None,
            replace_material_id: None,
            expected_revision: None,
            file_id: None,
            name: "test.pdf".into(),
            size_bytes: 1,
            direction: "upload".into(),
            status: "waiting".into(),
            transferred_bytes: 0,
            error: None,
            session_id: Some("private".into()),
        }
    }
}
