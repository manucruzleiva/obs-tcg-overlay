# The `.oto` package format

A **`.oto` file** carries a design for the overlay, the sounds that go with it, and the producer's control settings, in one compressed file that anyone with OTO can install in a click.

It is an ordinary **ZIP file with a different extension**. You can open one with any zip tool (rename it to `.zip` first if your tool insists), and you can make one by zipping a folder and renaming the result to `.oto`. No special software is needed to create designs.

This page is for artists, designers and anyone building tools around OTO. If you only want to share or install a package, the Settings screens in OTO do it for you (see the [README](../README.md#designs-and-oto-packages)).

## Contents

```
my-design.oto
├── manifest.json        what this is (optional when you zip a folder by hand)
├── design.json          the design: name, author, colors   (optional)
├── images/              pictures for the overlay            (optional)
│   ├── logoImage.png
│   ├── backgroundImage.jpg
│   └── ...
├── fonts/
│   └── font.woff2       the font for names, numbers and announcements
├── sounds/              sound effects for the overlay        (optional)
│   ├── damage.mp3
│   └── ...
└── controls.json        the producer's control settings      (optional)
```

Every part is optional, but a package must hold a design, control settings, or both.

## `manifest.json`

```json
{
  "format": "oto",
  "version": 1,
  "name": "Neon Night",
  "app": "OTO 1.0.0",
  "created": "2026-10-05T04:30:00.000Z",
  "contents": { "design": true, "sounds": 3, "controls": true }
}
```

- `format` must be `"oto"` and `version` a whole number. A package with a higher version than the installed OTO understands is refused with a message asking to update OTO.
- `contents` is informational. OTO looks at the files themselves.
- A hand-made package can leave the manifest out.

## `design.json`

```json
{
  "name": "Neon Night",
  "author": "Mina Okafor",
  "description": "Neon, for Friday night leagues",
  "colors": { "--accent": "#ff2d95", "--trainer-a": "#00e5ff", "--bg-panel": "rgba(18, 8, 38, 0.86)" }
}
```

| Field | Meaning |
|-------|---------|
| `name` | The design's name (letters and digits are what count; up to 40 characters). If it is missing, the package's name is used |
| `author` | Who made it (up to 60 characters). Shown when someone installs it |
| `description` | One line about it (up to 300 characters) |
| `colors` | CSS variables the design sets. Unknown names are ignored. Values may not contain `; { } < > \` |
| `layout` | Where pieces of the overlay are moved to and how big they are: `{ "scoreboard": { "x": 0, "y": 40, "scale": 1.1 } }`. `x` and `y` are pixels of the 1920 × 1080 stage (up to ±1920), `scale` is 0.2 to 4. A piece that has not moved is not listed. The pieces: `logo`, `scoreboard`, `features`, `stadium`, `toasts`, and for each trainer (`trainerA`, `trainerB`) the whole trainer plus `.prizes`, `.tokens`, `.locks`, `.active` and `.bench` |
| `crop` | Which part of a card picture shows, as fractions of the card (0 to 1): `{ "active": { "x": 0.07, "y": 0.115, "w": 0.86, "h": 0.385 } }`. `active`, `bench`, `stadium` and `prize` (a card set on a prize card; the whole card unless it says otherwise) are rectangles (`x`, `y`, `w`, `h`, at least 5% wide and high, inside the card); `energy` is the circle cut out of a Special Energy card (`x`, `y`, `w`: the height follows). Left out, a Pokémon shows the picture of its card (`x 0.07, y 0.115, w 0.86, h 0.385`) and the Stadium its own picture window (`x 0.082, y 0.145, w 0.836, h 0.37`), because a Trainer card is laid out differently. The whole card is `{ "x": 0, "y": 0, "w": 1, "h": 1 }`, and has to be asked for |
| `tile` | Where the parts of a Pokémon's tile go, for `active` and `bench`: `{ "active": { "hp": "bottom", "retreat": "top-right" } }`. `hp`: `top`, `bottom` or `below` the picture. `energy`, `retreat` and `status`: a corner of the picture (`top-left`, `top-right`, `bottom-left`, `bottom-right`) or `below` it. The usual: HP on top, energy bottom left, retreat cost bottom right, status icons top right. Only what differs from the usual is kept |
| `prizeStyle` | The picture on the prize cards: `english` or `japanese` (a Pokémon card back) or `pokeball`. Left out (or `current`), the prize cards keep the design's own `prizeCardBack` or `cardBackImage` picture, or the built-in look. The pictures themselves come with OTO (`assets/cardbacks`), not with the package. Anything else is ignored |
| `prizeLayout` | How the six prize cards are laid out: `column`, `two-rows` (two rows of three) or `three-rows` (three rows of two). Left out, a row of six. Anything else is ignored |
| `orientation` | The screen: `portrait` for a tall 1080 × 1920 mobile screen. Left out, the usual wide 1920 × 1080 one (so `layout` and `spaces` use the pixels of the stage that is chosen). Anything else is ignored |
| `spaces` | Up to six places the overlay keeps clear for a camera feed or the like: `[ { "id": 1, "name": "Camera", "shape": "rounded", "x": 700, "y": 400, "w": 480, "h": 270 } ]`. `shape` is `rect` (the usual), `rounded` or `circle`; `x` and `y` are pixels of the stage (up to ±3840), `w` and `h` are 40 to 3840; `name` (up to 24 letters) is only for the editor. `id` (1 to 6, each once) says which picture is the frame of the space: the slot `spaceFrame<id>`; one that is missing is given the lowest number that is free. A space that does not fit these is dropped |

The color and shape variables you can set are listed in the **Look** tab of Settings, and in [`public/js/theme-options.js`](../public/js/theme-options.js). Examples: `--accent`, `--trainer-a`, `--trainer-b`, `--bg-panel`, `--bg-card`, `--fg-primary`, `--success`, `--warning`, `--danger`, `--radius`.

## Pictures, font and sounds are found by name

OTO does not read file names out of `design.json`. It looks for these exact names, so a hand-made package only has to put the right files in the right folders:

**Pictures**, `images/<slot>.<type>`, with the type `png`, `jpg`, `gif`, `webp` or `svg`:

| Slot | Where it appears |
|------|------------------|
| `logoImage` | The logo, top left |
| `backgroundImage` | Fills the whole overlay, behind everything |
| `trainerAAvatar`, `trainerBAvatar` | The round picture next to each trainer's name |
| `prizeCardBack` | The face-down prize cards |
| `cardBackImage` | Used for prize cards when there is no prize card back |
| `energySymbols` | A strip of 11 equal squares: Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless |
| `statusSymbols` | A strip of 6 equal squares: Asleep, Burned, Confused, Paralyzed, Poisoned, Trapped |
| `spaceFrame1` to `spaceFrame6` | A picture drawn over the reserved space with that `id`, stretched to its size (a frame with a see-through middle, for example). Without one the space is drawn as an outline of its shape |

**Font**, `fonts/font.<type>` with the type `woff2`, `woff`, `ttf` or `otf`.

**Sounds**, `sounds/<cue>.<type>` with the type `mp3`, `wav`, `ogg`, `m4a` or `webm`. The cues are:

| Group | Cues |
|-------|------|
| Pokémon | `deploy`, `bench`, `damage`, `heal`, `ko` |
| Turn | `turn`, `energy`, `ability`, `stadium` |
| Match | `prize`, `point`, `startgame`, `win` |
| Hype | `attack`, `topdeck` |

A cue without a sound uses OTO's built-in one. Sound effects are off until the producer switches them on (Settings, Sounds).

If a slot has files of several types (`logoImage.png` and `logoImage.jpg`), the one `design.json` names under `images` wins, otherwise the first of `png`, `jpg`, `gif`, `webp`, `svg`.

### Limits

| | |
|---|---|
| One picture or font | 4.5 MB |
| One sound | 1.5 MB |
| All the files of one design | 40 MB |
| The `.oto` file | 48 MB |
| Files in the package | 200 |

Pictures and fonts must be **files in the package**. A design cannot point at a web address: it would stop working offline, and an image on someone else's server would tell them every time an overlay loaded.

## `controls.json`: the control settings

```json
{
  "version": 1,
  "settings": {
    "display": { "nationality": false, "record": false },
    "toastSeconds": 6,
    "animationSeconds": 2.5,
    "sound": { "enabled": true, "volume": 60, "events": { "damage": { "enabled": false, "volume": 100 } } },
    "enableAttackToast": false
  }
}
```

This is the producer's configuration of the controls, as opposed to the look of the overlay. A package may carry:

| Setting | Meaning |
|---------|---------|
| `display` | One `true`/`false` per overlay element (see [`public/js/display-options.js`](../public/js/display-options.js)): scoreboard, names, nationality, record, prizes, energy counter, active Pokémon, bench, HP bars, ability tokens, stadium, toasts, animations and more |
| `toastSeconds`, `animationSeconds` | How long banners and full-screen effects stay (1 to 30 seconds) |
| `sound` | `enabled`, a master `volume` (0 to 100), and for each cue an `enabled` and a `volume` |
| `enable…Toast`, `enable…Animation` | Which announcements are switched on |
| `overlayOpacity`, `autoScale`, `showPenaltyAnimation`, `preferLowestRarity` | A few overlay and search preferences |

Only settings from this list are ever read from a package, and **only these are ever written to one**. The card API key, the password and anything specific to one computer (cache sizes, the language, the port) never travel in a package. A settings object that includes them is accepted, but those fields are dropped.

Installing a package's control settings is a normal change in the match history, so a producer can undo it with `Ctrl+Z`, and the other producers see who made it in the activity feed.

## How OTO treats a package it receives

A `.oto` file can come from anyone, so OTO treats it as data it must check, never as something to run:

- **Everything is checked by what it is**, not what it is called. A file named `logo.png` that is not a PNG is refused.
- **SVG pictures** with scripts, `foreignObject`, event handlers, `@import` or links to the web are refused.
- **File names** that could point outside the package (`../`, absolute paths, drive letters, duplicate names) make the whole package fail. Nothing in a package is ever written to disk under a name taken from it.
- **Sizes are enforced** against what each file declares, while unpacking, so a "zip bomb" that claims to be small is cut off. Files are also checked against their checksums.
- **Passwords and unusual compression** are not supported and are refused.
- **Nothing is installed unless all of it is good.** A design appears completely or not at all, and a package that fails does not change the control settings either.
- **Designs are served to the overlay as pictures, fonts and sounds only**, with a content security policy that stops a file from running anything even if it were opened directly.

## Making a package without OTO

1. Make a folder with the files you want, laid out as shown above.
2. Zip the files. Selecting the folder itself works too (the way Windows' *Compress to ZIP file* does it): if everything sits inside one folder, OTO looks inside it.
3. Rename the zip to end in `.oto`.
4. Install it from **Settings > Look > Install a .oto**, by dropping it on the control panel, or by double-clicking it with the desktop app.

Ordinary zip tools produce files OTO can read (the Windows built-in zip, PowerShell's `Compress-Archive` and `tar` were tested). OTO's own packages are plain zips too, so any of those tools can open them.
