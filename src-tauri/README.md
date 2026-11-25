# OTO desktop app (Tauri)

The Windows tray app, written in Rust with [Tauri 2](https://tauri.app). It runs `src/server.js` on a bundled Node as a
sidecar process and shows the control panel; the server, the overlay and the control panel are the same files as with
`npm start`. How it talks to the server, the installer, the updates and the updater key are in
[docs/DEVELOPING.md](../docs/DEVELOPING.md#building-and-releasing).

- `src/main.rs`: the server process, the window, the tray, the password window, `.oto` files, desktop settings
- `src/updater.rs`: over-the-air updates from GitHub Releases
- `capabilities/`: which window may call which command (the control panel only from the local server's pages)
- `frontend/password.html`: the small window that sets the control panel password
- `windows/hooks.nsh`: the installer's extra steps (closing OTO politely, removing the Electron app, deleting data only when asked)
- `tauri.updater.conf.json`: merged into the build by the release workflow when the updater key is set

```
npm ci
npm run desktop:dev       # or desktop:build for the installer
```
