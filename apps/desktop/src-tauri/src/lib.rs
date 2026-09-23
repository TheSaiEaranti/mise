//! Mise desktop shell (SPEC §1–§2).
//!
//! Tauri v2 wraps the Next.js UI — the dev server at :3000 in dev, the static
//! export in prod — and adds the two things a browser tab can't do well:
//! a tray icon and native notifications. All app logic lives in the web UI
//! and the API server; this shell stays deliberately thin.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Tray menu: Open Mise / ─── / Quit.
            let open = MenuItem::with_id(app, "open", "Open Mise", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

            TrayIconBuilder::with_id("main")
                .tooltip("Mise")
                .icon(
                    app.default_window_icon()
                        .expect("bundle icon is configured in tauri.conf.json")
                        .clone(),
                )
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        // Tray-app behavior: closing the window hides it instead of quitting.
        // Quit lives in the tray menu.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Mise");
}
