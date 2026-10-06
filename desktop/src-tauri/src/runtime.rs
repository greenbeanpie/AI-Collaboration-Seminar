use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, WebviewWindow};
pub const PRODUCTION_ORIGIN: &str = "https://greenbp-team-office.hddhp.workers.dev";
#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PageState {
    pub protocol: u32,
    pub account_id: Option<String>,
    pub dirty: bool,
    pub busy: bool,
    pub durable: bool,
    pub request_id: Option<u64>,
}
pub struct NativeState {
    pub page: Mutex<PageState>,
    pub active_transfers: AtomicUsize,
    pub exiting: AtomicBool,
    pub hidden_since: Mutex<Option<Instant>>,
    pub nonce: AtomicU64,
    pub auth_epoch: AtomicU64,
    pub preparing: AtomicBool,
}
impl Default for NativeState {
    fn default() -> Self {
        Self {
            page: Mutex::new(PageState::default()),
            active_transfers: AtomicUsize::new(0),
            exiting: AtomicBool::new(false),
            hidden_since: Mutex::new(None),
            nonce: AtomicU64::new(0),
            auth_epoch: AtomicU64::new(0),
            preparing: AtomicBool::new(false),
        }
    }
}
impl NativeState {
    pub fn safe(&self) -> bool {
        let p = self.page.lock().unwrap();
        p.protocol == 1
            && p.durable
            && !p.dirty
            && !p.busy
            && self.active_transfers.load(Ordering::SeqCst) == 0
    }
    pub fn hidden_idle(&self) -> bool {
        self.hidden_since
            .lock()
            .unwrap()
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(300))
    }
}
pub fn validate_source(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main"
        || window
            .url()
            .map_err(|e| e.to_string())?
            .origin()
            .ascii_serialization()
            != PRODUCTION_ORIGIN
    {
        return Err("Untrusted desktop command source".into());
    }
    Ok(())
}
pub fn dispatch(app: &AppHandle, name: &str, detail: serde_json::Value) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(
            format!(
                "window.dispatchEvent(new CustomEvent({},{{detail:{}}}))",
                serde_json::to_string(name).unwrap(),
                detail
            )
            .as_str(),
        );
    }
}
pub fn resume(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(|webview| {
            #[cfg(windows)]
            unsafe {
                use windows::core::Interface;
                if let Ok(v) = webview.controller().CoreWebView2().and_then(|c| {
                    c.cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3>()
                }) {
                    let _ = v.Resume();
                }
            }
        });
    }
}
pub fn show(app: &AppHandle, route: Option<&str>) {
    resume(app);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
        *app.state::<NativeState>().hidden_since.lock().unwrap() = None;
        if let Some(path) = route.filter(|p| safe_route(p)) {
            if let Ok(url) = format!("{PRODUCTION_ORIGIN}{path}").parse() {
                let _ = w.navigate(url);
            }
        }
        dispatch(app, "desktop-resume", serde_json::json!({}));
    }
}
pub fn safe_route(path: &str) -> bool {
    path.starts_with("/app")
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.contains(['\r', '\n'])
        && url::Url::parse(&format!("{PRODUCTION_ORIGIN}{path}")).is_ok_and(|u| {
            u.origin().ascii_serialization() == PRODUCTION_ORIGIN
                && (u.path() == "/app" || u.path().starts_with("/app/"))
        })
}
pub fn suspend(app: &AppHandle) {
    if !app.state::<NativeState>().safe() {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.with_webview(|webview| {
            #[cfg(windows)]
            unsafe {
                use webview2_com::{
                    Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler,
                };
                use windows::core::Interface;
                if let Ok(v) = webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast::<ICoreWebView2_3>())
                {
                    let callback = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                    let _ = v.TrySuspend(&callback);
                }
            }
        });
    }
}
pub async fn session_client(
    app: &AppHandle,
    expected_account: &str,
) -> Result<(reqwest::Client, String), String> {
    let w = app.get_webview_window("main").ok_or("Window unavailable")?;
    validate_source(&w)?;
    let origin = url::Url::parse(PRODUCTION_ORIGIN).map_err(|e| e.to_string())?;
    let cookies = tauri::async_runtime::spawn_blocking(move || w.cookies_for_url(origin))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let cookie = cookies
        .iter()
        .filter(|c| c.name() == "ai_office_session")
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    if cookie.is_empty() {
        return Err("Not authenticated".into());
    }
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::COOKIE,
        cookie.parse().map_err(|_| "Invalid session cookie")?,
    );
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(headers)
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(format!("{PRODUCTION_ORIGIN}/api/v1/auth/session"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if response.status() == 401 {
        return Err("Session expired".into());
    }
    let value: serde_json::Value = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    if value["data"]["user"]["id"].as_str() != Some(expected_account) {
        return Err("Account changed".into());
    }
    if app
        .state::<NativeState>()
        .page
        .lock()
        .unwrap()
        .account_id
        .as_deref()
        != Some(expected_account)
    {
        return Err("Account changed".into());
    }
    Ok((client, cookie))
}
pub fn open_external(url: &url::Url) {
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return;
    }
    #[cfg(windows)]
    unsafe {
        use windows::{
            core::PCWSTR,
            Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        };
        let verb: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = format!("{}\0", url).encode_utf16().collect();
        let _ = ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn safe_defaults() {
        assert!(!NativeState::default().safe());
    }
    #[test]
    fn routes() {
        assert!(safe_route("/app/projects/123"));
        for bad in [
            "//evil.test",
            "/application",
            "/app\\evil",
            "/app\n",
            "https://evil.test",
        ] {
            assert!(!safe_route(bad));
        }
    }
}
