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
- Keyboard-first control: deploy (`A`), bench (`B`), attack announcement (`C`), damage (`D`), energy (`E`, as the turn's attachment or a special one), heal (`H`), item and evolution locks (`I`, `V`), knock out (`K`), move damage (`M`), stadium (`S`), supporter (`Shift+S`), abilities (`X`), Top Deck announcement (`T`), pause (`P`), pass the turn (`Space`), prizes (arrows), trainer focus (`1`, `2`), draft mode (`Shift+Enter`), undo and redo (`Ctrl+Z`, `Ctrl+Y`), help (`?`)
- **Evolve and go back a stage** on the Active Pokémon and on the bench, keeping the energy, tools and damage; **Pokémon Tools** on any Pokémon, shown on the overlay, with the HP they add; a stepper for a Pokémon's **maximum HP**; **Fossils and Dolls** (Item cards played as Pokémon) in the same card picker
- **Move damage** (`M`) from any Pokémon to any other, of either trainer (the first is healed, the second damaged); **knock out several Pokémon at once**, each with its prize cards (DOUBLE KO!, TRIPLE KO!); an attack that says `×` or `+` asks for the number of times or the extra damage (in tens); a player with **no Pokémon left** after a knock out or a removal loses at once
- **Pokémon Tools on the overlay are the pictures of their cards** (the Trainer card's picture window, with the HP they add in a corner), a `tool` crop for designers and a **Tools** tab in the crop editor; their names as text are a switch that is off to begin with (`toolNames`), for designs that want them
- **The egg** on a Pokémon opens **Evolution** and **Devolution** in two tabs: the cards that evolve from it, or the card it evolved from (the one on file, or the one its card says), and any other card by typing; cards now remember what they evolve from
- Keys `W` (Winner banner) and `G` (Game start banner); abilities are no longer announced from the attack dialog (their tokens are marked with `X`)
- A shorter **Prize cards** box (the button that sets the cards in its title, the count with its six pips on one line, the Hide prizes switch with the penalty on another: about 112 px instead of 185), a smaller **Set prizes** dialog, the deck, its picture and the record on one row of the trainer card, and room between the prize cards and the Pokémon in the control panel
- **Compact control panel**: the turn tracker and the prize cards side by side, icon-only buttons and no HP bar on the Pokémon cards, GX and VSTAR markers hidden when the overlay does not show them; the prize cards show no "?" on the overlay
- **Feature cards and signs** can be put in any order by dragging them; the card picker's star (and a right-click on a card) marks a favorite
- Special conditions (Asleep, Burned, Confused, Paralyzed, Poisoned) and Trapped on the Active Pokémon, with icons from the assets folder; the GX attack and VSTAR Power as once-per-game markers (hidden by default, back at the end of each game)
- Attacks and retreat costs come from the card; damage comes in tens; the attack dialog lists the Active's attacks and abilities
- A penalty is a number of prize cards: that many of the other player's prizes show in red, and that player needs that many fewer to win. The victory is announced by itself when a player has taken the prizes they need, adds a game to their score, and **Next game** starts the next one
- **Deck or GLC type** for each trainer, shown next to the record on the scoreboard, with the Pokémon it names (official artwork from the PokeAPI sprites, downloaded once and kept) or the icon of its energy type; another picture, or none, can be chosen. The deck box suggests the most played decks of the moment (a snapshot of Limitless TCG, with the Pokémon of each), including the new Mega decks
- **Set prizes**: choose, with the card search, the card of each of a player's six prize cards. They show on the prize cards of the overlay (face down with a question mark while the prizes are hidden, faded when taken) and on the prize pips of the control panel, and start again for the next game
- The **bench** is stacked at the side of the screen by default, with a switch for a row under the Active Pokémon; the **retreat cost** is only for the Active Pokémon; the energy, Stadium and Supporter counters are only shown for the player whose turn it is; Pokémon whose card details (attacks, retreat cost) were not on file get them in the background, a moment after they are put in play
- A **Winner** button in the Hype box, for the player whose turn it is
- **Feature cards** have a box of their own, apart from the Stadium (which shows as its art in the control panel too), are shown in the order they were added, and can have a sign between them (`+`, `→`, `=`, `or`) to explain a combo
- The attack dialog has a list, closed until it is wanted, with the attacks of the benched Pokémon, and an option (off at first) shows them on the overlay
- **Pause**: a banner in the middle of the overlay that stays, with everything else grayed out, until the game is resumed (`P`)
- Drag and drop Pokémon between the Active spot and the bench (move or swap), right-click an energy to attach another, `Shift+B` and a button to put the bench back to 5 slots, prize arrows for the player whose turn it is, a Stadium that uses the playing player's Stadium play (or not), and undo and redo that say what they did
- Ability tokens on each Pokémon: ready or used, once per turn (they reset when that trainer's turn begins) or once per game
- Hype announcements as one-shot events: a new one replaces the one still showing; banner and effect durations are configurable
- Card search with pictures, favorites and an evolution search; HP and abilities are taken from the chosen card
- Feature cards, autosave with restore on restart, and match history

**Producing together**
- Several producers at once: live-synced pages, presence, a named activity feed, and conflict protection (a click on something another producer just changed is refused, so nothing counts twice)
- Shared undo and redo
- **Draft mode** (`Shift+Enter`): one draft shared by all the producers (everybody sees the same preview and who made each change, anybody can send it), sent all at once as one undoable step, with clash handling. Draft mode stays on after a send, until somebody leaves it. Redoing the send of a draft opens the draft again with its changes, to edit before it goes once more
- **The host** (the person at the computer that runs OTO) can rename other producers and remove them (they are refused for an hour, or until the host lets them back in); anybody renames themselves with a double-click on their name at the top; Shift+click on Preview opens the overlay in a browser tab
- **Several overlays for one match**: Settings, Overlay, More overlays adds up to three more, each with an address of its own (`/overlay?screen=<id>`), its own design (a mobile one for a vertical stream), its own switches and a sound switch
- Optional control panel password (any text), scrypt-hashed, with signed sessions and a login throttle; `OTO_PASSWORD` overrides it and `OTO_RESET_PASSWORD=1` removes a forgotten one
- A visible share link in the control panel and tray menu, and `GET /api/network`

**The overlay's look and sound**
- Switches to show or hide every element of the overlay, with presets; the nationality can show as a flag emoji (a flag font is bundled, because Windows has none); an **All** column and an **All moments** row switch whole rows and columns of the announcements table
- Pokémon shown as the art of their card (the whole card when a design asks) with the HP bar, attached energy, retreat cost and status icons placed on it, each editable per design; the Stadium shows as its art with its name below; a **design editor** with zoom, drag, a code view, crop and tile editors, and sample Stadium and Pokémon cards
- The control panel shows the art of the Pokémon cards too, or the whole card as a choice of that browser
- Sound effects for the moments of a match, off by default, each with its own switch and volume, a built-in sound for every cue, and your own files per cue
- **Designs**: colors, picture slots (including a frame for each reserved space), fonts and sounds, edited in the Look tab and reaching the overlay live
- **A font for each kind of text**: the main font plus names, numbers, labels, announcement titles, announcement subtitles and small text can each have a font file in the design and/or a list of fonts installed on the computer (a Fonts tab in the editor)
- **A copy of the built-in look** to learn from, in the Look tab, and as [docs/examples/built-in-look/design.json](docs/examples/built-in-look/design.json)
- **The picture on the prize cards**, chosen in each design (Tile tab): the design's own (the English card back when it has none), an English or a Japanese Pokémon card back, or a Poké Ball. The card backs are files in `assets/cardbacks` (a PNG, JPG or WebP each), and a plain drawing shows when there is none. The prize cards start face down, can be laid out as a row, a column, two rows of three or three rows of two, and have a crop of their own for the cards set on them
- **A mobile screen**: a design can be a tall 1080 × 1920 screen for a phone, with its own arrangement of the overlay. The editor's canvas follows it
- **Reserved spaces** for a camera feed or the like (up to six, each a rectangle, a rounded one or a circle), with a picture of the designer's own drawn over each, moved and resized on the canvas or typed in a Spaces tab; and a **grid** on the canvas, with squares of the size the designer chooses, for lining things up and snapping to
- Special Energy cards on a Pokémon show as a circle centered on the art of the card, as wide as the art is tall
- The OTO window has no File, Edit, View or Window menu
- **`.oto` packages**: a design, its sounds and the producer's control settings in one compressed file, saved from the Look or General tab, installed from a picker, by drag and drop, or by double-clicking the file in the desktop app. The format is documented in [docs/PACKAGE-FORMAT.md](docs/PACKAGE-FORMAT.md)
- Designs saved by earlier builds (one JSON with the pictures inside) are converted automatically

**Cards, offline**
- A **card library** kept on the computer: Standard, Gym Leader Challenge and Expanded. Downloaded in the background with progress, retried and resumed when the card service fails, searched instantly and offline. Standard also holds the cards that have no regulation mark but are legal in Standard (reprints such as the Classic Collection)
- Three card services: the Pokémon TCG API, **TCGdex** (no account, many languages, a fallback when the first does not answer) and **Scrydex** with your own account; API keys are kept on the computer and always shown masked. A library can be built from any of them (Standard from all three)
- **Updating a library brings only what is new**: each part of it is counted on the card service and only the parts that changed are downloaded (the new cards first, from the Pokémon TCG API); cards that left the format after a rotation go; libraries saved by earlier builds are worked out from their cards. The Cards tab says where each library came from and when an update would download it again from another service
- The card picker starts from your favorite cards, your most used and the ones saved on this computer
- Card pictures saved on the computer the first time they are shown, with an option to save them ahead of time (including the newest sets, whose pictures are on a second image host)

**The desktop app**
- Electron tray app for Windows, built as a self-updating installer (`OTO-Setup-x.y.z.exe`) and a portable `.exe` (`OTO-x.y.z-portable.exe`); the default port is **6767**
- The installer offers **Repair**, **Reinstall from scratch** (your data is moved to a backup, never deleted), **Uninstall** (which asks whether to also delete what OTO saved, starting with No) or **Destroy** (uninstall and delete everything OTO saved, after asking once) when OTO is already installed, and **closes a running OTO gracefully** so the match is saved first. `"Uninstall OTO.exe" /S --destroy` does it from a script
- Tray menu: control link for other devices, **Control panel password** (the host sets, changes or removes it from the tray icon), keep running in the tray when the window closes, and Troubleshooting (restart the service, open the data or logs folder, back up and start fresh)
- The release workflow signs the `.exe` files when a code signing certificate is in the repository secrets (see [docs/SIGNING.md](docs/SIGNING.md)); the builds are unsigned until then
- `.oto` file association, `OTO_DATA_DIR` and `OTO_PORT`
- Over-the-air updates through GitHub Releases for the installer build: they download in the background and install on quit or from the tray menu, never mid-stream

**Project**
- GitHub Actions: CI (server tests on Node 22 and 24, browser tests, `npm audit`) and a release workflow that builds and publishes the Windows installer, portable `.exe` and update manifest when a version tag is pushed
- Dependabot for npm packages and GitHub Actions
- About a thousand automated tests: server and logic (`npm test`), the control panel, settings and overlay in a real browser (`npm run test:ui`) and the desktop app end to end (`npm run test:desktop`)
- Documentation in three parts for three kinds of reader: a [guide for streamers and producers](docs/USING.md), a [guide for artists and designers](docs/DESIGNING.md) with the [package format](docs/PACKAGE-FORMAT.md), and a [guide for developers](docs/DEVELOPING.md); a short README that links them; [docs/SIGNING.md](docs/SIGNING.md); a sponsor link

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
