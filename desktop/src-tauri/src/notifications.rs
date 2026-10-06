use crate::runtime::{self, NativeState};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::Ordering,
    time::Duration,
};
use tauri::{AppHandle, Manager};
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut seen: HashMap<String, HashSet<String>> = HashMap::new();
        let mut blocked: Option<(String, u64)> = None;
        let mut previous: Option<(String, u64)> = None;
        let mut delay = 60;
        loop {
            tokio::time::sleep(Duration::from_secs(delay)).await;
            if app.state::<NativeState>().exiting.load(Ordering::SeqCst) {
                break;
            }
            let account = app
                .state::<NativeState>()
                .page
                .lock()
                .unwrap()
                .account_id
                .clone();
            let Some(account) = account else {
                blocked = None;
                continue;
            };
            let epoch = app.state::<NativeState>().auth_epoch.load(Ordering::SeqCst);
            let identity = (account.clone(), epoch);
            if previous.as_ref() != Some(&identity) {
                seen.clear();
                blocked = None;
                previous = Some(identity.clone());
            }
            if blocked.as_ref() == Some(&identity) {
                continue;
            }
            match poll(&app, &account, &mut seen).await {
                Ok(()) => delay = 60,
                Err(e) if e == "Session expired" => {
                    blocked = Some(identity);
                    delay = 60;
                }
                Err(_) => delay = (delay * 2).min(300),
            }
        }
    });
}
async fn poll(
    app: &AppHandle,
    account: &str,
    seen: &mut HashMap<String, HashSet<String>>,
) -> Result<(), String> {
    let (client, _) = runtime::session_client(app, account).await?;
    let settings: serde_json::Value = client
        .get(format!(
            "{}/api/v1/notifications/settings",
            runtime::PRODUCTION_ORIGIN
        ))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let enabled = settings["data"]["pushEnabled"].as_bool().unwrap_or(false);
    let response = client
        .get(format!(
            "{}/api/v1/notifications?limit=100",
            runtime::PRODUCTION_ORIGIN
        ))
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
    let items = value["data"]["items"]
        .as_array()
        .ok_or("Invalid notification list")?;
    if app
        .state::<NativeState>()
        .page
        .lock()
        .unwrap()
        .account_id
        .as_deref()
        != Some(account)
    {
        return Ok(());
    }
    let first = !seen.contains_key(account);
    let ids = seen.entry(account.to_string()).or_default();
    let mut count = 0;
    let mut route = "/app/settings/notifications".to_string();
    for item in items {
        let Some(id) = item["id"].as_str() else {
            continue;
        };
        if ids.insert(id.to_string())
            && !first
            && item["readAt"].is_null()
            && item["dismissedAt"].is_null()
        {
            count += 1;
            if let Some(path) = item["url"].as_str().filter(|p| runtime::safe_route(p)) {
                route = path.into();
            }
        }
    }
    if ids.len() > 2000 {
        *ids = items
            .iter()
            .filter_map(|i| i["id"].as_str().map(str::to_string))
            .collect();
    }
    if count > 0 && enabled {
        toast(app.clone(), account.to_string(), count, route);
    }
    Ok(())
}
fn toast(app: AppHandle, account: String, count: u32, route: String) {
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            let title = "补位";
            let body = format!("收到 {count} 条新通知");
            let toast = tauri_winrt_notification::Toast::new("cn.buwei.desktop")
                .title(title)
                .text1(&body)
                .on_activated(move |_| {
                    if app
                        .state::<NativeState>()
                        .page
                        .lock()
                        .unwrap()
                        .account_id
                        .as_deref()
                        == Some(account.as_str())
                    {
                        runtime::show(&app, Some(&route));
                    }
                    Ok(())
                });
            let _ = toast.show();
        });
    }
}
