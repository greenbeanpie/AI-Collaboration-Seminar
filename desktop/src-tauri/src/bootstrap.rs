//! Bundled startup/recovery UI. Business data stays on the existing remote origin.
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewWindow};

#[cfg(target_os = "android")]
const LOCAL_ORIGIN: &str = "https://tauri.localhost";
#[cfg(not(target_os = "android"))]
const LOCAL_ORIGIN: &str = "http://tauri.localhost";
const STARTUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

#[derive(Default)]
pub struct BootstrapState {
    generation: AtomicU64,
    ready: AtomicBool,
}

fn local_source(url: &url::Url) -> bool {
    url.origin().ascii_serialization() == LOCAL_ORIGIN
        && matches!(url.path(), "/" | "/index.html")
        && matches!(url.query(), None | Some("recovery=1"))
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn navigation_allowed(url: &url::Url) -> bool {
    local_source(url) || url.origin().ascii_serialization() == crate::PRODUCTION_ORIGIN
}

#[tauri::command]
pub fn desktop_open_app(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" || !local_source(&window.url().map_err(|e| e.to_string())?) {
        return Err("Untrusted startup command source".into());
    }
    // Always try the original origin: its service worker may open cached content offline.
    // A network preflight or a new origin would block offline use or hide existing data.
    let target = crate::PRODUCTION_ORIGIN
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;
    // Arm recovery even if a transport failure occurs before PageLoadEvent::Started.
    page_started(&window, &target);
    window.navigate(target).map_err(|e| e.to_string())
}

pub fn ready(app: &AppHandle) {
    app.state::<BootstrapState>()
        .ready
        .store(true, Ordering::SeqCst);
}

fn should_recover(state: &BootstrapState, generation: u64) -> bool {
    state.generation.load(Ordering::SeqCst) == generation && !state.ready.load(Ordering::SeqCst)
}

pub fn page_started(window: &WebviewWindow, url: &url::Url) {
    let app = window.app_handle().clone();
    let Some(generation) = start_generation(&app.state::<BootstrapState>(), url) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(STARTUP_TIMEOUT).await;
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if should_recover(&app.state::<BootstrapState>(), generation) {
            // Navigation events cancel older attempts; a successful native handshake,
            // including one from a cached offline app, cancels recovery.
            // System error documents can have a browser-internal URL. Generation
            // cancellation, rather than that URL, ties recovery to this attempt.
            crate::runtime::diagnostic(
                &app,
                "startup",
                "Showing bundled recovery after startup timeout",
            );
            if let Ok(recovery) = format!("{LOCAL_ORIGIN}/index.html?recovery=1").parse() {
                let _ = window.navigate(recovery);
            }
        }
    });
}

fn start_generation(state: &BootstrapState, url: &url::Url) -> Option<u64> {
    let remote = url.origin().ascii_serialization() == crate::PRODUCTION_ORIGIN;
    if !remote && !local_source(url) {
        // Browser-internal error pages belong to the existing attempt. They must
        // not cancel its recovery timer or become a newly trusted startup source.
        return None;
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.ready.store(false, Ordering::SeqCst);
    remote.then_some(generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_navigation_has_a_narrow_local_allowlist() {
        for target in [
            format!("{LOCAL_ORIGIN}/"),
            format!("{LOCAL_ORIGIN}/index.html?recovery=1"),
            crate::PRODUCTION_ORIGIN.to_string(),
        ] {
            assert!(navigation_allowed(&target.parse().unwrap()), "{target}");
        }
        for target in [
            format!("{LOCAL_ORIGIN}/other.html"),
            format!("{LOCAL_ORIGIN}/?redirect=https://evil.test"),
            format!("{LOCAL_ORIGIN}.evil.test/"),
            LOCAL_ORIGIN.replace("://", "://user@"),
            format!("{LOCAL_ORIGIN}/#script"),
            "https://evil.test/".into(),
        ] {
            assert!(!navigation_allowed(&target.parse().unwrap()), "{target}");
        }
        assert!(!local_source(&crate::PRODUCTION_ORIGIN.parse().unwrap()));
    }

    #[test]
    fn cached_handshake_and_new_navigation_cancel_timeout() {
        let state = BootstrapState::default();
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        assert!(should_recover(&state, generation));
        state.ready.store(true, Ordering::SeqCst);
        assert!(!should_recover(&state, generation));
        state.ready.store(false, Ordering::SeqCst);
        state.generation.fetch_add(1, Ordering::SeqCst);
        assert!(!should_recover(&state, generation));
        assert!(should_recover(&state, generation + 1));
    }

    #[test]
    fn browser_error_document_keeps_the_failed_attempt_recovery_armed() {
        let state = BootstrapState::default();
        let generation =
            start_generation(&state, &crate::PRODUCTION_ORIGIN.parse().unwrap()).unwrap();
        for target in [
            "chrome-error://chromewebdata/",
            "about:blank",
            "https://evil.test/",
        ] {
            assert_eq!(start_generation(&state, &target.parse().unwrap()), None);
            assert!(should_recover(&state, generation));
        }
        assert_eq!(
            start_generation(
                &state,
                &format!("{LOCAL_ORIGIN}/index.html?recovery=1")
                    .parse()
                    .unwrap()
            ),
            None
        );
        assert!(!should_recover(&state, generation));
    }
}
