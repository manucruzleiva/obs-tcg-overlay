# OTO for developers

How OTO is built, how to run and test it, and where to change things. If you only want to use it, read the [producer guide](USING.md); for designs, the [design guide](DESIGNING.md). To send a change, read [CONTRIBUTING.md](../CONTRIBUTING.md) too.

**Contents:** [Run from source](#run-from-source) · [Architecture](#architecture) · [Project layout](#project-layout) · [Configuration](#configuration) · [Security model](#security-model) · [Designs in the code](#designs-in-the-code) · [REST API](#rest-api) · [Socket.io](#socketio) · [Tests](#tests) · [Building and releasing](#building-and-releasing)

---

## Run from source

You need [Node.js](https://nodejs.org/) 22 or newer.

```bash
git clone https://github.com/manucruzleiva/obs-tcg-overlay.git
cd obs-tcg-overlay
npm install            # also downloads Electron (~100 MB); add --ignore-scripts to skip it
npm start              # http://localhost:6767/control
```

| Command | What it does |
|---------|--------------|
| `npm start` | Run the server only |
| `npm run electron` | Run the desktop (tray) app from source |
| `npm run electron:dev` | The server plus the Electron window |
| `npm test` | Server and logic tests: they boot the real server and drive it over HTTP and socket.io (about 740 tests, a couple of minutes) |
| `npm run test:ui` | The control panel, settings and overlay in a real browser (needs Chrome or Edge; set `BROWSER_PATH` to use another). About 320 tests, several minutes |
| `npm run test:desktop` | The desktop app end to end: opening a `.oto`, `--quit`, the fresh-start backup, the tray password window (needs the Electron binary) |
| `npm run pack` | Build an unpacked desktop app into `dist/` |
| `npm run dist` | Build the Windows installer and portable `.exe` into `dist/` |

Scratch work (test databases, one-off scripts, screenshots, test builds) goes in `.local/`, which is git-ignored.

---

## Architecture

```
┌──────────────┐   Socket.io    ┌──────────────────────────────┐   Socket.io    ┌──────────────┐
│ Control panel│ ─────────────▶ │ Node.js server               │ ─────────────▶ │   Overlay    │
│ (any browser)│  action:*      │ Express + Socket.io          │  state:update  │ (OBS browser │
└──────────────┘ ◀───────────── │  ├ one authoritative state   │  announce, sfx │   source)    │
        ▲        presence,      │  ├ designs, sounds, packages │                └──────────────┘
        │        activity,      │  ├ card library + pictures   │                 (one or several,
        │        drafts         │  ├ SQLite (sql.js) file      │──▶ card APIs     /overlay?screen=)
   password gate                └──────────────────────────────┘
        Electron wraps the server in a tray app (installer and portable builds)
```

- The server owns **one game state** with a `revision`. Clients send `action:*` events carrying the revision they last saw; the server applies the action, records it (undo, activity, conflict detection) and broadcasts the new state. Every change goes through `Session.finish()`.
- **Actions** are declared in [src/actions.js](../src/actions.js): each says which part of the state it touches (`targets`), how to validate and run itself, how it is described in the activity feed (`label`) and which announcements it fires (`cues`). `resolve()` returns that; `run()` wraps it with the win logic (the prizes victory, and the instant victory of a player who has no Pokémon left after a knock out or a removal).
- **Conflicts.** If another producer changed an overlapping part since the sender's revision, the action is refused (`action:rejected`, reason `conflict`) rather than applied twice. Absolute actions ("set the name to X") are last-writer-wins.
- **Drafts.** Draft mode is a mode of the table: one shared draft in which every producer's actions queue (each entry carries who made it) and replay atomically on send. After a send the draft starts empty and the mode stays on. Redoing a draft send reopens the draft with the sent changes.
- **The host** is a socket from a loopback address that also has a loopback `Host` header. Only the host may rename others, kick (and forgive) producers, and, from the Electron tray, set the password.
- **Announcements and sounds are events, not state:** `announce` and `sfx` fire once, so a reconnecting overlay never replays them.
- **Screens.** `settings.screens` lists extra overlays; an overlay opened with `?screen=<id>` reads its design from `/api/theme?screen=<id>`, applies that screen's display overrides and plays sounds only if its `sound` flag is on.
- **Shared catalog modules** (UMD files in `public/js/`, loaded by both the server and the browser): `display-options.js` (what can be shown or hidden, screens), `theme-options.js` and `theme-rules.js` (what a design may contain and how it is validated), `sound-options.js`, `game-data.js`, `deck.js` and `deck-popular.js`, `pokedex.js`, `countries.js`. One source of truth for the server's validation and the editor's UI.
- The control panel and overlay are plain HTML, CSS and JavaScript (ES modules in the control panel) with **no build step**. The overlay targets the Chromium that ships with OBS, so it avoids newer CSS and JavaScript.

---

## Project layout

```
├── src/
│   ├── server.js            # Express + Socket.io wiring, password gate, asset and picture routes
│   ├── session.js           # live actions, conflicts, undo/redo, drafts, presence, host powers
│   ├── actions.js           # every action: what it touches, what it does, how it is described
│   ├── config.js
│   ├── api/routes.js        # REST routes
│   ├── db/database.js      # SQLite via sql.js (persisted to a file)
│   └── services/
│       ├── gamestate.js     # match state and its mutations
│       ├── announcements.js # banners and full-screen effects
│       ├── collab.js        # change log, undo/redo stacks, activity
│       ├── auth.js          # the optional password and sessions
│       ├── themes.js        # designs: folders of files
│       ├── sounds.js        # the producer's own sounds
│       ├── package.js, zip.js  # .oto packages and the ZIP reader/writer
│       ├── catalog.js, images.js, pokemon-tcg.js, tcgdex.js, scrydex.js, cache.js, card-usage.js, attacks.js  # card library, pictures, card services
│       └── network.js, port-check.js  # LAN addresses for the share link, the port check
├── public/
│   ├── control/, js/control/ # control panel (ES modules): app, views, modals, settings, design editor
│   ├── overlay/, js/overlay.js
│   ├── login/
│   └── css/, js/            # styles and the shared catalogs
├── electron/                # desktop wrapper: main process, preload, tray, updater, password window
├── installer/installer.nsh  # Windows installer: graceful close, repair/reinstall/uninstall/destroy page
├── test/                    # server and logic tests (node:test)
├── test-ui/                 # browser tests (Playwright driving Chrome or Edge)
├── test-desktop/            # Electron end-to-end tests
├── test-support/            # the test harness and sample files
├── docs/                    # guides, the .oto format, the built-in look as a design file
└── assets/                  # logo, app icon, energy and status icons, card backs, flag font, README screenshots
```

---

## Configuration

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `6767` | HTTP and WebSocket port |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` to accept only local connections |
| `OTO_PASSWORD` | unset | Password for the control panel (wins over one set in the app) |
| `OTO_RESET_PASSWORD` | unset | Set to `1` for one start to remove a forgotten password |
| `DB_PATH` | `data/overlay.sqlite` | SQLite database file. Designs, sounds, card libraries and pictures are kept in folders beside it |
| `LOG_DIR` | `logs/` | Where log files are written |
| `LOG_LEVEL` | `info` | Winston log level |
| `OTO_DATA_DIR` | `%APPDATA%\obs-tcg-overlay` | Desktop app: keep all its data in this folder |
| `OTO_PORT` | `6767` | Desktop app: use another port (to run a second copy) |
| `OBS_TCG_DISABLE_UPDATES` | unset | Set to `1` to disable update checks in the desktop app |
| `POKEMONTCG_API_URL` | `https://api.pokemontcg.io/v2` | Another card API server (the tests use a local mock) |
| `OTO_IMAGE_BASE` | `https://images.pokemontcg.io` | Where card pictures are fetched from |
| `OTO_SCRYDEX_IMAGE_BASE` | `https://images.scrydex.com` | Where the card pictures of the newest sets are fetched from |
| `OTO_SPRITE_BASE` | the PokeAPI sprites repository (official artwork) | Where the pictures of Pokémon beside a deck are fetched from (`<base>/<Pokédex number>.png`) |

---

## Security model

By default OTO is built for a trusted local network.

- **Password (optional).** Scrypt-hashed, in a signed cookie bound to the current password, with a login throttle. Unsafe HTTP requests and socket handshakes that name another site as their origin are refused, so a web page cannot drive your overlay. Pages and API calls are redirected to a sign-in page, or answer `401`. The overlay, its files and card pictures stay open for OBS. The desktop app sets and removes the password from its tray menu through a small window with a locked-down preload (it can only save or cancel).
- **No password set:** anyone who can reach the port can drive the overlay. Bind to `127.0.0.1` on untrusted networks, set a password, and never expose the port to the internet.
- **Host powers.** Renaming and removing other producers is only accepted from the host (a loopback socket with a loopback `Host` header). A removed producer (its client id and its address) is refused for an hour, or until the host forgives.
- **`.oto` packages and designs** are untrusted input: strict ZIP parsing (name checks, declared-size enforcement, checksums, a cap on what unpacks), content sniffing, SVGs with scripts or links refused, no web addresses in designs, font lists restricted to a safe character set, and design files served with a restrictive content security policy.
- **The installer's Destroy** deletes exactly two folders (OTO's own data under `%APPDATA%` and its updater downloads under `%LOCALAPPDATA%`), only after being asked for, and never in an update or a silent run. A test reads the script to keep it that way.
- Security headers (CSP, `nosniff`) via Helmet. See [SECURITY.md](../SECURITY.md) to report a vulnerability.

---

## Designs in the code

A design is a **folder** under the data folder: `themes/<name>/design.json` plus `images/`, `fonts/` and `sounds/`. The overlay asks `GET /api/theme` (with `?screen=<id>` for an extra overlay) for the design on air and receives colors plus an address for each file; the server serves only the files that design holds. A `.oto` is that folder zipped, with a `manifest.json` and a `controls.json` for the control settings. The format, limits and safety rules are in [PACKAGE-FORMAT.md](PACKAGE-FORMAT.md). A complete example is [examples/built-in-look/design.json](examples/built-in-look/design.json); `test/example-design.test.js` fails if it drifts from the real defaults.

The editor's pieces live in `public/js/control/`: `design-editor.js` (the shell and tabs), `editor-model.js` (the design as data, with undo), `editor-canvas.js`, `editor-crop.js`, `editor-tile.js`, `editor-spaces.js`, `editor-fonts.js`, `editor-code.js` and `editor-sample.js` (the sample table the canvas shows). To let a design change something new, add it to the shared lists in `theme-options.js` / `theme-rules.js` (validation), `src/services/themes.js` and `package.js` (storing and packaging), `overlay.js` and `overlay.css` (drawing), then the editor.

Fonts: `FONT_ROLES` in `theme-options.js` names the groups of text; each role is a CSS variable (`--font-names`, `--font-numbers`, ...) that the overlay sets per design, from a font file loaded with `FontFace` and/or a validated font-family list.

---

## REST API

Open (no password needed): `GET /api/health`, `GET /api/auth/status`, `POST /api/login`, `POST /api/logout`, `GET /api/theme[?screen=]` (the design on air or a screen's design), `GET /api/theme/assets/:folder/:file`, `GET /api/sounds`, `GET /api/sounds/:cue`, `GET /img/:set/:file` (card pictures, and the pictures of Pokémon as `/img/sprite/<Pokédex number>.png`, saved on first use), `GET /assets/...` (energy and status icons, card backs, the flag font).

Behind the password:

| Method and path | Description |
|-----------------|-------------|
| `GET /api/state`, `/state/trainerA`, `/state/trainerB`, `/state/match` | The match state, or parts of it |
| `GET /api/settings`, `POST /api/settings` | Read or update settings |
| `POST /api/auth/password` | Set or remove the password |
| `GET /api/cards/search?q=&supertype=&subtype=&rarity=&set=&evolvesFrom=&page=` | Search cards (the library first, then online) |
| `GET /api/cards/:id`, `GET /api/evolution/search` | Card details, evolution search |
| `GET /api/cards/popular`, `POST/DELETE /api/cards/used`, `POST /api/cards/known` | The cards the picker starts from: favorites, the most used, and the ones saved on this computer |
| `GET /api/favorites`, `POST /api/favorites/:id` | List or toggle favorites |
| `GET /api/matches` | Finished matches |
| `GET /api/cache/stats`, `POST /api/cache/clear` | Remembered searches |
| `GET /api/config/export`, `POST /api/config/import` | The match and settings as JSON (the API key is never exported) |
| `GET /api/network` | Addresses the control panel and overlay can be reached on |
| `GET /api/catalog`, `POST /api/catalog/:library/download`, `POST /api/catalog/cancel`, `PUT /api/catalog/active`, `DELETE /api/catalog/:library` | The card libraries |
| `POST /api/catalog/pictures`, `DELETE /api/catalog/pictures` | Save or delete card pictures |
| `GET/PUT/DELETE /api/themes[/:name]`, `POST /api/themes`, `PUT/DELETE /api/themes/:name/images/:slot`, `/font`, `/fonts/:role`, `/sounds/:cue`, `GET /api/themes/:name/assets/...`, `POST /api/theme/active` | Designs and their files |
| `PUT/DELETE /api/sounds/:cue` | The producer's own sounds |
| `GET /api/packages/export`, `POST /api/packages/inspect`, `POST /api/packages/install` | `.oto` packages |

---

## Socket.io

- **Server to client:** `state:full` (on connect), `state:update` (after every change), `announce`, `sfx`, `presence`, `you`, `kicked`, `activity`, `activity:history`, `action:applied`, `action:rejected`, `draft:state`, `draft:sent`, `draft:cleared`, `draft:closed`, `draft:conflicts`, `theme:changed`, `sounds:changed`, `catalog:progress`.
- **Client to server:** `action:trainerA`, `action:trainerB`, `action:match`, `action:toast`, `action:card`, `action:settings`, `action:reset`, `action:undo`, `action:redo`, `draft:start`, `draft:send`, `draft:discard` (leave draft mode), `draft:clear`, `presence:rename`, `presence:kick`, `presence:forgive`.

Each action carries `{ action, ...params, meta: { baseRevision, seq } }`. The handlers live in [src/actions.js](../src/actions.js). A selection (not the whole list):

- Pokémon: `select` (a card into a slot; its `cardData` may say `evolvesFrom`, and the Pokémon remembers it for the Devolution tab; with `evolve`, `back` for a de-evolution, `asPokemon` for a Fossil or Doll Item), `devolve`, `moveSlot` (`{ from, to }`, `-1` is the Active spot: move or swap), `swapWithActive`, `clearSlot`, `setRetreat`, `setMaxHP` (`{ max, keepDamage }`), `attachTool` / `removeTool` (`{ name, image, hp }`), `moveDamage` (`{ from: { side, slot }, to: { side, slot }, amount }` over any two Pokémon), `knockOut` and `knockOutMany` (`{ knockouts: [{ side, slot, prizes }], clear }`), `benchSizeReset`.
- Energy and status: `attachEnergy` / `attachSpecialEnergy` (with `countsAsTurn`), `toggleStatus` / `clearStatus`, `gxPlus` / `vstarPlus` (and `Minus`, `Reset`).
- Prizes: `prizePenaltySet`, `prizeCardsSet` (`{ cards }`: up to six `{ cardId, name, image }`, or `null`).
- Deck: `setDeck` (`{ deck }`), `setDeckIcon` (`{ icon }`).
- Feature cards: `addFeatureCard`, `addFeatureSeparator` (`{ symbol, at }`), `moveFeature` (`{ id, to }`).
- On `action:match`: `nextGame`, `startGame`, `togglePause` (`{ enabled }`), `toggleTurn`. A Stadium put in play with `select` (target `stadium`) or `setStadium` takes `playedBy` and `consume`.
- On `action:settings`: `update` with `display`, `screens`, sound and announcement settings.

---

## Tests

`npm test` runs against the real server with a throwaway database and a mock card API ([test-support/harness.js](../test-support/harness.js)): game logic, every action, multi-producer conflicts and drafts, host powers, the password, designs, fonts, sounds, `.oto` packages, the card library, the installer script and the REST surface. The harness can open a **guest** connection (a non-loopback `Host` header) to test what the host alone may do.

`npm run test:ui` drives the control panel, settings and overlay in a real browser: keyboard shortcuts, dialogs, drafts, two producers, designs and the editor, packages, screens and the library. It is slow, and under load a test can time out; run it again alone before suspecting a bug (`node --test --test-name-pattern="..." test-ui/control.test.js`).

`npm run test:desktop` runs the Electron app itself (the tray password window uses the `OTO_TEST_HOOKS=1` hook, which exposes the main process to the test).

Never write a test that depends on the real card API or the internet. Use a fresh client id for each test producer. The tests write to `.local/test/`.

---

## Building and releasing

`npm run dist` builds the NSIS installer (`OTO-Setup-x.y.z.exe`, self-updating through `latest.yml`) and the portable `.exe` into `dist/`. Releases are built and published by GitHub Actions when a version tag is pushed ([release.yml](../.github/workflows/release.yml); see [CONTRIBUTING.md](../CONTRIBUTING.md#releasing-maintainers)).

The Windows build is **unsigned today**. The release workflow signs the `.exe` files when the repository has a certificate in its secrets; how to get one and set it up is in [SIGNING.md](SIGNING.md).

A test build for yourself, into a folder that does not touch an installed copy:

```bash
npx electron-builder --win portable --publish never --config.directories.output=.local/portable-build
```

Run the result with its own `OTO_DATA_DIR` and `OTO_PORT`, so it does not mix with a copy you use.
