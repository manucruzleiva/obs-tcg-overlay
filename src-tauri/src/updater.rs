// Over-the-air updates from GitHub Releases (tauri-plugin-updater), as electron/updater.js does for the Electron app.
//
// OTO is often used live on stream, so it never restarts by itself: an update downloads in the background and is installed
// the next time OTO quits, or right away from "Restart to update" in the tray.
// Off when the build has no updater key (tauri.updater.conf.json), in debug builds, in the portable folder (no uninstall.exe
// next to OTO.exe: it cannot replace itself), and with OBS_TCG_DISABLE_UPDATES=1.

use std::{sync::Mutex, time::Duration};

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

const FIRST_CHECK_DELAY: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Default)]
pub struct Updates {
    // what the tray says: None (nothing to show), "Checking for updates…", "Downloading v1.2.3…"
    pub status: Mutex<Option<String>>,
    // a downloaded update, waiting for OTO to quit: (update, installer bytes)
    pub ready: Mutex<Option<(Update, Vec<u8>)>>,
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    app.manage(Updates::default());
    let configured = app.config().plugins.0.get("updater").and_then(|u| u["pubkey"].as_str()).is_some_and(|k| !k.is_empty());
    let installed = std::env::current_exe().ok().and_then(|exe| Some(exe.parent()?.join("uninstall.exe").exists())).unwrap_or(false);
    if !configured || !installed || cfg!(debug_assertions) || std::env::var("OBS_TCG_DISABLE_UPDATES").as_deref() == Ok("1") {
        return Ok(());
    }
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
    Ok(())
}

async fn check(app: &AppHandle) {
    let updates = app.state::<Updates>();
    if updates.ready.lock().unwrap().is_some() {
        return;
    }
    set_status(app, Some("Checking for updates…".into()));
    let found = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let update = match found {
        Ok(Some(update)) => update,
        Ok(None) => return set_status(app, None),
        Err(error) => {
            eprintln!("[Updater] check failed: {error}");
            return set_status(app, None);
        }
    };
    set_status(app, Some(format!("Downloading v{}…", update.version)));
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            *updates.ready.lock().unwrap() = Some((update, bytes));
            set_status(app, None);
        }
        Err(error) => {
            eprintln!("[Updater] download failed: {error}");
            set_status(app, None);
        }
    }
}

fn set_status(app: &AppHandle, status: Option<String>) {
    *app.state::<Updates>().status.lock().unwrap() = status;
    crate::refresh_tray(app);
}

// The version waiting to be installed, for the tray's "Restart to update (v…)"
pub fn ready_version(app: &AppHandle) -> Option<String> {
    app.state::<Updates>().ready.lock().unwrap().as_ref().map(|(update, _)| update.version.clone())
}

pub fn status(app: &AppHandle) -> Option<String> {
    app.state::<Updates>().status.lock().unwrap().clone()
}

// Called once the server has saved and stopped: runs the installer (which ends OTO) when an update is waiting.
// `restart`: OTO starts again after the update ("Restart to update"), rather than staying closed (a plain quit).
pub fn install_if_ready(app: &AppHandle, restart: bool) {
    let ready = app.state::<Updates>().ready.lock().unwrap().take();
    if let Some((update, bytes)) = ready {
        if let Err(error) = update.restart_after_install(restart).install(bytes) {
            eprintln!("[Updater] install failed: {error}");
        }
    }
}
