//! Internal Android adapter. No plugin command is exposed by a web capability.
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    AppHandle, Manager, Wry,
};

static ACCOUNT_EPOCH: AtomicU64 = AtomicU64::new(0);
static FOREGROUND: AtomicBool = AtomicBool::new(true);
static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

#[no_mangle]
pub extern "system" fn Java_cn_buwei_mobile_RecordingService_recordingActivity(
    _env: *mut std::ffi::c_void,
    _this: *mut std::ffi::c_void,
    active: u8,
) {
    RECORDING_ACTIVE.store(active != 0, Ordering::Release);
}
#[no_mangle]
pub extern "system" fn Java_cn_buwei_mobile_RecordingService_accountEpoch(
    _env: *mut std::ffi::c_void,
    _this: *mut std::ffi::c_void,
) -> i64 {
    ACCOUNT_EPOCH.load(Ordering::Acquire) as i64
}
pub fn recording_active() -> bool {
    RECORDING_ACTIVE.load(Ordering::Acquire)
}

// JNI arguments are opaque; only the JVM boolean is read. Invoked from Activity callbacks.
#[no_mangle]
pub extern "system" fn Java_cn_buwei_mobile_NativeFilesPlugin_foregroundChanged(
    _env: *mut std::ffi::c_void,
    _this: *mut std::ffi::c_void,
    foreground: u8,
) {
    FOREGROUND.store(foreground != 0, Ordering::Release);
}
pub fn invalidate_session() {
    ACCOUNT_EPOCH.fetch_add(1, Ordering::AcqRel);
}
#[no_mangle]
pub extern "system" fn Java_cn_buwei_mobile_NativeFilesPlugin_accountEpoch(
    _env: *mut std::ffi::c_void,
    _this: *mut std::ffi::c_void,
) -> i64 {
    ACCOUNT_EPOCH.load(Ordering::Acquire) as i64
}
pub fn is_foreground() -> bool {
    FOREGROUND.load(Ordering::Acquire)
}

pub async fn recording(
    app: &AppHandle,
    command: &str,
    mut args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !matches!(
        command,
        "recordingCapabilities"
            | "recordingStart"
            | "recordingAction"
            | "recordingList"
            | "recordingExport"
            | "recordingRemove"
    ) {
        return Err("不支持的录制操作".into());
    }
    if command == "recordingStart" {
        args["accountEpoch"] = json!(ACCOUNT_EPOCH.load(Ordering::Acquire));
    }
    app.state::<AndroidAdapter>()
        .0
        .run_mobile_plugin_async(command, args)
        .await
        .map_err(|e| e.to_string())
}

struct AndroidAdapter(PluginHandle<Wry>);
pub fn init() -> TauriPlugin<Wry> {
    Builder::new("buwei-native-files")
        .setup(|app, api| {
            let handle = api.register_android_plugin("cn.buwei.mobile", "NativeFilesPlugin")?;
            app.manage(AndroidAdapter(handle));
            Ok(())
        })
        .build()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedFile {
    pub path: std::path::PathBuf,
    pub name: String,
    pub size_bytes: u64,
}
#[derive(Deserialize)]
pub struct Session {
    pub cookie: String,
    pub foreground: bool,
}
pub async fn session(app: &AppHandle) -> Result<Session, String> {
    app.state::<AndroidAdapter>()
        .0
        .run_mobile_plugin_async("session", json!({"origin": crate::PRODUCTION_ORIGIN}))
        .await
        .map_err(|e| e.to_string())
}
pub async fn pick_files(app: &AppHandle, max: usize) -> Result<Vec<PickedFile>, String> {
    app.state::<AndroidAdapter>()
        .0
        .run_mobile_plugin_async("pickFiles", json!({"maxFiles": max.min(10)}))
        .await
        .map_err(|e| e.to_string())
}
pub async fn export_file(
    app: &AppHandle,
    path: &std::path::Path,
    name: &str,
) -> Result<(), String> {
    app.state::<AndroidAdapter>()
        .0
        .run_mobile_plugin_async("exportFile", json!({"path":path, "name": name, "accountEpoch":ACCOUNT_EPOCH.load(Ordering::Acquire)}))
        .await
        .map_err(|e| e.to_string())
}
