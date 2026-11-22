// OTO desktop app on Tauri: a tray app that runs the OTO server (src/server.js on a bundled Node) and shows its control panel.
// The server, the overlay and the control panel are the same files as in the Electron app (electron/).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "portable")]
mod portable;
mod updater;

use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::sync::oneshot;

const DEFAULT_PORT: u16 = 6767; // src/config.js
const TRAY_ID: &str = "oto";
const MAX_RESTARTS: u32 = 3;
const MAX_PACKAGE_BYTES: u64 = 48 * 1024 * 1024; // as electron/main.js

// What the control panel page finds as window.electronAPI (the name the page already looks for)
const PAGE_BRIDGE: &str = r#"(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  let onPackage = null;
  const take = () => invoke('take_opened_packages').then((files) => files.forEach((f) => onPackage({ name: f.name, bytes: bytes(f.bytes) })));
  window.__otoTakePackages = () => { if (onPackage) take(); };
  window.electronAPI = {
    getAppSettings: () => invoke('get_app_settings'),
    setAppSetting: (key, value) => invoke('set_app_setting', { key, value }),
    onPackageOpened: (callback) => { onPackage = callback; take(); }
  };
})();"#;

// What to do once the server has saved and stopped, when OTO is not quitting
#[derive(Clone, Copy, PartialEq)]
enum Then {
    // it stopped by itself: start it again, a few times
    Nothing,
    // "Restart the service"
    Restart,
    // "Back up and start fresh": move the data folder aside first
    Fresh,
}

struct Server {
    child: Mutex<Option<CommandChild>>,
    quitting: AtomicBool,
    // quitting to install a downloaded update and start again ("Restart to update")
    restart: AtomicBool,
    then: Mutex<Then>,
    // counts the servers started, so a late "force it" never hits the next one
    generation: AtomicU32,
    ready: AtomicBool,
    // the server's last lines of output, shown when it cannot start (all of it goes to logs/desktop.log)
    output: Mutex<Vec<String>>,
    restarts: AtomicU32,
    // links for other devices, from the server's OTO_READY line: (network name, control panel URL)
    lan: Mutex<Vec<(String, String)>>,
    // { enabled, source } of the control panel password, from OTO_READY and OTO_PASSWORD lines
    password: Mutex<Value>,
    password_reply: Mutex<Option<oneshot::Sender<Value>>>,
    // .oto files opened from the file manager, waiting for the control panel to take them: (name, bytes)
    packages: Mutex<Vec<(String, Vec<u8>)>>,
    port: u16,
    data_dir: PathBuf,
}

