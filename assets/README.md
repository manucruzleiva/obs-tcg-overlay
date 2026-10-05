# Assets

Everything that is a picture rather than code lives here, so it is easy to find and replace.

| Path | What it is | Used by |
| --- | --- | --- |
| `logo.gif` | The OTO logo (animated) | The top of the control panel, the sign-in page and the README |
| `logo.ico` | The OTO icon (several sizes) | The desktop app, the installer, the portable exe, the browser tab icon, the `.oto` file icon |
| `energy/*.png` | The 11 energy type icons, 30 × 30, one file per type (`grass`, `fire`, `water`, `lightning`, `psychic`, `fighting`, `darkness`, `metal`, `dragon`, `fairy`, `colorless`) | The overlay, the Pokémon cards and the energy editor in the control panel. A design can replace them with its own strip of icons. |
| `screenshots/*.png` | The pictures in the main README | The README only. They are not shipped in the app. |

## How the app uses them

- The server serves `logo.gif` at `/logo.gif`, `logo.ico` at `/logo.ico` (and `/favicon.ico`) and the energy icons at `/assets/energy/<type>.png`.
- The installer and the desktop app get their icon from `logo.ico` (see `build` in `package.json`).
- Only `logo.gif`, `logo.ico` and `energy/` are packaged into the app. Screenshots stay in the repository.

## Changing an icon

Replace the file and keep the name. The energy icons look best as square pictures with a transparent background; the overlay shows them at 30 × 30 pixels.

## Rights

The code is MIT licensed, but these pictures are not part of that license. The energy icons are the Pokémon TCG energy symbols; see [NOTICE.md](../NOTICE.md). If you redistribute OTO and cannot ship them, delete `energy/`: the overlay and the control panel then draw plain colored discs.
