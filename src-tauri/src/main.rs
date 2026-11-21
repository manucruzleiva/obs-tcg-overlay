// OTO desktop app on Tauri: a tray app that runs the OTO server (src/server.js on a bundled Node) and shows its control panel.
// Prototype that sits next to electron/: the server, the overlay and the control panel are the same files.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
};

use serde_json::Value;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const DEFAULT_PORT: u16 = 6767; // src/config.js
const TRAY_ID: &str = "oto";
const MAX_RESTARTS: u32 = 3;

struct Server {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    restarts: AtomicU32,
    // links for other devices, from the server's OTO_READY line: (network name, control panel URL)
    lan: Mutex<Vec<(String, String)>>,
    port: u16,
    data_dir: PathBuf,
}

fn main() {
    tauri::Builder::default()
        // a second OTO.exe hands over to this one; "OTO.exe --quit" (the installer) asks it to save and quit
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--quit") {
                quit(app);
            } else {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // The same folder as the Electron app (%APPDATA%\obs-tcg-overlay), so matches, designs and settings carry over
            let data_dir = std::env::var_os("OTO_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| app.path().data_dir().expect("no AppData folder").join("obs-tcg-overlay"));
            let port = std::env::var("OTO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
            app.manage(Server {
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                restarts: AtomicU32::new(0),
                lan: Mutex::new(Vec::new()),
                port,
                data_dir,
            });
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(app.default_window_icon().expect("icons/icon.ico").clone())
                .tooltip("OTO - starting")
                .menu(&tray_menu(app.handle())?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            start_server(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && keep_in_tray(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                } else if window.label() == "main" {
                    api.prevent_close();
                    quit(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("OTO could not start")
        .run(|app, event| match event {
            // the window is only hidden, so this comes from quit(); anything else keeps the tray app alive
            RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
            // last resort: never leave a server running without the app
            RunEvent::Exit => {
                if let Some(child) = app.state::<Server>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}

fn start_server(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Server>();
    let logs = state.data_dir.join("logs");
    let db_dir = state.data_dir.join("data");
    std::fs::create_dir_all(&logs)?;
    std::fs::create_dir_all(&db_dir)?;
    let script = app.path().resource_dir()?.join("server").join("src").join("server.js");

    let (mut events, child) = app
        .shell()
        .sidecar("node")
        .map_err(|e| tauri::Error::Anyhow(e.into()))?
        .arg(script)
        .envs([
            ("OTO_DESKTOP_CHILD", "1".into()),
            ("PORT", state.port.to_string()),
            ("LOG_DIR", logs.to_string_lossy().into_owned()),
            ("DB_PATH", db_dir.join("overlay.sqlite").to_string_lossy().into_owned()),
        ])
        .spawn()
        .map_err(|e| tauri::Error::Anyhow(e.into()))?;
    *state.child.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(json) = line.trim().strip_prefix("OTO_READY ") {
                        server_ready(&app, json);
                    }
                }
                CommandEvent::Stderr(line) => eprint!("{}", String::from_utf8_lossy(&line)),
                CommandEvent::Terminated(status) => {
                    let state = app.state::<Server>();
                    state.child.lock().unwrap().take();
                    if state.quitting.load(Ordering::SeqCst) {
                        app.exit(0);
                    } else if state.restarts.fetch_add(1, Ordering::SeqCst) < MAX_RESTARTS {
                        eprintln!("[OTO] the server stopped ({status:?}); starting it again");
                        set_tooltip(&app, "OTO - restarting");
                        let _ = start_server(&app);
                    } else {
                        eprintln!("[OTO] the server keeps stopping ({status:?}); see the logs folder");
                        set_tooltip(&app, "OTO - the server stopped (see the logs folder)");
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

fn server_ready(app: &AppHandle, json: &str) {
    let state = app.state::<Server>();
    let lan = serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|v| v["lan"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|l| Some((l["name"].as_str()?.to_string(), l["control"].as_str()?.to_string())))
        .collect();
    *state.lan.lock().unwrap() = lan;
    set_tooltip(app, &format!("OTO - running on port {}", state.port));
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
    show_main_window(app);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let url = format!("http://localhost:{}/control", app.state::<Server>().port);
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
        .title("OTO")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build();
}

// Save the match and the database (the server does it on "quit"), then leave; force it if the server does not answer
fn quit(app: &AppHandle) {
    let state = app.state::<Server>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    set_tooltip(app, "OTO - saving and closing");
    let wrote = match state.child.lock().unwrap().as_mut() {
        Some(child) => child.write(b"quit\n").is_ok(),
        None => false,
    };
    if !wrote {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if let Some(child) = app.state::<Server>().child.lock().unwrap().take() {
            let _ = child.kill();
        }
        app.exit(0);
    });
}

fn keep_in_tray(app: &AppHandle) -> bool {
    // the same app-settings.json as electron/app-settings.js (default: keep running in the tray)
    let file = app.state::<Server>().data_dir.join("app-settings.json");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v["keepInTray"].as_bool())
        .unwrap_or(true)
}

fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<Server>();
    let lan = state.lan.lock().unwrap().clone();
    let share = Submenu::with_id(app, "share", "Copy the control panel link for another device", true)?;
    if lan.is_empty() {
        share.append(&MenuItem::with_id(app, "no-lan", "No network connection found", false, None::<&str>)?)?;
    }
    for (name, url) in &lan {
        share.append(&MenuItem::with_id(app, format!("copy:{url}"), format!("{url}  ({name})"), true, None::<&str>)?)?;
    }
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open the control panel", true, None::<&str>)?,
            &MenuItem::with_id(app, "overlay", "Open the overlay in the browser", true, None::<&str>)?,
            &share,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "data", "Open the data folder", true, None::<&str>)?,
            &MenuItem::with_id(app, "logs", "Open the logs folder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit OTO", true, None::<&str>)?,
        ],
    )
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Server>();
    match id {
        "open" => show_main_window(app),
        "overlay" => {
            let _ = app.opener().open_url(format!("http://localhost:{}/overlay", state.port), None::<&str>);
        }
        "data" => {
            let _ = app.opener().open_path(state.data_dir.to_string_lossy(), None::<&str>);
        }
        "logs" => {
            let _ = app.opener().open_path(state.data_dir.join("logs").to_string_lossy(), None::<&str>);
        }
        "quit" => quit(app),
        _ => {
            if let Some(url) = id.strip_prefix("copy:") {
                let _ = app.clipboard().write_text(url.to_string());
            }
        }
    }
}
