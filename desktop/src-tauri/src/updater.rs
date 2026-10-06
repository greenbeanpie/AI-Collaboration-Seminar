//! Native-only updater. Installation must be authorized by the shell's durable-save handshake.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: String,
    pub version: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub error: Option<String>,
    pub auto_restart: bool,
}
#[derive(Serialize, Deserialize)]
struct Cached { version: String, signature: String }
pub struct UpdateManager {
    status: Mutex<UpdateStatus>,
    update: Mutex<Option<Update>>,
    busy: AtomicBool,
    auto_restart: AtomicBool,
}
impl Default for UpdateManager {
    fn default() -> Self { Self { status: Mutex::new(UpdateStatus { phase: "idle".into(), auto_restart: true, ..Default::default() }), update: Mutex::new(None), busy: AtomicBool::new(false), auto_restart: AtomicBool::new(true) } }
}
impl UpdateManager {
    pub fn status(&self) -> UpdateStatus { self.status.lock().unwrap().clone() }
    pub fn ready(&self) -> bool { self.status.lock().unwrap().phase == "ready" }
    pub fn auto_restart(&self) -> bool { self.auto_restart.load(Ordering::SeqCst) }
    pub fn set_auto_restart(&self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        atomic_write(&cache_dir(app)?.join("preferences.json"), &serde_json::to_vec(&enabled).unwrap())?;
        self.auto_restart.store(enabled, Ordering::SeqCst);
        self.status.lock().unwrap().auto_restart = enabled;
        publish(app, self); Ok(())
    }
}
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?; Ok(path)
}
fn publish(app: &AppHandle, manager: &UpdateManager) { crate::runtime::dispatch(app, "desktop-update-state", serde_json::to_value(manager.status()).unwrap()); }
fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    atomic_replace(&temporary, path).map_err(|e| e.to_string())
}
#[cfg(windows)]
fn atomic_replace(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" { fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32; }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // REPLACE_EXISTING | WRITE_THROUGH, same-directory replacement retains old file on failure.
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 1 | 8) } == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}
#[cfg(not(windows))]
fn atomic_replace(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> { std::fs::rename(source, target) }
fn verify(app: &AppHandle, data: &[u8], signature: &str) -> Result<(), String> {
    let key = app.config().plugins.0.get("updater").and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()).ok_or("Missing updater public key")?;
    verify_with_key(key, data, signature)
}
fn verify_with_key(key: &str, data: &[u8], signature: &str) -> Result<(), String> {
    let decode = |s: &str| -> Result<String, String> { String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) };
    let key = minisign_verify::PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(data, &sig, true).map_err(|e| e.to_string())
}
pub async fn check_update(app: &AppHandle, manager: &UpdateManager) -> Result<UpdateStatus, String> {
    if manager.busy.swap(true, Ordering::SeqCst) { return Ok(manager.status()); }
    let previous_ready = manager.ready();
    let result = check_inner(app, manager).await;
    manager.busy.store(false, Ordering::SeqCst);
    if let Err(error) = &result { let mut s = manager.status.lock().unwrap(); s.phase = if previous_ready { "ready" } else { "error" }.into(); s.error = Some(error.clone()); }
    publish(app, manager); result.map(|_| manager.status())
}
async fn check_inner(app: &AppHandle, manager: &UpdateManager) -> Result<(), String> {
    { let mut s = manager.status.lock().unwrap(); s.phase = "checking".into(); s.error = None; }
    publish(app, manager);
    let mut builder = app.updater_builder().timeout(Duration::from_secs(300));
    // This branch is eliminated in release builds, even if the environment variable is set.
    if smoke_enabled() {
        builder = builder.endpoints(vec!["http://127.0.0.1:5173/latest.json".parse().map_err(|e: url::ParseError| e.to_string())?]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        manager.status.lock().unwrap().phase = "current".into(); return Ok(());
    };
    // The fixed release repository is the only permitted download source.
    if !trusted_download_url(&update.download_url, smoke_enabled()) { return Err("Untrusted update location".into()); }
    let dir = cache_dir(app)?;
    let cached: Option<Cached> = std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let reuse = cached.as_ref().is_some_and(|c| c.version == update.version && c.signature == update.signature);
    let cached_bytes = if reuse { std::fs::read(dir.join("installer.bin")).ok().filter(|b| verify(app, b, &update.signature).is_ok()) } else { None };
    let bytes = if let Some(b) = cached_bytes { b } else {
        { let mut s = manager.status.lock().unwrap(); s.phase = "downloading".into(); s.version = Some(update.version.clone()); s.downloaded_bytes = 0; }
        let b = update.download(|chunk, total| { let mut s = manager.status.lock().unwrap(); s.downloaded_bytes += chunk as u64; s.total_bytes = total; }, || {}).await.map_err(|e| e.to_string())?;
        atomic_write(&dir.join("installer.bin"), &b)?;
        atomic_write(&dir.join("manifest.json"), &serde_json::to_vec(&Cached { version: update.version.clone(), signature: update.signature.clone() }).unwrap())?; b
    };
    drop(bytes); // No installer-sized buffer remains resident while awaiting restart.
    { let mut s = manager.status.lock().unwrap(); s.phase = "ready".into(); s.version = Some(update.version.clone()); }
    *manager.update.lock().unwrap() = Some(update); Ok(())
}
pub async fn install_update(app: &AppHandle, manager: &UpdateManager) -> Result<(), String> {
    if !manager.ready() || manager.busy.swap(true, Ordering::SeqCst) { return Err("No ready update or updater busy".into()); }
    let result = (|| {
        let update = manager.update.lock().unwrap().clone().ok_or("Update metadata unavailable")?;
        let bytes = std::fs::read(cache_dir(app)?.join("installer.bin")).map_err(|e| e.to_string())?;
        // install() itself does NOT verify: always verify again immediately before execution.
        verify(app, &bytes, &update.signature)?;
        manager.status.lock().unwrap().phase = "installing".into(); publish(app, manager);
        update.install(bytes).map_err(|e| e.to_string())
    })();
    manager.busy.store(false, Ordering::SeqCst);
    if let Err(error) = &result { let mut s = manager.status.lock().unwrap(); s.phase = "error".into(); s.error = Some(error.clone()); }
    publish(app, manager); result
}
pub fn setup(app: &AppHandle) -> Result<(), String> {
    let manager = UpdateManager::default();
    if let Ok(b) = std::fs::read(cache_dir(app)?.join("preferences.json")) { if let Ok(enabled) = serde_json::from_slice::<bool>(&b) { manager.auto_restart.store(enabled, Ordering::SeqCst); manager.status.lock().unwrap().auto_restart = enabled; } }
    app.manage(manager);
    let app = app.clone();
    tauri::async_runtime::spawn(async move { loop { let _ = check(&app).await; tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await; } }); Ok(())
}
pub async fn check(app: &AppHandle) -> Result<UpdateStatus, String> { check_update(app, &app.state::<UpdateManager>()).await }
fn smoke_enabled() -> bool { cfg!(debug_assertions) && option_env!("BUWEI_DESKTOP_SMOKE") == Some("1") }
fn trusted_download_url(url: &url::Url, smoke: bool) -> bool {
    let github = url.scheme() == "https" && url.host_str() == Some("github.com") && url.path().starts_with("/greenbeanpie/AI-Colleboration-Seminar/releases/download/") && url.username().is_empty() && url.password().is_none();
    let loopback = smoke && url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(5173) && url.path().starts_with("/updates/") && url.path().ends_with(".exe") && url.username().is_empty() && url.password().is_none() && url.query().is_none() && url.fragment().is_none();
    github || loopback
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn default_requires_a_download() { let m = UpdateManager::default(); assert!(!m.ready()); assert!(m.auto_restart()); assert_eq!(m.status().phase, "idle"); }
    #[test] fn signature_rejects_corrupted_cached_installer() {
        let key = include_str!("../tests/fixtures/update-test.pub");
        let sig = include_str!("../tests/fixtures/update-test.bin.sig");
        let data = include_bytes!("../tests/fixtures/update-test.bin");
        assert!(verify_with_key(key, data, sig).is_ok());
        let mut corrupted = data.to_vec(); corrupted[0] ^= 1;
        assert!(verify_with_key(key, &corrupted, sig).is_err());
        assert!(verify_with_key(key, data, "invalid signature").is_err());
    }
    #[test] fn atomic_write_replaces_existing_file() {
        let path = std::env::temp_dir().join(format!("buwei-update-{}.json", std::process::id()));
        atomic_write(&path, b"old").unwrap(); atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new"); std::fs::remove_file(path).unwrap();
    }
    #[test] fn smoke_downloads_remain_strictly_loopback_and_release_rejects_http() {
        let good = url::Url::parse("http://127.0.0.1:5173/updates/buwei.exe").unwrap();
        assert!(trusted_download_url(&good, true)); assert!(!trusted_download_url(&good, false));
        for bad in ["http://localhost:5173/updates/buwei.exe", "http://127.0.0.1:5174/updates/buwei.exe", "http://127.0.0.1:5173/updates/buwei.exe?redirect=evil", "https://example.com/updates/buwei.exe"] { assert!(!trusted_download_url(&url::Url::parse(bad).unwrap(), true)); }
    }
}
