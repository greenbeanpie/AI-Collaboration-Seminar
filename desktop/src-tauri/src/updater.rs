//! Native-only updater. Installation must be authorized by the shell's durable-save handshake.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
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
        std::fs::write(cache_dir(app)?.join("preferences.json"), serde_json::to_vec(&enabled).unwrap()).map_err(|e| e.to_string())?;
        self.auto_restart.store(enabled, Ordering::SeqCst);
        self.status.lock().unwrap().auto_restart = enabled;
        publish(app, self); Ok(())
    }
}
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("updates");
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())?; Ok(path)
}
fn publish(app: &AppHandle, manager: &UpdateManager) { let _ = app.emit("desktop-update-state", manager.status()); }
fn verify(app: &AppHandle, data: &[u8], signature: &str) -> Result<(), String> {
    let key = app.config().plugins.0.get("updater").and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()).ok_or("Missing updater public key")?;
    let decode = |s: &str| -> Result<String, String> { String::from_utf8(base64::engine::general_purpose::STANDARD.decode(s.trim()).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) };
    let key = minisign_verify::PublicKey::decode(&decode(key)?).map_err(|e| e.to_string())?;
    let sig = minisign_verify::Signature::decode(&decode(signature)?).map_err(|e| e.to_string())?;
    key.verify(data, &sig, true).map_err(|e| e.to_string())
}
pub async fn check_update(app: &AppHandle, manager: &UpdateManager) -> Result<UpdateStatus, String> {
    if manager.busy.swap(true, Ordering::SeqCst) { return Ok(manager.status()); }
    let result = check_inner(app, manager).await;
    manager.busy.store(false, Ordering::SeqCst);
    if let Err(error) = &result { let mut s = manager.status.lock().unwrap(); s.phase = "error".into(); s.error = Some(error.clone()); }
    publish(app, manager); result.map(|_| manager.status())
}
async fn check_inner(app: &AppHandle, manager: &UpdateManager) -> Result<(), String> {
    { let mut s = manager.status.lock().unwrap(); s.phase = "checking".into(); s.error = None; }
    publish(app, manager);
    let updater = app.updater_builder().timeout(Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        manager.status.lock().unwrap().phase = "current".into(); return Ok(());
    };
    // The fixed release repository is the only permitted download source.
    if update.download_url.scheme() != "https" || update.download_url.host_str() != Some("github.com") || !update.download_url.path().starts_with("/greenbeanpie/AI-Colleboration-Seminar/releases/download/") { return Err("Untrusted update location".into()); }
    let dir = cache_dir(app)?;
    let cached: Option<Cached> = std::fs::read(dir.join("manifest.json")).ok().and_then(|b| serde_json::from_slice(&b).ok());
    let reuse = cached.as_ref().is_some_and(|c| c.version == update.version && c.signature == update.signature);
    let bytes = if reuse {
        let b = std::fs::read(dir.join("installer.bin")).map_err(|e| e.to_string())?;
        verify(app, &b, &update.signature)?; b
    } else {
        { let mut s = manager.status.lock().unwrap(); s.phase = "downloading".into(); s.version = Some(update.version.clone()); s.downloaded_bytes = 0; }
        let b = update.download(|chunk, total| { let mut s = manager.status.lock().unwrap(); s.downloaded_bytes += chunk as u64; s.total_bytes = total; }, || {}).await.map_err(|e| e.to_string())?;
        std::fs::write(dir.join("installer.tmp"), &b).map_err(|e| e.to_string())?;
        if dir.join("installer.bin").exists() { std::fs::remove_file(dir.join("installer.bin")).map_err(|e| e.to_string())?; }
        std::fs::rename(dir.join("installer.tmp"), dir.join("installer.bin")).map_err(|e| e.to_string())?;
        std::fs::write(dir.join("manifest.json"), serde_json::to_vec(&Cached { version: update.version.clone(), signature: update.signature.clone() }).unwrap()).map_err(|e| e.to_string())?; b
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
pub async fn restart(app: &AppHandle) -> Result<(), String> { install_update(app, &app.state::<UpdateManager>()).await }
pub fn status(app: &AppHandle) -> UpdateStatus { app.state::<UpdateManager>().status() }
pub fn set_auto_restart(app: &AppHandle, enabled: bool) -> Result<(), String> { app.state::<UpdateManager>().set_auto_restart(app, enabled) }

#[cfg(test)]
mod tests { use super::*; #[test] fn default_requires_a_download() { let m = UpdateManager::default(); assert!(!m.ready()); assert!(m.auto_restart()); assert_eq!(m.status().phase, "idle"); } }
