# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public release of the project, named **OTO** (OBS TCG Overlay).

### Added

**The match**
- Producer control panel and OBS browser-source overlay, synced over Socket.io, both redesigned from scratch
- Match state: trainers, prizes, active Pokémon, 2 to 8 bench slots, stadium, item and evolution locks, energy, stadium and supporter per-turn tokens, best-of-1/3/5 score, round label
- Keyboard-first control: deploy (`A`), bench (`B`), attack announcement (`C`), damage (`D`), energy (`E`, as the turn's attachment or a special one), heal (`H`), item and evolution locks (`I`, `V`), knock out (`K`), stadium (`S`), supporter (`Shift+S`), abilities (`X`), Top Deck and Pass Turn announcements (`T`, `P`), pass the turn (`Space`), prizes (arrows), trainer focus (`1`, `2`), undo and redo (`Ctrl+Z`, `Ctrl+Y`), help (`?`)
- Ability tokens on each Pokémon: ready or used, once per turn (they reset when that trainer's turn begins) or once per game
- Hype announcements as one-shot events: a new one replaces the one still showing; banner and effect durations are configurable
- Card search with pictures, favorites and an evolution search; HP and abilities are taken from the chosen card
- Feature cards, autosave with restore on restart, and match history

**Producing together**
- Several producers at once: live-synced pages, presence, a named activity feed, and conflict protection (a click on something another producer just changed is refused, so nothing counts twice)
- Shared undo and redo
- **Edit & send** drafts: change things privately, then send them all at once as one undoable step, with clash handling
- Optional control panel password (any text), scrypt-hashed, with signed sessions and a login throttle; `OTO_PASSWORD` overrides it and `OTO_RESET_PASSWORD=1` removes a forgotten one
- A visible share link in the control panel and tray menu, and `GET /api/network`

**The overlay's look and sound**
- Switches to show or hide every element of the overlay, with presets
- Sound effects for the moments of a match, off by default, each with its own switch and volume, a built-in sound for every cue, and your own files per cue
- **Designs**: colors, seven picture slots, a font and sounds, edited in the Look tab and reaching the overlay live
- **`.oto` packages**: a design, its sounds and the producer's control settings in one compressed file, saved from the Look or General tab, installed from a picker, by drag and drop, or by double-clicking the file in the desktop app. The format is documented in [docs/PACKAGE-FORMAT.md](docs/PACKAGE-FORMAT.md)
- Designs saved by earlier builds (one JSON with the pictures inside) are converted automatically

**Cards, offline**
- A **card library** kept on the computer: Standard, Gym Leader Challenge and Expanded. Downloaded in the background with progress, retried and resumed when the card service fails, searched instantly and offline
- Card pictures saved on the computer the first time they are shown, with an option to save them ahead of time (including the newest sets, whose pictures are on a second image host)

**The desktop app**
- Electron tray app for Windows, built as a self-updating installer (`OTO-Setup-x.y.z.exe`) and a portable `.exe` (`OTO-x.y.z-portable.exe`); the default port is **6767**
- The installer offers **Repair**, **Reinstall from scratch** (your data is moved to a backup, never deleted) or **Uninstall** when OTO is already installed, and **closes a running OTO gracefully** so the match is saved first
- Tray menu: control link for other devices, keep running in the tray when the window closes, and Troubleshooting (restart the service, open the data or logs folder, back up and start fresh)
- `.oto` file association, `OTO_DATA_DIR` and `OTO_PORT`
- Over-the-air updates through GitHub Releases for the installer build: they download in the background and install on quit or from the tray menu, never mid-stream

**Project**
- GitHub Actions: CI (server tests on Node 22 and 24, browser tests, `npm audit`) and a release workflow that builds and publishes the Windows installer, portable `.exe` and update manifest when a version tag is pushed
- Dependabot for npm packages and GitHub Actions
- A few hundred automated tests: server and logic (`npm test`), the control panel and settings in a real browser (`npm run test:ui`) and the desktop app end to end (`npm run test:desktop`)
- A README for both non-technical users (stores, creators, artists) and developers

### Fixed

Compared with the code this project started from:
- `src/server.js` had an unclosed `server.listen` callback and did not start
- A click on the energy and stadium counters, prize buttons, clear-slot button or match-win buttons crashed the server because the actions were wired to methods that did not exist
- A failed card search (for example when offline) crashed the server through an unhandled rejection; socket action handlers are now guarded and report errors
- Undo restored nothing; it is now a complete shared history
- Adding a feature card, toggling a favorite and finishing a match threw errors
- Clicking to edit HP applied the change in the wrong direction
- The card API key and provider settings were saved but never used
- `/api/config/export` no longer includes the API key
- The control panel never rendered the game state, and overlay announcements never cleared

### Changed
- Default port is now 6767; the product is named OTO
- Themes are now called designs and are folders of real files (see above) instead of one JSON file with the pictures embedded

### Security
- Upgraded to current releases to clear all `npm audit` findings: Electron 28 to 44, electron-builder 24 to 26, Express 4 to 5, Helmet 7 to 8, concurrently 8 to 10, wait-on 7 to 9. The minimum Node.js version is now 22
- Cross-site requests that change something, and cross-site socket connections, are refused; CORS is no longer open
- Packages, designs, pictures and sounds from outside are validated strictly (see [SECURITY.md](SECURITY.md))

### Removed
- `node-fetch`, replaced by the built-in `fetch`; `cors`
- Unused dependencies: `bcryptjs`, `connect-flash`, `express-session`, `morgan`, `uuid` and the native `canvas` module
- An unused `sql-wasm.wasm` file, a leftover debugging script, the old monolithic control panel script, and the `start.bat` / `start.sh` launchers (the installer and portable builds cover end users; from source use `npm start`)
