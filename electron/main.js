const { app, BrowserWindow, Tray, Menu, nativeImage, Notification, shell, ipcMain, clipboard, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const updater = require('./updater');
const { createSettings } = require('./app-settings');
const { wantsQuit, packageIn, relaunchArgs, isRestart } = require('./args');
const { getLanAddresses } = require('../src/services/network');
const { DEFAULT_PORT } = require('../src/config');

// App data lives in %APPDATA%\obs-tcg-overlay, named after the project rather than the display name,
// so renaming the product can never silently move a user's data. OTO_DATA_DIR keeps everything in a
// folder of your choice instead (a USB stick, or a throwaway folder for testing).
app.setPath('userData', process.env.OTO_DATA_DIR || path.join(app.getPath('appData'), 'obs-tcg-overlay'));

const settings = createSettings(path.join(app.getPath('userData'), 'app-settings.json'));

let mainWindow = null;
let tray = null;
let serverModule = null;
let isQuitting = false;
let serverStatus = 'stopped'; // 'running' | 'stopped' | 'starting'
let trayIcon = null;

// .oto packages opened from the file manager wait here until the control panel page asks for them
const MAX_PACKAGE_BYTES = 48 * 1024 * 1024;
const pendingPackages = [];
const startupFiles = [];
let pageListening = false;

const APP_ICON = path.join(__dirname, '../logo.ico');

// OTO_PORT is for running a second copy next to the first (tests, a second stream)
const SERVER_PORT = Number(process.env.OTO_PORT) || DEFAULT_PORT;

// Get the correct server path for both dev and production
function getServerPath() {
  // In development: __dirname = .../electron, server at ../src/server.js
  // In production: __dirname = .../resources/app/electron, server at ../src/server.js (inside asar)
  // Since src is packed in asar, we need to extract it or use a different approach
  // Best: run server in the same process (require it directly) rather than spawning
  return path.join(__dirname, '..', 'src', 'server.js');
}

// Get writable log directory (userData)
function getLogDir() {
  const userData = app.getPath('userData');
  const logDir = path.join(userData, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

// Get writable database path (userData)
function getDbPath() {
  const userData = app.getPath('userData');
  const dbDir = path.join(userData, 'data');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, 'overlay.sqlite');
}

// Initialize the tray icon
function initTrayIcon() {
  trayIcon = nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
}

// Reflect the server status in the tray tooltip
function updateTrayTooltip() {
  if (!tray) return;
  tray.setToolTip(serverStatus === 'running'
    ? 'OTO - Running'
    : 'OTO - Service Offline');
}

// Update server status and tray icon
function setServerStatus(status) {
  serverStatus = status;
  updateTrayTooltip();
  
  // Notify renderer processes if needed
  if (mainWindow) {
    mainWindow.webContents.send('server-status-changed', status);
  }
}

// Read a .oto file and hand it to the control panel, which offers to install it
function openPackage(file) {
  try {
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > MAX_PACKAGE_BYTES) throw new Error('not a usable file');
    pendingPackages.push({ name: path.basename(file), bytes: fs.readFileSync(file) });
  } catch (error) {
    // Never showErrorBox or a "Sync" dialog here: they stop the whole app, including the overlay's server,
    // until someone clicks OK, and a stream is probably live
    dialog.showMessageBox({ type: 'error', title: 'OTO', message: `That file could not be opened: ${path.basename(file)}`, buttons: ['OK'] }).catch(() => {});
    return;
  }
  deliverPackages();
}

function deliverPackages() {
  if (!pendingPackages.length) return;
  showMainWindow();
  // before the page has said it is listening, the files wait to be asked for
  if (!mainWindow || !pageListening) return;
  for (const file of pendingPackages.splice(0)) mainWindow.webContents.send('package-opened', file);
}

// Bring the control panel window to the front, creating it if it was closed
function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Whether closing the window keeps the overlay service running in the tray
function setKeepInTray(value) {
  settings.set('keepInTray', value);
  if (tray) tray.setContextMenu(buildTrayMenu());
  if (mainWindow) mainWindow.webContents.send('app-settings-changed', settings.getAll());
}

// Tell the user once where the app went when they close the window
function showTrayHint() {
  if (settings.get('trayHintShown') || !Notification.isSupported()) return;
  settings.set('trayHintShown', true);
  new Notification({
    title: 'OTO is still running',
    body: 'It keeps your overlay live from the tray, next to the clock. Right-click the icon to open it again or to quit.'
  }).show();
}

// Tray entries that copy the control panel link other devices can use
function shareLinkItems() {
  const addresses = getLanAddresses();
  if (!addresses.length) return [{ label: 'No network connection found', enabled: false }];
  return addresses.map(({ name, address }) => {
    const url = `http://${address}:${SERVER_PORT}/control`;
    return { label: `${url}  (${name})`, click: () => clipboard.writeText(url) };
  });
}

// Build the tray context menu (includes the current update action, if any)
function buildTrayMenu() {
  const updateItems = updater.getMenuItems();

  return Menu.buildFromTemplate([
    {
      label: 'Open Control Panel',
      click: showMainWindow
    },
    {
      label: 'Open Overlay (for OBS)',
      click: () => {
        shell.openExternal(`http://localhost:${SERVER_PORT}/overlay`);
      }
    },
    { label: 'Copy Control Link for Other Devices', submenu: shareLinkItems() },
    { type: 'separator' },
    {
      label: 'Keep running in tray when window is closed',
      type: 'checkbox',
      checked: settings.get('keepInTray'),
      click: (item) => setKeepInTray(item.checked)
    },
    {
      label: 'Troubleshooting',
      submenu: [
        { label: 'Restart the service', click: () => restartServer() },
        { label: 'Open the data folder', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'Open the logs folder', click: () => shell.openPath(getLogDir()) },
        { type: 'separator' },
        { label: 'Back up and start fresh…', click: backUpAndReset }
      ]
    },
    ...(updateItems.length ? [{ type: 'separator' }, ...updateItems] : []),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

// Create the system tray icon
function createTray() {
  tray = new Tray(trayIcon);
  setServerStatus('starting');

  tray.setContextMenu(buildTrayMenu());
  // Refresh the menu (and the addresses in it) each time it is opened
  tray.on('right-click', () => tray.setContextMenu(buildTrayMenu()));

  tray.on('double-click', showMainWindow);
}

// Start the Node.js server (run in same process for packaged app compatibility)
function startServer() {
  setServerStatus('starting');
  
  return new Promise((resolve, reject) => {
    try {
      // Set log directory to userData (writable in production)
      const logDir = getLogDir();
      const dbPath = getDbPath();
      console.log('[Electron] Setting LOG_DIR:', logDir);
      console.log('[Electron] Setting DB_PATH:', dbPath);
      process.env.LOG_DIR = logDir;
      process.env.DB_PATH = dbPath;
      process.env.PORT = String(SERVER_PORT);
      
      // Require and initialize the server directly in this process
      serverModule = require(getServerPath());
      
      // The server module exports { app, server, io, getGameState }
      // It starts the server in its initialize() function
      // We need to wait for it to be ready
      
      // Check if server is already running (from a previous require)
      if (serverModule.server && serverModule.server.listening) {
        setServerStatus('running');
        resolve();
        return;
      }
      
      // The server's initialize() is called at module load time
      // We just need to wait for it to be ready
      const checkServer = setInterval(() => {
        if (serverModule.server && serverModule.server.listening) {
          clearInterval(checkServer);
          setServerStatus('running');
          resolve();
        }
      }, 100);
      
      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkServer);
        if (serverModule.server && serverModule.server.listening) {
          setServerStatus('running');
          resolve();
        } else {
          reject(new Error('Server failed to start within 10 seconds'));
        }
      }, 10000);
      
    } catch (err) {
      console.error('Failed to start server:', err);
      setServerStatus('stopped');
      reject(err);
    }
  });
}

// Move everything OTO has saved (matches, designs, sounds, card libraries, settings) into a backup folder
// and start again empty. Nothing is deleted: the backup sits next to the data and can be moved back.
async function backUpAndReset() {
  // asked without stopping the app: the overlay keeps working while the question is open
  const { response: choice } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Back up and start fresh',
    message: 'Start again with empty data?',
    detail: 'Your matches, designs, sounds, card libraries and settings are moved into a backup folder, not deleted. OTO restarts empty.',
    buttons: ['Back up and start fresh', 'Cancel'],
    defaultId: 1,
    cancelId: 1
  });
  if (choice !== 0) return;

  try {
    isQuitting = true;
    // the server saves the match and closes the database before the folder moves
    if (serverModule && typeof serverModule.shutdown === 'function') serverModule.shutdown();
    const data = path.join(app.getPath('userData'), 'data');
    if (fs.existsSync(data)) {
      let backup = path.join(app.getPath('userData'), 'data-backup');
      for (let n = 2; fs.existsSync(backup); n++) backup = path.join(app.getPath('userData'), `data-backup-${n}`);
      fs.renameSync(data, backup);
      new Notification({ title: 'OTO', body: `Your data was saved in ${path.basename(backup)}. OTO is starting fresh.` }).show();
    }
  } catch (error) {
    dialog.showMessageBox({ type: 'error', title: 'OTO', message: `The data could not be moved: ${error.message}`, buttons: ['OK'] }).catch(() => {});
    isQuitting = false;
    return;
  }
  relaunchAndExit();
}

