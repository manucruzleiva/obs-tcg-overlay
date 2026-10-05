/**
 * Over-the-air updates via GitHub Releases (electron-updater).
 *
 * Works for the NSIS installer build only. It is a no-op for portable builds
 * (they cannot replace themselves) and for runs from source.
 *
 * Because this app is often used live on stream, it never restarts by itself:
 * updates download in the background and are installed the next time the app
 * quits, or when the user picks "Restart to update" from the tray menu.
 *
 * Opt out with the environment variable OBS_TCG_DISABLE_UPDATES=1.
 */

const { app, Notification } = require('electron');

const FIRST_CHECK_DELAY_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let onChange = () => {};
let state = { status: 'disabled', version: null };

// Why updates are off, or null when they are on
function disabledReason(env = process.env, isPackaged = app.isPackaged) {
  if (!isPackaged) return 'running from source';
  if (env.PORTABLE_EXECUTABLE_FILE) return 'portable build';
  if (env.OBS_TCG_DISABLE_UPDATES === '1') return 'disabled by OBS_TCG_DISABLE_UPDATES';
  return null;
}

function setState(next) {
  state = { ...state, ...next };
  console.log(`[Updater] ${state.status}${state.version ? ` (v${state.version})` : ''}`);
  onChange(state);
}

function checkForUpdates() {
  if (!autoUpdater || state.status === 'checking' || state.status === 'downloading') return;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] check failed:', err.message);
    setState({ status: 'error' });
  });
}

function restartToUpdate() {
  if (autoUpdater && state.status === 'ready') {
    autoUpdater.quitAndInstall();
  }
}

// Menu entries for the tray, reflecting the current update state
function getMenuItems() {
  switch (state.status) {
    case 'disabled':
      return [];
    case 'ready':
      return [{ label: `Restart to update (v${state.version})`, click: restartToUpdate }];
    case 'checking':
      return [{ label: 'Checking for updates…', enabled: false }];
    case 'downloading':
      return [{ label: `Downloading update v${state.version}…`, enabled: false }];
    default:
      return [{ label: 'Check for Updates', click: checkForUpdates }];
  }
}

function init({ onStateChange } = {}) {
  if (onStateChange) onChange = onStateChange;

  const reason = disabledReason();
  if (reason) {
    console.log(`[Updater] off (${reason})`);
    return;
  }

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => setState({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ status: 'idle' }));
  autoUpdater.on('update-available', (info) => setState({ status: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => {
    setState({ status: 'ready', version: info.version });
    if (Notification.isSupported()) {
      new Notification({
        title: 'OTO update ready',
        body: `Version ${info.version} will be installed when you quit. Use the tray menu to restart now.`
      }).show();
    }
  });
  autoUpdater.on('error', (err) => {
    console.error('[Updater] error:', err.message);
    setState({ status: 'error' });
  });

  setState({ status: 'idle' });
  setTimeout(checkForUpdates, FIRST_CHECK_DELAY_MS).unref();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS).unref();
}

module.exports = { init, getMenuItems, checkForUpdates, restartToUpdate, disabledReason };
