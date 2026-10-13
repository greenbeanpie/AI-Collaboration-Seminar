use crate::{cache, runtime, NativeState};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
fn desktop_hello(window: WebviewWindow, app: AppHandle) -> Result<serde_json::Value, String> {
    runtime::validate_source(&window)?;
    crate::bootstrap::ready(&app);
    Ok(
        serde_json::json!({"protocol":1,"version":app.package_info().version.to_string(),
        "platform":"android","capabilities":{"attachments":true,"updater":false,"tray":false},
        "autoRestart":false,"updateState":{"phase":"idle","downloadedBytes":0,"autoRestart":false}}),
    )
}

#[tauri::command]
fn mobile_set_foreground(
    window: WebviewWindow,
    app: AppHandle,
    foreground: bool,
) -> Result<(), String> {
    runtime::validate_source(&window)?;
    app.state::<NativeState>()
        .foreground
        .store(foreground, Ordering::SeqCst);
    if foreground {
        tauri::async_runtime::spawn(async move {
            let _ = cache::resume_account_transfers(&app).await;
        });
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(crate::android::init())
        .manage(NativeState::default())
        .manage(crate::bootstrap::BootstrapState::default())
        .manage(cache::CacheState::default())
        .manage(crate::recording::RecordingState::default())
        .invoke_handler(tauri::generate_handler![
            crate::bootstrap::desktop_open_app,
            desktop_hello,
            crate::desktop_report_state,
            mobile_set_foreground,
            crate::recording::recording_capabilities,
            crate::recording::recording_start,
            crate::recording::recording_action,
            crate::recording::recording_list,
            crate::recording::recording_export,
            crate::recording::recording_preview,
            crate::recording::recording_export_tail,
            crate::recording::recording_upload,
            crate::recording::recording_remove,
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
            runtime::diagnostic(
                app.handle(),
                "Android lifecycle",
                "Starting foreground client; background transfers pause",
            );
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("补位")
            // Only the new bundled startup page uses this origin; remote account
            // data keeps its original HTTPS origin and WebView profile.
            .use_https_scheme(true)
            .on_navigation(crate::bootstrap::navigation_allowed)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_page_load(|window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Started {
                    crate::bootstrap::page_started(&window, payload.url());
                    // Navigation clears identity before the next page reports it. Stop old exports immediately.
                    crate::android::invalidate_session();
                    *window.state::<NativeState>().page.lock().unwrap() =
                        runtime::PageState::default();
                }
            })
            .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    if handle.state::<NativeState>().exiting.load(Ordering::SeqCst) {
                        break;
                    }
                    if crate::android::is_foreground()
                        && handle
                            .state::<NativeState>()
                            .foreground
                            .load(Ordering::SeqCst)
                    {
                        let _ = cache::resume_account_transfers(&handle).await;
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Android runtime failed")
        .run(|app, event| {
            if let tauri::RunEvent::Resumed = event {
                app.state::<NativeState>()
                    .foreground
                    .store(true, Ordering::SeqCst);
                runtime::dispatch(app, "desktop-resume", serde_json::json!({}));
            }
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<NativeState>()
                    .exiting
                    .store(true, Ordering::SeqCst);
            }
        });
}
