fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_hello",
            "desktop_report_state",
            "desktop_update_state",
            "desktop_check_update",
            "desktop_restart_update",
            "desktop_set_auto_restart",
            "desktop_list_files",
            "desktop_stage_files",
            "desktop_cache_project",
            "desktop_pause_file",
            "desktop_resume_file",
            "desktop_remove_file",
            "desktop_export_file",
            "desktop_cache_usage",
            "desktop_transfer_files",
            "desktop_pending_files",
        ]),
    ))
    .expect("failed to build desktop permissions");
}
