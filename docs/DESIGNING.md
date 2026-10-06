# OTO for artists and designers

A **design** gives the overlay its own identity: a store, a league, an event, a streamer. This guide shows how to make one, from a first color change to a full custom screen, and how to share it as a single `.oto` file. For the exact file format see [PACKAGE-FORMAT.md](PACKAGE-FORMAT.md). If you only run matches, read the [producer guide](USING.md).

**Contents:** [What a design can change](#what-a-design-can-change) · [Your first design in ten minutes](#your-first-design-in-ten-minutes) · [Learn from the built-in look](#learn-from-the-built-in-look) · [Colors and pictures](#colors-and-pictures) · [Fonts: one for each kind of text](#fonts-one-for-each-kind-of-text) · [Layout: move and resize](#layout-move-and-resize) · [Tall mobile screens](#tall-mobile-screens) · [Reserved spaces for a camera](#reserved-spaces-for-a-camera) · [Cards: crop and tile](#cards-crop-and-tile) · [Prize cards](#prize-cards) · [Sounds](#sounds) · [Several overlays, several designs](#several-overlays-several-designs) · [Sharing: the .oto file](#sharing-the-oto-file) · [Making a design by hand](#making-a-design-by-hand) · [Tips](#tips)

---

## What a design can change

| Part | What you control |
|------|------------------|
| **Colors** | Panels, text, highlight, trainer colors, status colors, borders, shadows, corner roundness, animation speed |
| **Pictures** | Logo, background, trainer avatars, prize card back, card back, a strip of energy icons, a strip of status icons, and a frame for each reserved space |
| **Fonts** | A main font, plus a font for names, numbers, labels, announcement titles, subtitles and small text |
| **Layout** | The position and size of every piece of the overlay, on a wide or a tall screen |
| **Reserved spaces** | Up to six places kept clear for a camera feed (rectangle, rounded or oval), with your own frame over each |
| **Cards** | Which part of a card shows for the Active Pokémon, the bench, the Stadium and the prize cards; where the HP bar, energy, retreat cost and status icons go |
| **Prize cards** | The back (English, Japanese, a Poké Ball or your own) and the layout (a row, a column, two rows of three, three rows of two) |
| **Sounds** | A sound for any moment of a match |

Everything is optional. What a design leaves out is the built-in look.

Everything a design uses is a **file inside it**. A design can never point at a web address, so it works offline and never makes an overlay contact anyone's server.

---

## Your first design in ten minutes

1. Open the control panel, **Settings**, **Look**.
2. Click **New**, give it a name (`Store League`) and **Create**. (Or start from [a copy of the built-in look](#learn-from-the-built-in-look).)
3. Change a few **colors**: *Highlight*, *Trainer A color*, *Trainer B color*. Leave a color empty to keep the built-in one.
4. Upload a **Logo** and a **Background** under *Pictures and font*.
5. Click **Put on the overlay**. If OBS is showing the overlay, you see it right away; changes save by themselves and reach the stream as you make them.
6. Click **Layout and crop** to open the editor, move the pieces where you want them, and close it.
7. **Save as .oto** to share it.

---

## Learn from the built-in look

Two ways to see how the default look is made, so you can change it instead of starting from nothing:

- **In the app:** *Copy of the built-in look* (Look tab) creates a design with every color and the font lists of the built-in look written out. Open the editor's **Code** tab to read it as text.
- **In the repository:** [docs/examples/built-in-look/design.json](examples/built-in-look/design.json) is the same design as a file. Every field is written out with its usual value: colors, `fontFamilies`, `layout`, `crop`, `tile`, `prizeStyle`, `prizeLayout`, `orientation` and `spaces`. Delete what you do not need, change what you like, put it in a folder named after your design (see [Making a design by hand](#making-a-design-by-hand)). A test keeps this file in step with the real defaults, so it stays honest.

---

## Colors and pictures

The color variables are CSS custom properties, listed in the Look tab (and in [`public/js/theme-options.js`](../public/js/theme-options.js)): `--accent`, `--trainer-a`, `--trainer-b`, `--bg-panel`, `--bg-card`, `--fg-primary`, `--success`, `--warning`, `--danger`, `--radius`, `--transition` and more. Any CSS color works (`#ff2d95`, `rgba(18, 8, 38, 0.86)`); lengths such as `--radius` take `14px`.

Pictures are PNG, JPG, GIF, WebP or SVG (an SVG with scripts or links is refused), up to 4.5 MB each:

| Picture | Where it shows |
|---------|----------------|
| Logo | Top left corner |
| Background | Fills the whole overlay, behind everything |
| Trainer A / B avatar | The round picture beside each name |
| Prize card back / Card back | The face-down prize cards |
| Energy icons | A strip of 11 equal squares: Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Fairy, Colorless |
| Status icons | A strip of 6 equal squares: Asleep, Burned, Confused, Paralyzed, Poisoned, Trapped |
| Space 1 to 6: frame | A frame drawn over a [reserved space](#reserved-spaces-for-a-camera) |

---

## Fonts: one for each kind of text

The text of the overlay is in **groups**, and each group can have a font of its own. Anything a group does not set takes the main font, and small text takes the usual font of the page.

| Group | What it is |
|-------|-----------|
| **Main font** | Names, numbers, labels and announcements, unless a group below says otherwise |
| **Names** | Trainers, Pokémon, feature cards and the Stadium |
| **Numbers** | The score, the HP and the damage |
| **Labels and tags** | The round, TURN, the counters, the locks, conditions, abilities, tools and attacks |
| **Announcement titles** | The big words of a banner or effect: TOP DECK, KNOCKED OUT, PAUSED |
| **Announcement subtitles** | The line under the big words |
| **Small text** | Everything else |

For each group, in the editor's **Fonts** tab, you can give:

- **a font file** (WOFF2, WOFF, TTF or OTF, up to 4.5 MB). It goes inside the design, so it works on any computer; and/or
- **a list of fonts to use**: a CSS font-family such as `Impact, "Arial Black", sans-serif`. These must be installed on the computer that shows the overlay (the one running OBS), so use them for safe system fonts only. If you give both, the file is used first.

The editor's overlay changes as you type. In a design folder the files are `fonts/font.woff2` (main) and `fonts/<group>.woff2` for the others, where the group is `names`, `numbers`, `labels`, `banners`, `subtitles` or `text`; in `design.json` the lists are `"fontFamilies": { "numbers": "Impact, sans-serif" }`.

---

## Layout: move and resize

**Layout and crop** opens the editor: the overlay on a canvas you can zoom (scroll or pinch) and pan. Drag a piece to move it, drag a corner to resize it, or type exact numbers. Snapping lines help you align things, and a **grid** (squares of the size you choose, 8 to 480 pixels) can be shown over the canvas, with pieces jumping onto its lines (*Snap to grid*). The grid is a choice of your browser, for editing only; it is not part of the design.

The pieces are: the logo, the scoreboard, the feature cards, the Stadium, the announcement banners, and for each trainer everything together plus the prize cards, the turn tokens, the locks, the Active Pokémon and the bench. Moving a trainer moves what is in it, and each piece can still be moved on its own. The editor shows sample Pokémon, tools, a Stadium and announcements, so you see how it looks with a full table.

The **Code** tab shows the same design as text (the JSON saved in `design.json`, without the pictures). Typing changes the overlay as soon as the text makes sense, what the mouse does is written back into the text, and a mistake is shown with its line.

---

## Tall mobile screens

The overlay is a wide **1920 × 1080** screen unless the design says otherwise. For a vertical stream (a phone held upright), the editor can switch the design to a **mobile screen of 1080 × 1920**: the scoreboard on top, the trainers one under the other with the Stadium and feature cards between them, the bench in a row. The canvas follows the choice. Set the OBS browser source to the same size.

To show a wide and a tall overlay at the same time, see [Several overlays, several designs](#several-overlays-several-designs). In `design.json`: `"orientation": "portrait"`.

---

## Reserved spaces for a camera

Places the overlay keeps clear for something else, usually a **camera feed**. In the editor's **Spaces** tab, add up to six. Each has a name (only for you), a shape (rectangle, rounded rectangle, circle or oval), a position and a size. Drag it on the canvas, resize it by a corner (`Shift` keeps its shape), or type the numbers.

The overlay draws an outline of the shape, or **your own picture** over it: a frame with a see-through middle, uploaded in the same tab (the pictures *Space 1 to 6: frame*). What is inside stays see-through, so the camera you put under it in OBS shows through. The outline can be hidden by the producer in Settings, Overlay, Table.

---

## Cards: crop and tile

**Card crop.** The overlay does not have to show a whole card. Choose which part of the picture shows for the **Active Pokémon**, the **bench**, the **Stadium** and **a card set on a prize card**: just the art (the usual), the name and the art, the whole card, or any rectangle you draw on the card. Special Energy cards on a Pokémon show as a circle cut out of the card, which you can move and resize too.

**Tile.** On top of the picture of a Pokémon sit the HP bar, the attached energy, the retreat cost (Active Pokémon only) and the status icons. For the Active Pokémon and for the bench, choose where each goes: on the picture at the top or bottom, in a corner, or below it. Tools are shown as chips under the Pokémon.

---

## Prize cards

Choose the picture on the back of the prize cards: the design's own *Prize card back* picture (the English Pokémon card back when it has none), the **English** or **Japanese** Pokémon card back, or a **Poké Ball**. The card backs that come with OTO are files in [`assets/cardbacks`](../assets/README.md); a plain drawing shows when a file is missing. The prize cards stay cards: they fade out when taken.

Choose the **layout** too: a row of six (the usual), a column, two rows of three or three rows of two. In `design.json`: `prizeStyle` (`current`, `english`, `japanese`, `pokeball`) and `prizeLayout` (`row`, `column`, `two-rows`, `three-rows`).

---

## Sounds

A design can bring a sound for any moment: deploy, bench, damage, heal, knock out, turn, energy, ability, Stadium, prize, point, start game, win, attack, Top Deck. MP3, WAV, OGG, M4A or WebM, up to 1.5 MB each. They play only while the design is on air and the producer has switched sound effects on; a sound the producer chose themselves wins over the design's, which wins over the built-in one.

---

## Several overlays, several designs

One match can feed several overlays at once, each with its own design: for example a wide design for the main stream and a tall mobile design for a phone stream. The producer adds them in Settings, Overlay, **More overlays**: each gets its own address (`/overlay?screen=<name>`) and chooses its design from your installed designs. So you only need to hand over the designs; the producer wires them up.

---

## Sharing: the `.oto` file

A **`.oto` file** puts a design, its sounds and (if you choose) the producer's control settings in one compressed file.

- **Save one:** Look tab, **Save as .oto** (with or without the control settings: what the overlay shows or hides, how long announcements stay, which sounds are on; never an API key or password).
- **Install one:** Look tab, **Install a .oto**, or drop the file on the control panel, or double-click it with the desktop app. You are shown what is inside first and choose what to install.
- A `.oto` is an ordinary **ZIP file with another name**, so you can open one to see inside. It can only ever hold pictures, fonts, sounds and settings, never code, and a damaged or tricky file is refused without installing any of it.

---

## Making a design by hand

You do not need OTO to make a design:

1. Make a folder named after your design.
2. Put in `design.json` (start from [the example](examples/built-in-look/design.json)) and, if you have them, `images/`, `fonts/` and `sounds/` with the file names from [PACKAGE-FORMAT.md](PACKAGE-FORMAT.md). A picture is found by its name (`images/logoImage.png`), a font by its group (`fonts/names.woff2`), a sound by its moment (`sounds/damage.mp3`).
3. Zip the folder and rename the zip to `.oto`.
4. Install it from Settings, Look, **Install a .oto**.

The Windows built-in zip, PowerShell's `Compress-Archive` and `tar` were all tested.

---

## Tips

- **Test on a full table.** The editor's sample shows a Pokémon with energy, tools, abilities and a condition, a Stadium and feature cards, but a real match has more: look at both a Pokémon with a long name and one with five energy.
- **Keep text readable at stream size.** The overlay is drawn on 1920 × 1080 (or 1080 × 1920) pixels, then OBS scales it.
- **Leave room for the producer's choices.** Producers can hide pieces, so do not make one piece depend on another being visible.
- **Fonts and licenses.** A font you put in a design is shared with it. Check that its license allows that. The same goes for pictures and sounds ([NOTICE.md](../NOTICE.md)).
- **Do not use Pokémon artwork you do not have the rights to** for your logo or avatars.
