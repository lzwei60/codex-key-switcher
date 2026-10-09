#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{menu::MenuBuilder, tray::TrayIconBuilder, Manager, RunEvent, WindowEvent};

mod codex;
mod commands;
mod credentials;
mod gateway;
mod migration_crypto;
mod providers;
mod storage;
mod usage;

struct ExitIntent(AtomicBool);

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(ExitIntent(AtomicBool::new(false)))
        .manage(credentials::SystemKeyring)
        .manage(gateway::GatewayState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_startup_settings,
            commands::app_save_startup_settings,
            commands::app_preferences,
            commands::app_save_preferences,
            commands::app_codex_config_directory,
            commands::app_save_codex_config_directory,
            commands::app_prepare_codex_sandbox,
            commands::app_check_for_updates,
            commands::app_open_update_download,
            commands::app_export_credential_migration,
            commands::app_import_credential_migration,
            commands::providers_list,
            commands::providers_export_metadata,
            commands::providers_export_metadata_file,
            commands::providers_import_metadata,
            commands::providers_import_metadata_file,
            commands::providers_save,
            commands::providers_delete,
            commands::providers_set_current,
            commands::providers_set_selected_model,
            commands::providers_validate_model,
            commands::providers_list_upstream_models,
            commands::gateway_status,
            commands::gateway_start,
            commands::gateway_stop,
            commands::gateway_settings,
            commands::gateway_save_settings,
            commands::gateway_check_port,
            commands::diagnostics_read,
            commands::diagnostics_resync_codex_config,
            commands::diagnostics_stop_and_restore_codex,
            commands::diagnostics_prepare_uninstall,
            commands::diagnostics_open_restore_directory,
            commands::diagnostics_copy_report,
            commands::usage_stats,
            commands::usage_clear_logs,
            commands::usage_settings,
            commands::usage_save_settings,
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = storage::PreviewStore::new(data_dir);
            store.ensure_preview_directory().map_err(|error| {
                std::io::Error::other(format!("Tauri preview storage setup failed: {error:?}"))
            })?;
            if let Err(error) = usage::migrate_legacy_json(store.preview_data_directory()) {
                if error.is_database_integrity_risk() {
                    return Err(std::io::Error::other(error.to_string()).into());
                }
                eprintln!("Tauri preview legacy usage migration skipped: {error}");
            }
            app.manage(store);
            app.manage(codex::CodexState::new(app.path().home_dir()?));
            let settings = app
                .state::<storage::PreviewStore>()
                .read_settings()
                .map_err(|error| {
                    std::io::Error::other(format!("Tauri preview settings read failed: {error:?}"))
                })?;
            let route = settings
                .get("routeSettings")
                .and_then(serde_json::Value::as_object);
            let auto_start = route
                .and_then(|value| value.get("autoStart"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
                && route
                    .and_then(|value| value.get("enabled"))
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
            if auto_start {
                let gateway = app.state::<gateway::GatewayState>();
                let store = app.state::<storage::PreviewStore>();
                let codex = app.state::<codex::CodexState>();
                if let Err(error) =
                    commands::start_enabled_connection_and_sync(&gateway, &store, &codex)
                {
                    eprintln!("Tauri preview auto-start skipped: {error:?}");
                }
            }
            let menu = MenuBuilder::new(app)
                .text("open", "打开主界面")
                .text("quit", "退出")
                .build()?;
            let mut tray = TrayIconBuilder::new()
                .tooltip("Codex Key Switcher Tauri Preview")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => {
                        app.state::<ExitIntent>().0.store(true, Ordering::Relaxed);
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            if std::env::args().any(|argument| argument == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri preview")
        .run(|app, event| {
            if let RunEvent::ExitRequested { api, .. } = event {
                if !app.state::<ExitIntent>().0.load(Ordering::Relaxed) {
                    api.prevent_exit();
                } else {
                    let stopped = commands::stop_gateway_runtime_and_restore(
                        &app.state::<gateway::GatewayState>(),
                        &app.state::<storage::PreviewStore>(),
                        &app.state::<codex::CodexState>(),
                    );
                    if stopped.is_err() {
                        api.prevent_exit();
                        app.state::<ExitIntent>().0.store(false, Ordering::Relaxed);
                        eprintln!("Tauri preview exit cancelled: stop or sandbox restore failed.");
                        show_main_window(app);
                    }
                }
            }
        });
}
