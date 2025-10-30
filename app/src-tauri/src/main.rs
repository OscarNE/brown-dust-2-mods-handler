#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod catalog;
mod commands;
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
            commands::catalog_import_from_file,
            commands::catalog_list,
            commands::library_author_dirs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