fn main() {
    tauri::Builder::default()
        // a second OTO.exe hands over to this one; "OTO.exe --quit" (the installer) asks it to save and quit
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if argv.iter().any(|a| a == "--quit") {
                quit(app);
            } else if let Some(file) = package_in(&argv) {
                open_package(app, &file);
            } else {
                show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_settings,
            set_app_setting,
            take_opened_packages,
            save_password,
            close_password_window
        ])
        .setup(|app| {
            // The same folder as the Electron app (%APPDATA%\obs-tcg-overlay), so matches, designs and settings carry over
            let data_dir = std::env::var_os("OTO_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| app.path().data_dir().expect("no AppData folder").join("obs-tcg-overlay"));
            let port = std::env::var("OTO_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(DEFAULT_PORT);
            app.manage(Server {
                child: Mutex::new(None),
                quitting: AtomicBool::new(false),
                restart: AtomicBool::new(false),
                then: Mutex::new(Then::Nothing),
                generation: AtomicU32::new(0),
                ready: AtomicBool::new(false),
                output: Mutex::new(Vec::new()),
                restarts: AtomicU32::new(0),
                lan: Mutex::new(Vec::new()),
                password: Mutex::new(json!({ "enabled": false, "source": null })),
                password_reply: Mutex::new(None),
                packages: Mutex::new(Vec::new()),
                port,
                data_dir,
            });
            updater::init(app.handle())?;
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
            if let Some(file) = package_in(&std::env::args().collect::<Vec<_>>()) {
                open_package(app.handle(), &file);
            }
            start_server(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                api.prevent_close();
                if settings(window.app_handle())["keepInTray"].as_bool().unwrap_or(true) {
                    let _ = window.hide();
                } else {
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

// ---- the server ---------------------------------------------------------------------------------------------------

fn start_server(app: &AppHandle) -> tauri::Result<()> {
    let state = app.state::<Server>();
    let logs = state.data_dir.join("logs");
    let db_dir = state.data_dir.join("data");
    std::fs::create_dir_all(&logs)?;
    std::fs::create_dir_all(&db_dir)?;
    let (node, server_dir) = runtime(app)?;
    let script = server_dir.join("src").join("server.js");
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(logs.join("desktop.log")).ok();
    note(&mut log, &format!("starting {} {}", node.display(), script.display()));

    let (mut events, child) = app
        .shell()
        .command(node)
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
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.ready.store(false, Ordering::SeqCst);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    let line = line.trim_end();
                    note(&mut log, line);
                    let state = app.state::<Server>();
                    let mut output = state.output.lock().unwrap();
                    output.push(line.to_string());
                    let excess = output.len().saturating_sub(20);
                    output.drain(..excess);
                    drop(output);
                    if let Some(json) = line.strip_prefix("OTO_READY ") {
                        server_ready(&app, json);
                    } else if let Some(json) = line.strip_prefix("OTO_PASSWORD ") {
                        password_changed(&app, json);
                    }
                }
                CommandEvent::Error(error) => note(&mut log, &format!("error: {error}")),
                CommandEvent::Terminated(status) => {
                    note(&mut log, &format!("stopped: {status:?}"));
                    let state = app.state::<Server>();
                    state.child.lock().unwrap().take();
                    let then = std::mem::replace(&mut *state.then.lock().unwrap(), Then::Nothing);
                    if state.quitting.load(Ordering::SeqCst) {
                        updater::install_if_ready(&app, state.restart.load(Ordering::SeqCst));
                        app.exit(0);
                    } else if then != Then::Nothing {
                        if then == Then::Fresh {
                            move_data_aside(&app);
                        }
                        state.restarts.store(0, Ordering::SeqCst);
                        set_tooltip(&app, "OTO - starting");
                        if start_server(&app).is_err() {
                            server_failed(&app);
                        }
                    } else if state.restarts.fetch_add(1, Ordering::SeqCst) < MAX_RESTARTS {
                        set_tooltip(&app, "OTO - restarting");
                        if start_server(&app).is_err() {
                            server_failed(&app);
                        }
                    } else {
                        set_tooltip(&app, "OTO - the server stopped (see the logs folder)");
                        server_failed(&app);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

// Where Node and the server are: next to OTO.exe (the installer), or unpacked from OTO.exe itself (the portable exe)
fn runtime(app: &AppHandle) -> tauri::Result<(PathBuf, PathBuf)> {
    #[cfg(feature = "portable")]
    {
        return portable::unpack(&app.state::<Server>().data_dir, &app.package_info().version.to_string()).map_err(|e| tauri::Error::Anyhow(e.into()));
    }
    #[cfg(not(feature = "portable"))]
    {
        let exe_dir = std::env::current_exe()?.parent().map(Path::to_path_buf).unwrap_or_default();
        Ok((exe_dir.join(format!("node{}", std::env::consts::EXE_SUFFIX)), app.path().resource_dir()?.join("server")))
    }
}

fn note(log: &mut Option<std::fs::File>, line: &str) {
    use std::io::Write;
    if let Some(file) = log.as_mut() {
        let seconds = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(file, "[{seconds}] {line}");
    }
}

// The server could not start: say so, with what it said, instead of leaving an empty window
fn server_failed(app: &AppHandle) {
    let state = app.state::<Server>();
    let output = state.output.lock().unwrap().join("\n");
    let log = state.data_dir.join("logs").join("desktop.log");
    let text = format!(
        "OTO's server did not start, so the control panel and the overlay cannot open.\n\nWhat it said:\n{}\n\nAll of it is in {}",
        if output.is_empty() { "(nothing)".into() } else { output },
        log.display()
    );
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(format!("document.body.innerText = {}", json!(text)));
    }
    app.dialog().message(text).title("OTO could not start").kind(MessageDialogKind::Error).show(|_| {});
}

// One command line on the server's stdin (see the end of src/server.js)
fn tell_server(app: &AppHandle, line: &str) -> bool {
    match app.state::<Server>().child.lock().unwrap().as_mut() {
        Some(child) => child.write(format!("{line}\n").as_bytes()).is_ok(),
        None => false,
    }
}

fn server_ready(app: &AppHandle, json: &str) {
    let state = app.state::<Server>();
    let ready = serde_json::from_str::<Value>(json).unwrap_or_default();
    let lan = ready["lan"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|l| Some((l["name"].as_str()?.to_string(), l["control"].as_str()?.to_string())))
        .collect();
    *state.lan.lock().unwrap() = lan;
    if ready["password"].is_object() {
        *state.password.lock().unwrap() = ready["password"].clone();
    }
    state.ready.store(true, Ordering::SeqCst);
    set_tooltip(app, &format!("OTO - running on port {}", state.port));
    refresh_tray(app);
    // a window opened before the server was ready (or before a restart) shows the server's page now
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(control_url(state.port));
    }
    show_main_window(app);
}

// Stop the server the polite way (it saves first), then restart it or start fresh (see the Terminated event)
fn stop_then(app: &AppHandle, then: Then) {
    let state = app.state::<Server>();
    *state.then.lock().unwrap() = then;
    set_tooltip(app, "OTO - restarting");
    if !tell_server(app, "quit") {
        // no server running: start one now
        *state.then.lock().unwrap() = Then::Nothing;
        if then == Then::Fresh {
            move_data_aside(app);
        }
        let _ = start_server(app);
        return;
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        let state = app.state::<Server>();
        if state.generation.load(Ordering::SeqCst) == generation {
            if let Some(child) = state.child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}

// Move everything OTO has saved (matches, designs, sounds, card libraries, settings) into data-backup, data-backup-2, ...
// Nothing is deleted: the backup sits next to the data and can be moved back.
fn move_data_aside(app: &AppHandle) {
    let dir = app.state::<Server>().data_dir.clone();
    let data = dir.join("data");
    if !data.exists() {
        return;
    }
    let mut backup = dir.join("data-backup");
    let mut n = 2;
    while backup.exists() {
        backup = dir.join(format!("data-backup-{n}"));
        n += 1;
    }
    let name = backup.file_name().unwrap().to_string_lossy().into_owned();
    let (text, kind) = match std::fs::rename(&data, &backup) {
        Ok(()) => (format!("Your data was saved in {name}. OTO is starting fresh."), MessageDialogKind::Info),
        Err(error) => (format!("The data could not be moved: {error}"), MessageDialogKind::Error),
    };
    app.dialog().message(text).title("OTO").kind(kind).show(|_| {});
}

fn confirm_start_fresh(app: &AppHandle) {
    let app = app.clone();
    // asked without stopping anything: the overlay keeps working while the question is open
    app.dialog()
        .message("Your matches, designs, sounds, card libraries and settings are moved into a backup folder, not deleted. OTO restarts empty.")
        .title("Start again with empty data?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Back up and start fresh".into(), "Cancel".into()))
        .show(move |fresh| {
            if fresh {
                stop_then(&app, Then::Fresh);
            }
        });
}

fn password_changed(app: &AppHandle, json: &str) {
    let state = app.state::<Server>();
    let status = serde_json::from_str::<Value>(json).unwrap_or_default();
    if status["error"].is_null() {
        *state.password.lock().unwrap() = json!({ "enabled": status["enabled"], "source": status["source"] });
    }
    if let Some(reply) = state.password_reply.lock().unwrap().take() {
        let _ = reply.send(status);
    }
    refresh_tray(app);
}

// Save the match and the database (the server does it on "quit"), then leave; force it if the server does not answer
fn quit(app: &AppHandle) {
    let state = app.state::<Server>();
    if state.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    set_tooltip(app, "OTO - saving and closing");
    if !tell_server(app, "quit") {
        app.exit(0);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        if let Some(child) = app.state::<Server>().child.lock().unwrap().take() {
            let _ = child.kill();
            updater::install_if_ready(&app, app.state::<Server>().restart.load(Ordering::SeqCst));
        }
        app.exit(0);
    });
}

// ---- windows ------------------------------------------------------------------------------------------------------

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let port = app.state::<Server>().port;
    // until the server answers, a local page that says OTO is starting (server_ready moves the window on)
    let url = if app.state::<Server>().ready.load(Ordering::SeqCst) { WebviewUrl::External(control_url(port)) } else { WebviewUrl::App("index.html".into()) };
    let opener = app.clone();
    let new_window = app.clone();
    let _ = WebviewWindowBuilder::new(app, "main", url)
        .title("OTO")
        .inner_size(1280.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .initialization_script(PAGE_BRIDGE)
        // the window shows only OTO's own pages; any other link opens in the browser
        .on_navigation(move |url| {
            // (tauri.localhost is the app's own "starting" page on Windows)
            let own = (matches!(url.host_str(), Some("localhost" | "127.0.0.1")) && url.port() == Some(port)) || url.host_str() == Some("tauri.localhost");
            if !own && matches!(url.scheme(), "http" | "https") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            own || !matches!(url.scheme(), "http" | "https")
        })
        .on_new_window(move |url: Url, _| {
            let _ = new_window.opener().open_url(url.as_str(), None::<&str>);
            NewWindowResponse::Deny
        })
        .build();
}

fn control_url(port: u16) -> Url {
    format!("http://localhost:{port}/control").parse().unwrap()
}

fn open_password_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("password") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "password", WebviewUrl::App("password.html".into()))
        .title("OTO - Control panel password")
        .inner_size(440.0, 380.0)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .build();
}

fn confirm_remove_password(app: &AppHandle) {
    let app = app.clone();
    app.dialog()
        .message("Anyone who has the link to the control panel, on this network, will be able to produce without it.")
        .title("Remove the control panel password?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Remove the password".into(), "Cancel".into()))
        .show(move |remove| {
            if !remove {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = set_password(&app, "").await {
                    app.dialog().message(error).title("The password was not removed").kind(MessageDialogKind::Error).show(|_| {});
                }
            });
        });
}

// Set ("" removes) the control panel password in the server; everybody who was signed in has to sign in again, this window too
async fn set_password(app: &AppHandle, password: &str) -> Result<(), String> {
    let state = app.state::<Server>();
    let (reply, answer) = oneshot::channel();
    *state.password_reply.lock().unwrap() = Some(reply);
    if !tell_server(app, &json!({ "password": password }).to_string()) {
        return Err("OTO's server is not running.".into());
    }
    let status = tokio::time::timeout(Duration::from_secs(10), answer)
        .await
        .map_err(|_| "OTO's server did not answer.".to_string())?
        .map_err(|_| "OTO's server did not answer.".to_string())?;
    if let Some(error) = status["error"].as_str() {
        return Err(error.into());
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("location.reload()");
    }
    Ok(())
}

// ---- commands the pages call (capabilities/) ----------------------------------------------------------------------

#[tauri::command]
async fn save_password(app: AppHandle, password: String) -> Result<(), String> {
    if password.is_empty() {
        return Err("Write the password.".into());
    }
    set_password(&app, &password).await?;
    if let Some(window) = app.get_webview_window("password") {
        let _ = window.close();
    }
    Ok(())
}

#[tauri::command]
fn close_password_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("password") {
        let _ = window.close();
    }
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> Value {
    settings(&app)
}

#[tauri::command]
fn set_app_setting(app: AppHandle, key: String, value: Value) -> Result<Value, String> {
    if key != "keepInTray" || !value.is_boolean() {
        return Err(format!("Unknown setting: {key}"));
    }
    let mut values = settings(&app);
    values[key] = value;
    let file = app.state::<Server>().data_dir.join("app-settings.json");
    std::fs::write(file, serde_json::to_string_pretty(&values).unwrap()).map_err(|e| e.to_string())?;
    refresh_tray(&app);
    Ok(values)
}

#[tauri::command]
fn take_opened_packages(app: AppHandle) -> Vec<Value> {
    let files = std::mem::take(&mut *app.state::<Server>().packages.lock().unwrap());
    files
        .into_iter()
        .map(|(name, bytes)| json!({ "name": name, "bytes": base64::engine::general_purpose::STANDARD.encode(bytes) }))
        .collect()
}

// ---- desktop settings and .oto files ------------------------------------------------------------------------------

// The same app-settings.json as electron/app-settings.js, with its defaults; unknown keys and wrong types are ignored
fn settings(app: &AppHandle) -> Value {
    let file = app.state::<Server>().data_dir.join("app-settings.json");
    let saved = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or_default();
    let mut values = json!({ "keepInTray": true, "trayHintShown": false });
    for key in ["keepInTray", "trayHintShown"] {
        if saved[key].is_boolean() {
            values[key] = saved[key].clone();
        }
    }
    values
}

// The .oto file in a command line (a double click in the file manager), as electron/args.js
fn package_in(argv: &[String]) -> Option<String> {
    argv.iter().skip(1).find(|a| !a.starts_with('-') && a.to_lowercase().ends_with(".oto")).cloned()
}

// Read a .oto file and hand it to the control panel, which offers to install it
fn open_package(app: &AppHandle, file: &str) {
    let path = Path::new(file);
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let read = std::fs::metadata(path)
        .ok()
        .filter(|m| m.is_file() && m.len() <= MAX_PACKAGE_BYTES)
        .and_then(|_| std::fs::read(path).ok());
    let Some(bytes) = read else {
        app.dialog().message(format!("That file could not be opened: {name}")).title("OTO").kind(MessageDialogKind::Error).show(|_| {});
        return;
    };
    app.state::<Server>().packages.lock().unwrap().push((name, bytes));
    match app.get_webview_window("main") {
        // an open page takes it now; a page still loading takes it when it starts listening
        Some(window) => {
            let _ = window.eval("window.__otoTakePackages && window.__otoTakePackages()");
            show_main_window(app);
        }
        // before the server is ready the window opens by itself (server_ready)
        None if app.state::<Server>().ready.load(Ordering::SeqCst) => show_main_window(app),
        None => {}
    }
}

// ---- the tray -----------------------------------------------------------------------------------------------------

fn set_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(text));
    }
}

