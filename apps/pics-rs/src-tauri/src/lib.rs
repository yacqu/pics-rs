mod commands;
mod error;

use std::path::Path;
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;

/// Holds a path the app was launched to open before the UI was ready — e.g. a
/// CLI argument or an OS "Open with" on cold start. The frontend drains it once
/// on mount via `take_pending_open` (spec §4.1, §4.10).
#[derive(Default)]
struct PendingOpen(Mutex<Option<String>>);

/// Pick the first CLI argument that points at a supported image file.
fn first_image_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1) // args[0] is the executable path
        .find(|a| {
            let p = Path::new(a);
            p.is_file() && commands::is_supported(p)
        })
        .cloned()
}

/// Drain and return the path the app was asked to open on launch, if any.
#[tauri::command]
fn take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();

    // The single-instance plugin MUST be registered first so a second launch
    // (e.g. double-clicking another image) forwards its path to the running
    // window instead of spawning a duplicate process (spec §8.8). Desktop only.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                if let Some(path) = first_image_arg(&argv) {
                    let _ = app.emit("open-image", path);
                }
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                }
            }))
            .plugin(tauri_plugin_decorum::init());
    }

    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PendingOpen::default())
        .setup(|app| {
            // Cold-start CLI arg: stash it for the frontend to pick up on mount.
            let args: Vec<String> = std::env::args().collect();
            if let Some(path) = first_image_arg(&args) {
                if let Some(state) = app.try_state::<PendingOpen>() {
                    if let Ok(mut guard) = state.0.lock() {
                        *guard = Some(path);
                    }
                }
            }

            // Push the macOS traffic lights down so they line up with the
            // toolbar icon row (which sits under the Overlay title bar). The
            // inset is re-applied on resize/fullscreen by the decorum delegate.
            #[cfg(target_os = "macos")]
            {
                use tauri_plugin_decorum::WebviewWindowExt;
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_traffic_lights_inset(20.0, 24.0);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            take_pending_open,
            commands::read_image_entry,
            commands::gallery::scan_folder,
            commands::thumbnail::get_thumbnail,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pics-rs application");
}
