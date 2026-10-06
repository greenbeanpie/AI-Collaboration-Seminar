mod cache;
mod notifications;
mod runtime;
mod updater;
pub use runtime::{NativeState, PRODUCTION_ORIGIN};
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, WebviewWindow, WindowEvent,
};
#[tauri::command]
fn desktop_hello(window: WebviewWindow, app: AppHandle) -> Result<serde_json::Value, String> {
    runtime::validate_source(&window)?;
    let manager = app.state::<updater::UpdateManager>();
    Ok(
        serde_json::json!({"protocol":1,"version":app.package_info().version.to_string(),"updateState":manager.status(),"autoRestart":manager.auto_restart()}),
    )
}
#[tauri::command]
fn desktop_report_state(
    window: WebviewWindow,
    app: AppHandle,
    state: runtime::PageState,
) -> Result<(), String> {
    runtime::validate_source(&window)?;
    if state.protocol != 1 {
        return Err("Unsupported desktop protocol".into());
    }
    let native = app.state::<NativeState>();
    *native.page.lock().unwrap() = state;
    if native.hidden_since.lock().unwrap().is_some() && !native.preparing.load(Ordering::SeqCst) {
        runtime::suspend(&app);
    }
    Ok(())
}
#[tauri::command]
fn desktop_update_state(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    runtime::validate_source(&window)?;
    Ok(
        serde_json::to_value(app.state::<updater::UpdateManager>().status())
            .map_err(|e| e.to_string())?,
    )
}
#[tauri::command]
async fn desktop_check_update(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    runtime::validate_source(&window)?;
    let status = updater::check_update(&app, &app.state::<updater::UpdateManager>()).await?;
    serde_json::to_value(status).map_err(|e| e.to_string())
}
async fn safe_install(app: AppHandle, interactive: bool) -> Result<(), String> {
    let native = app.state::<NativeState>();
    if native.preparing.swap(true, Ordering::SeqCst) {
        return Err("Update preparation already active".into());
    }
    let nonce = native.nonce.fetch_add(1, Ordering::SeqCst) + 1;
    if interactive {
        runtime::show(&app, None);
    } else {
        runtime::resume(&app);
    }
    runtime::dispatch(
        &app,
        "desktop-prepare-update",
        serde_json::json!({"requestId":nonce}),
    );
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let confirmed = native.page.lock().unwrap().request_id == Some(nonce);
        if confirmed && native.safe() {
            let result =
                updater::install_update(&app, &app.state::<updater::UpdateManager>()).await;
            native.preparing.store(false, Ordering::SeqCst);
            return result;
        }
    }
    native.preparing.store(false, Ordering::SeqCst);
    runtime::suspend(&app);
    Err("请先保存编辑并等待传输完成".into())
}
#[tauri::command]
async fn desktop_restart_update(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    runtime::validate_source(&window)?;
    safe_install(app, true).await
}
#[tauri::command]
fn desktop_set_auto_restart(
    window: WebviewWindow,
    app: AppHandle,
    enabled: bool,
) -> Result<(), String> {
    runtime::validate_source(&window)?;
    app.state::<updater::UpdateManager>()
        .set_auto_restart(&app, enabled)
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            runtime::show(app, None)
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(NativeState::default())
        .manage(cache::CacheState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_hello,
            desktop_report_state,
            desktop_update_state,
            desktop_check_update,
            desktop_restart_update,
            desktop_set_auto_restart,
            cache::desktop_list_files,
            cache::desktop_stage_files,
            cache::desktop_cache_project,
            cache::desktop_pause_file,
            cache::desktop_resume_file,
            cache::desktop_remove_file,
            cache::desktop_export_file,
            cache::desktop_cache_usage,
            cache::desktop_transfer_files,
            cache::desktop_pending_files
        ])
        .setup(|app| {
            let data = app.path().app_local_data_dir()?.join("webview");
            std::fs::create_dir_all(&data)?;
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(PRODUCTION_ORIGIN.parse()?),
            )
            .title("补位")
            .inner_size(1120., 780.)
            .min_inner_size(760., 520.)
            .data_directory(data)
            .on_navigation(|url| url.origin().ascii_serialization() == PRODUCTION_ORIGIN)
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    *window.state::<NativeState>().page.lock().unwrap() =
                        runtime::PageState::default();
                }
            })
            .build()?;
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "open", "打开", true, None::<&str>)?,
                    &MenuItem::with_id(app, "notifications", "通知", true, None::<&str>)?,
                    &MenuItem::with_id(app, "check", "检查更新", true, None::<&str>)?,
                    &MenuItem::with_id(app, "restart", "重启更新", true, None::<&str>)?,
                    &MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("Missing icon")?.clone())
                .tooltip("补位")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => runtime::show(app, None),
                    "notifications" => runtime::show(app, Some("/app/notifications")),
                    "exit" => {
                        app.state::<NativeState>()
                            .exiting
                            .store(true, Ordering::SeqCst);
                        app.exit(0);
                    }
                    "check" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ =
                                updater::check_update(&app, &app.state::<updater::UpdateManager>())
                                    .await;
                        });
                    }
                    "restart" => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = safe_install(app, true).await;
                        });
                    }
                    _ => {}
                })
                .build(app)?;
            updater::setup(app.handle())?;
            notifications::start(app.handle().clone());
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    if handle.state::<NativeState>().exiting.load(Ordering::SeqCst) {
                        break;
                    }
                    let _ = cache::resume_account_transfers(&handle).await;
                    let native = handle.state::<NativeState>();
                    let manager = handle.state::<updater::UpdateManager>();
                    if native.hidden_idle()
                        && native.safe()
                        && manager.ready()
                        && manager.auto_restart()
                    {
                        let _ = safe_install(handle.clone(), false).await;
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle();
                *app.state::<NativeState>().hidden_since.lock().unwrap() =
                    Some(std::time::Instant::now());
                let _ = window.hide();
                runtime::dispatch(app, "desktop-hidden", serde_json::json!({}));
                runtime::suspend(app);
            }
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime failed");
}