pub(crate) fn refresh_tray(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
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

    let password = state.password.lock().unwrap().clone();
    let (enabled, source) = (password["enabled"].as_bool().unwrap_or(false), password["source"].as_str().unwrap_or(""));
    let status = match (source, enabled) {
        ("environment", _) => "Set by OTO_PASSWORD: it cannot be changed here",
        (_, true) => "A password is set",
        _ => "No password: anyone who opens the link can produce",
    };
    let passwords = Submenu::with_id(app, "password", "Control panel password", true)?;
    passwords.append(&MenuItem::with_id(app, "password-status", status, false, None::<&str>)?)?;
    let set_label = if enabled { "Change the password…" } else { "Set a password…" };
    passwords.append(&MenuItem::with_id(app, "password-set", set_label, source != "environment", None::<&str>)?)?;
    passwords.append(&MenuItem::with_id(app, "password-remove", "Remove the password…", source == "stored", None::<&str>)?)?;

    let troubleshooting = Submenu::with_id_and_items(
        app,
        "troubleshooting",
        "Troubleshooting",
        true,
        &[
            &MenuItem::with_id(app, "restart", "Restart the service", true, None::<&str>)?,
            &MenuItem::with_id(app, "data", "Open the data folder", true, None::<&str>)?,
            &MenuItem::with_id(app, "logs", "Open the logs folder", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "fresh", "Back up and start fresh…", true, None::<&str>)?,
        ],
    )?;
    let keep = settings(app)["keepInTray"].as_bool().unwrap_or(true);
    let update = match (updater::ready_version(app), updater::status(app)) {
        (Some(version), _) => Some(MenuItem::with_id(app, "update", format!("Restart to update (v{version})"), true, None::<&str>)?),
        (None, Some(status)) => Some(MenuItem::with_id(app, "update-status", status, false, None::<&str>)?),
        (None, None) => None,
    };
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open the control panel", true, None::<&str>)?,
            &MenuItem::with_id(app, "overlay", "Open the overlay in the browser", true, None::<&str>)?,
            &share,
            &passwords,
            &PredefinedMenuItem::separator(app)?,
            &CheckMenuItem::with_id(app, "keep-in-tray", "Keep running in the tray when the window is closed", true, keep, None::<&str>)?,
            &troubleshooting,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit OTO", true, None::<&str>)?,
        ],
    )?;
    if let Some(update) = update {
        menu.insert(&update, menu.items()?.len() - 1)?;
    }
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let state = app.state::<Server>();
    match id {
        "open" => show_main_window(app),
        "overlay" => {
            let _ = app.opener().open_url(format!("http://localhost:{}/overlay", state.port), None::<&str>);
        }
        "password-set" => open_password_window(app),
        "password-remove" => confirm_remove_password(app),
        "keep-in-tray" => {
            let keep = settings(app)["keepInTray"].as_bool().unwrap_or(true);
            let _ = set_app_setting(app.clone(), "keepInTray".into(), Value::Bool(!keep));
        }
        "data" => {
            let _ = app.opener().open_path(state.data_dir.to_string_lossy(), None::<&str>);
        }
        "logs" => {
            let _ = app.opener().open_path(state.data_dir.join("logs").to_string_lossy(), None::<&str>);
        }
        "quit" => quit(app),
        "restart" => stop_then(app, Then::Restart),
        "fresh" => confirm_start_fresh(app),
        "update" => {
            state.restart.store(true, Ordering::SeqCst);
            quit(app);
        }
        _ => {
            if let Some(url) = id.strip_prefix("copy:") {
                let _ = app.clipboard().write_text(url.to_string());
            }
        }
    }
}
