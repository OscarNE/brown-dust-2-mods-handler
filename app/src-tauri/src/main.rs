#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod crawler;
mod db;
mod types;

#[tauri::command]
fn app_version(app_handle: tauri::AppHandle) -> String {
    app_handle.package_info().version.to_string()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            commands::db_init,
            commands::mods_add,
            commands::mods_list,
            commands::mods_set_installed,
            commands::settings_get,
            commands::settings_set,
            commands::paths_rescan,
            commands::mods_import_dry_run,
            commands::mods_import_commit,
            // crawler
            commands::crawler_get_sources,
            commands::crawler_set_sources,
            commands::crawler_run_now,
            commands::crawler_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
