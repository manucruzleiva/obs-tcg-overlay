# OTO on Tauri (prototype)

A replacement for the Electron shell in `electron/`, written in Rust with [Tauri 2](https://tauri.app). Only the
desktop part changes: the server (`src/`), the overlay and the control panel (`public/`) are the same files.

- The app runs `src/server.js` on a bundled Node (`binaries/node-<target>`) as a separate process, with the data in the
  same folder as the Electron app (`%APPDATA%\obs-tcg-overlay`, or `OTO_DATA_DIR`).
- The server prints `OTO_READY {...}` once it listens; the app then opens the control panel window and fills the tray
  menu. To quit, the app writes `quit` on the server's stdin, the server saves the match and the database, and both exit.
- `OTO.exe --quit` asks the running OTO to save and quit, as the Electron app does for the installer.

## Build

```
npm ci
npm run tauri:stage                       # copies the server and this Node into src-tauri/
npx @tauri-apps/cli@2.12.6 build          # src-tauri/target/release/bundle/nsis/OTO_<version>_x64-setup.exe
```

The `Tauri prototype` workflow does the same on Windows and uploads the installer as an artifact.

## Not done yet (the Electron app still has these)

- Automatic updates (tauri-plugin-updater), and a last Electron release that moves existing installs to the Tauri installer
- The installer page in `installer/installer.nsh` (Repair, Reinstall, Destroy) as Tauri NSIS hooks, and the portable exe
- Setting the control panel password from the tray (Electron's small password window)
- Opening `.oto` files with a double click (the association is registered, the file is not handed to the page yet)
- Links that open a new window going to the browser, the "Keep running in the tray" switch in Settings, the one-time tray hint
- Restarting the server from the tray, moving the data to a backup ("start fresh")
