# Notices

## Disclaimer

This project is a fan-made tool for Pokémon TCG streaming and tournament production. It is **not** affiliated with, endorsed by, or officially connected to The Pokémon Company International, Nintendo, Creatures Inc. or GAME FREAK inc.

Pokémon and all related names, characters and imagery are trademarks of their respective owners. The MIT license in [LICENSE](LICENSE) covers this project's source code only. It does not grant any rights to Pokémon trademarks, card artwork or card data.

The project logo (`assets/logo.gif`, `assets/logo.ico`) is artwork chosen by the maintainer for this project. It is covered by the same disclaimer: nothing in the license grants rights to anyone else's trademarks or artwork that it may resemble.

The energy type icons in `assets/energy/` are the round Pokémon TCG energy symbols (Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless). They were supplied by the maintainer from another of their projects, with no license of their own, and the symbols are the property of their respective owners (see above). They are used here only to make the overlay recognizable to Pokémon TCG viewers, and **they are not covered by the MIT license**. If you redistribute OTO, check that you are allowed to ship them, or delete the folder: the overlay then falls back to plain colored discs.

The status condition icons in `assets/status/` (Asleep, Burned, Confused, Paralyzed, Poisoned, Trapped) were added by the maintainer. The same applies to them: they are **not covered by the MIT license**, and if you redistribute OTO you should check that you are allowed to ship them, or delete the folder (the overlay then draws a colored disc with a letter instead).

The card backs in `assets/cardbacks/` (the English and the Japanese Pokémon card back) are Pokémon TCG artwork added by the maintainer. They are the property of their respective owners (see above) and **are not covered by the MIT license**; they are used only so that a design can print a recognizable card back on the prize cards of the overlay. If you redistribute OTO, check that you are allowed to ship them, or delete the folder (the overlay then draws plain card backs and a Poké Ball of its own).

The flag emoji font in `assets/fonts/TwemojiCountryFlags.woff2` is the "Twemoji Country Flags" font made by [TalkJS](https://github.com/talkjs/country-flag-emoji-polyfill) (MIT license) from the [Twemoji](https://github.com/twitter/twemoji) artwork, Copyright 2020 Twitter, Inc and other contributors, which is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It is used as it is, without changes. Windows has no flags in its emoji font (a flag comes out as its two letters), so the overlay and the control panel use this font, and only for the characters of flags, when a nationality is shown as a flag.

## AI-generated content

This project, including its source code, tests, documentation and build configuration, was created entirely with AI coding assistants (Claude, by Anthropic) under the direction of the maintainer. It is released under the MIT license in [LICENSE](LICENSE) on an "as is" basis. See the [AI disclosure](README.md#ai-disclosure) in the README.

## Card data and images

Card data and card images are **not** bundled with this project. They are fetched at runtime from third-party services and kept on the user's own computer, for their own use:

- [Pokémon TCG API](https://pokemontcg.io/) (see their [terms of service](https://pokemontcg.io/terms)): card data, and card pictures from their image host. The pictures of the newest sets are on the [Scrydex](https://scrydex.com/) image host (`images.scrydex.com`), which the card data points to.
- [TCGdex](https://tcgdex.dev/) (see their site for the terms): card data in many languages, and card pictures from `assets.tcgdex.net`. It needs no account and is used when the Pokémon TCG API does not answer, or when it is chosen in Settings, Cards.
- [Scrydex](https://scrydex.com/) with **your own account**: when you save your API key and team ID in Settings, Cards, OTO can ask Scrydex for cards and for the Standard library. The key stays on your computer, is never shown in full, and never goes into an exported file or a `.oto` package. Your use is governed by your agreement with Scrydex.
- [PokeAPI](https://pokeapi.co/): the list of Pokémon names in `public/js/pokedex.js` (made from PokeAPI's list of species) and, at runtime, the official artwork of a Pokémon that is shown next to a trainer's deck, from the [PokeAPI sprites](https://github.com/PokeAPI/sprites) repository on GitHub. The artwork belongs to its owners (see the disclaimer above); it is downloaded the first time it is shown and kept on the user's computer, and none of it is bundled.
- [Limitless TCG](https://limitlesstcg.com/decks): the names of the decks that are played the most, and which Pokémon is on the icon of each, in `public/js/deck-popular.js` (a snapshot read on 2026-10-06). Only the names and the Pokémon are kept, as suggestions while a deck is typed; none of their pictures or other data is used.

Remembered searches, the **card library** (the Standard, Gym Leader Challenge and Expanded lists) and saved card pictures are copies of what these services provide, stored in OTO's data folder. The library downloader paces its requests and retries politely, but anyone running OTO is responsible for using card data and images in line with those services' terms and with the rights holders' content policies.

## Designs and packages made by others

A `.oto` package or a design may contain pictures, fonts and sounds made by someone else. Their licenses are between you and them; OTO only installs and plays them.

## Third-party software

All dependencies are MIT licensed, or under similarly permissive licenses (see each project). Exact versions are pinned in `package-lock.json`.

Runtime:

- [express](https://github.com/expressjs/express)
- [socket.io](https://github.com/socketio/socket.io)
- [compression](https://github.com/expressjs/compression)
- [helmet](https://github.com/helmetjs/helmet)
- [electron-updater](https://github.com/electron-userland/electron-builder) (in-app updates, desktop build)
- [sql.js](https://github.com/sql-js/sql.js), SQLite compiled to JavaScript
- [winston](https://github.com/winstonjs/winston)

Development and packaging:

- [electron](https://github.com/electron/electron)
- [electron-builder](https://github.com/electron-userland/electron-builder)
- [playwright-core](https://github.com/microsoft/playwright) (browser tests; no browser is bundled)
- [concurrently](https://github.com/open-cli-tools/concurrently)
- [wait-on](https://github.com/jeffbski/wait-on)
- [socket.io-client](https://github.com/socketio/socket.io)