// Start a fresh copy and end this one. The new copy is not given the command line as it was: a .oto that
// was opened with this copy would be offered again. It is told it is a restart, so it can wait a moment
// for this copy to let go of the single-instance lock (see takeTheLock below).
function relaunchAndExit() {
  app.relaunch({ args: relaunchArgs(process.argv) });
  app.exit(0);
}

function restartServer() {
  setServerStatus('starting');
  // The server runs inside this process, so restarting it means restarting the app
  relaunchAndExit();
}

// Create the main control panel window
function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: 'OTO - Control Panel',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false,
    frame: true,
    resizable: true
  });
  
  mainWindow.loadURL(`http://localhost:${SERVER_PORT}/control`);
  // a page that is loading again has to say once more that it is listening
  mainWindow.webContents.on('did-start-loading', () => { pageListening = false; });
  
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  
  mainWindow.on('close', (e) => {
    if (isQuitting) return;
    if (settings.get('keepInTray')) {
      // Hide instead of closing: the server and the tray icon keep running
      e.preventDefault();
      mainWindow.hide();
      showTrayHint();
    } else {
      // Closing the window quits the app and stops the service
      isQuitting = true;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  
  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Create the overlay window (optional, for local preview)
function createOverlayWindow() {
  const overlayWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    title: 'OTO - Overlay Preview',
    icon: APP_ICON,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false
    },
    show: false,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true
  });
  
  overlayWindow.loadURL(`http://localhost:${SERVER_PORT}/overlay`);
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
  });
  
  return overlayWindow;
}

