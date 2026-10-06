# Assets

Everything that is a picture rather than code lives here, so it is easy to find and replace.

| Path | What it is | Used by |
| --- | --- | --- |
| `logo.gif` | The OTO logo (animated) | The top of the control panel, the sign-in page and the README |
| `logo.ico` | The OTO icon (several sizes) | The desktop app, the installer, the portable exe, the browser tab icon, the `.oto` file icon |
| `energy/*.png` | The 11 energy type icons, 30 × 30, one file per type (`grass`, `fire`, `water`, `lightning`, `psychic`, `fighting`, `darkness`, `metal`, `dragon`, `fairy`, `colorless`) | The overlay, the Pokémon cards and the energy editor in the control panel. A design can replace them with its own strip of icons. |
| `status/*.png` | The icons of the special conditions, one file each: `asleep`, `burned`, `confused`, `paralysis`, `poison`, `trapped`. Square pictures with a transparent background work best (a few dozen pixels is plenty: they show at 28 pixels). One that is missing is drawn as a colored disc with a letter | The overlay and the control panel. A design can replace them with its own strip of 6 pictures. |
| `cardbacks/english.*`, `japanese.*`, `pokeball.*` | The pictures a design can put on the prize cards: an English and a Japanese Pokémon card back, and a Poké Ball. Each is a PNG, a JPG or a WebP with the name `english`, `japanese` or `pokeball` (for example `english.jpg`), a picture of a card (5 wide for 7 tall) a few hundred pixels wide. One that is missing is drawn as a plain card back | The prize cards of the overlay, when the design asks for that picture (Look tab, the design's Tile tab) |
| `markers/gx.*`, `vstar.*` | The GX attack and the VSTAR Power markers of the overlay: drawings that come with OTO (SVG, original). A PNG, a WebP or a JPG with the same name beside them takes their place. Without any, the overlay shows the name in a pill. They are in color while the attack is ready and grayed out once it is used | The overlay, when GX and VSTAR are switched on (Settings, Overlay) |
| `fonts/TwemojiCountryFlags.woff2` | A font that draws the flag emoji (Windows has no flags of its own). Only used for the characters of flags | The nationality shown as a flag, on the overlay and next to the nationality box in the control panel |
| `screenshots/*.png` | The pictures in the main README | The README only. They are not shipped in the app. |

## How the app uses them

- The server serves `logo.gif` at `/logo.gif`, `logo.ico` at `/logo.ico` (and `/favicon.ico`), the energy icons at `/assets/energy/<type>.png`, the status icons at `/assets/status/<name>.png`, the card backs at `/assets/cardbacks/<name>` (the file of that name, whatever kind of picture it is) the markers at `/assets/markers/<gx or vstar>` and the flag font at `/assets/fonts/TwemojiCountryFlags.woff2`.
- The installer and the desktop app get their icon from `logo.ico` (see `build` in `package.json`).
- Only `logo.gif`, `logo.ico`, `energy/`, `status/`, `cardbacks/`, `markers/` and `fonts/` are packaged into the app. Screenshots stay in the repository.

## Changing an icon

Replace the file and keep the name. The energy icons look best as square pictures with a transparent background; the overlay shows them at 30 × 30 pixels.

## Rights

The code is MIT licensed, but these pictures are not part of that license. The energy icons are the Pokémon TCG energy symbols, the status icons and the card backs were added by the maintainer (the card backs are Pokémon card artwork), and the flag font is the Twemoji flags (CC BY 4.0); see [NOTICE.md](../NOTICE.md). If you redistribute OTO and cannot ship the energy, status or card back pictures, delete `energy/`, `status/` or `cardbacks/`: the overlay and the control panel then draw plain colored discs and plain card backs.