// App event handlers
// Only one copy may run: a second launch just brings the first one's window forward. A copy that is a
// restart may start a moment before the old one has let go of the lock, so it waits a little for it.
async function takeTheLock() {
  if (app.requestSingleInstanceLock()) return true;
  if (!isRestart(process.argv)) return false;
  for (let tries = 0; tries < 40; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

takeTheLock().then((owned) => {
  if (!owned) {
    app.quit();
    return;
  }
  // A second launch (including a double-click on a .oto file) brings the first one forward. One that says
  // --quit (the installer does, before it replaces the files) asks this copy to save everything and quit.
  app.on('second-instance', (event, argv) => {
    if (wantsQuit(argv)) {
      isQuitting = true;
      app.quit();
      return;
    }
    showMainWindow();
    const file = packageIn(argv);
    if (file) openPackage(file);
  });
  // macOS tells the app about an opened file this way, possibly before it is ready
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (app.isReady()) openPackage(file); else startupFiles.push(file);
  });

  // Started only to ask a running copy to quit, and there was none: do not start up for nothing
  if (wantsQuit(process.argv)) app.quit();

  app.whenReady().then(async () => {
    if (wantsQuit(process.argv)) return;
    initTrayIcon();
    await startServer();
    createTray();
    createMainWindow();
    const opened = packageIn(process.argv);
    for (const file of [...(opened ? [opened] : []), ...startupFiles.splice(0)]) openPackage(file);

    // Over-the-air updates (installer builds only); refresh the tray menu as the state changes
    updater.init({ onStateChange: () => tray && tray.setContextMenu(buildTrayMenu()) });
  });
});

// With "keep running in tray" the window is only hidden, so this fires only when the user chose to quit on close
app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  // Save the match and the database before the process ends
  if (serverModule && typeof serverModule.shutdown === 'function') serverModule.shutdown();
});

app.on('activate', () => {
  if (!mainWindow) {
    createMainWindow();
  }
});

// IPC handlers
ipcMain.handle('get-server-url', () => {
  return `http://localhost:${SERVER_PORT}`;
});

ipcMain.handle('open-overlay', () => {
  shell.openExternal(`http://localhost:${SERVER_PORT}/overlay`);
});

ipcMain.handle('restart-server', () => {
  restartServer();
  return { success: true };
});

ipcMain.handle('quit-app', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.handle('get-server-status', () => {
  return serverStatus;
});

// The control page asks for .oto files that were opened before it was ready, and from then on is sent them
ipcMain.handle('take-opened-packages', () => {
  pageListening = true;
  return pendingPackages.splice(0);
});

ipcMain.handle('get-app-settings', () => settings.getAll());

// The page may only change preferences meant for the user, not internal flags
ipcMain.handle('set-app-setting', (event, key, value) => {
  if (key === 'keepInTray' && typeof value === 'boolean') setKeepInTray(value);
  return settings.getAll();
});

module.exports = { app, createMainWindow, createOverlayWindow, backUpAndReset, restartServer };