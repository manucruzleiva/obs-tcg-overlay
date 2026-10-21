# OTO for artists and designers

A **design** gives the overlay its own identity: a store, a league, an event, a streamer. This guide shows how to make one, from a first color change to a full custom screen, and how to share it as a single `.oto` file. For the exact file format see [PACKAGE-FORMAT.md](PACKAGE-FORMAT.md). If you only run matches, read the [producer guide](USING.md).

**Contents:** [What a design can change](#what-a-design-can-change) · [Your first design in ten minutes](#your-first-design-in-ten-minutes) · [Learn from the classic look](#learn-from-the-classic-look) · [Colors and pictures](#colors-and-pictures) · [Fonts: one for each kind of text](#fonts-one-for-each-kind-of-text) · [Layout: move and resize](#layout-move-and-resize) · [Tall mobile screens](#tall-mobile-screens) · [Reserved spaces for a camera](#reserved-spaces-for-a-camera) · [Cards: crop and tile](#cards-crop-and-tile) · [Prize cards](#prize-cards) · [Sounds](#sounds) · [Style sheet and animations](#style-sheet-and-animations) · [Several overlays, several designs](#several-overlays-several-designs) · [Sharing: the .oto file](#sharing-the-oto-file) · [Making a design by hand](#making-a-design-by-hand) · [Tips](#tips)

---

## What a design can change

| Part | What you control |
|------|------------------|
| **Colors** | Panels, text, highlight, trainer colors, the color of each kind of card (abilities, Pokémon Tools, the Stadium, Supporters), status colors, borders, shadows, corner roundness, animation speed |
| **Pictures** | Logo, background, trainer avatars, prize card back, card back, a strip of energy icons, a strip of status icons, and a frame for each reserved space |
| **Fonts** | A main font, plus a font for names, numbers, labels, announcement titles, subtitles and small text |
| **Layout** | The position and size of every piece of the overlay, on a wide or a tall screen |
| **Reserved spaces** | Up to six places kept clear for a camera feed (rectangle, rounded or oval), with your own frame over each |
| **Cards** | Which part of a card shows for the Active Pokémon, the bench, the Stadium, the prize cards and the Pokémon Tools; where the HP bar, energy, retreat cost and status icons go |
| **Prize cards** | The back (English, Japanese, a Poké Ball or your own) and the layout (a row, a column, two rows of three, three rows of two) |
| **Sounds** | A sound for any moment of a match |
| **Style sheet** | Your own CSS on top of all this: restyle any piece of the overlay, and animate the moments of a match (damage, a knock out, a prize card taken, a turn that starts) |

Everything is optional. What a design leaves out is the classic look.

Everything a design uses is a **file inside it**. A design can never point at a web address, so it works offline and never makes an overlay contact anyone's server.

---

## Your first design in ten minutes

1. Open the control panel, **Settings**, **Look**.
2. Click **New**, give it a name (`Store League`) and **Create**. (Or start from [a copy of the classic look](#learn-from-the-classic-look).)
3. Change a few **colors**: *Highlight*, *Trainer A color*, *Trainer B color*. Leave a color empty to keep the built-in one.
4. Upload a **Logo** and a **Background** under *Pictures and font*.
5. Click **Put on the overlay**. If OBS is showing the overlay, you see it right away; changes save by themselves and reach the stream as you make them.
6. Click **Layout and crop** to open the editor, move the pieces where you want them, and close it.
7. **Save as .oto** to share it.

---

## Learn from the classic look

Three ways to see how a design is made, so you can change one instead of starting from nothing:

- **In the app:** *Copy of the classic look* (Look tab) creates a design with every color and the font lists of the classic look written out. Open the editor's **Code** tab to read it as text.
- **In the repository:** [docs/examples/built-in-look/design.json](examples/built-in-look/design.json) is the same design as a file. Every field is written out with its usual value: colors, `fontFamilies`, `layout`, `crop`, `tile`, `prizeStyle`, `prizeLayout`, `orientation` and `spaces`. Delete what you do not need, change what you like, put it in a folder named after your design (see [Making a design by hand](#making-a-design-by-hand)). A test keeps this file in step with the real defaults, so it stays honest.
- **A finished example:** [Championship Blue](examples/championship-blue/README.md), OTO's default look, frames a top-down table camera with two blue columns. Its files are in [assets/designs/championship-blue](../assets/designs/championship-blue), and its `.oto` is ready to install.

---

## Colors and pictures

**Kinds of card.** Five colors say what kind of thing something is, in the same way everywhere on the overlay: `--ability` (red), `--tool` (purple), `--stadium` (green), `--supporter` (orange) and `--lost-zone` (violet). An ability token and its diamond, the frame of a Pokémon Tool, the Stadium's name and play counter, the Supporter counter and the frame of the Lost Zone take them. They are in the **Kinds of card** group in the Look tab.

The color variables are CSS custom properties, listed in the Look tab (and in [`public/js/theme-options.js`](../public/js/theme-options.js)): `--accent`, `--trainer-a`, `--trainer-b`, `--bg-panel`, `--bg-card`, `--fg-primary`, `--success`, `--warning`, `--danger`, `--radius`, `--transition` and more. Any CSS color works (`#ff2d95`, `rgba(18, 8, 38, 0.86)`); lengths such as `--radius` take `14px`. A color cannot hold a `url()` (nor `image-set()` and the like): pictures go in the slots below.

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

The pieces are: the logo, the scoreboard, the feature cards, the Stadium, the announcement banners, and for each trainer everything together plus the prize cards, the turn tokens, the locks, the Active Pokémon and the bench. Moving a trainer moves what is in it, and each piece can still be moved on its own. The editor shows sample Pokémon, tools, a Stadium and announcements, so you see how it looks with a full table. The feature cards go over the bench of a trainer (the producer chooses which, and the bench is hidden while they are shown), so they are part of that trainer, and move with it: the **Feature cards** switch above the canvas shows them, over the bench they go over on air, and hides them again so that bench can be placed. The **Banner** switch does the same for an announcement banner.

The **Code** tab shows the same design as text (the JSON saved in `design.json`, without the pictures and without the style sheet, which has [a tab of its own](#style-sheet-and-animations)). Typing changes the overlay as soon as the text makes sense, what the mouse does is written back into the text, and a mistake is shown with its line.

---

## Tall mobile screens

The overlay is a wide **1920 × 1080** screen unless the design says otherwise. For a vertical stream (a phone held upright), the editor can switch the design to a **mobile screen of 1080 × 1920**: the scoreboard on top, the trainers one under the other with the Stadium between them, the bench in a row (and the feature cards, smaller, in its place while they are shown). The canvas follows the choice. Set the OBS browser source to the same size.

To show a wide and a tall overlay at the same time, see [Several overlays, several designs](#several-overlays-several-designs). In `design.json`: `"orientation": "portrait"`.

---

## Reserved spaces for a camera

Places the overlay keeps clear for something else, usually a **camera feed**. In the editor's **Spaces** tab, add up to six. Each has a name (only for you), a shape (rectangle, rounded rectangle, circle or oval), a position and a size. Drag it on the canvas, resize it by a corner (`Shift` keeps its shape), or type the numbers.

The overlay draws an outline of the shape, or **your own picture** over it: a frame with a see-through middle, uploaded in the same tab (the pictures *Space 1 to 6: frame*). What is inside stays see-through, so the camera you put under it in OBS shows through. The outline can be hidden by the producer in Settings, Overlay, Table.

---

## Cards: crop and tile

**Card crop.** The overlay does not have to show a whole card. Choose which part of the picture shows for the **Active Pokémon**, the **bench**, the **Stadium**, **a card set on a prize card** and the **Pokémon Tools** (the tabs of the crop editor, `active`, `bench`, `stadium`, `prize` and `tool` in `design.json`): just the art (the usual), the name and the art, the whole card, or any rectangle you draw on the card. Special Energy cards on a Pokémon show as a circle cut out of the card, which you can move and resize too.

**The GX attack and the VSTAR Power** are pictures too (`assets/markers/gx` and `vstar`): drawings that come with OTO, which a producer can replace by putting a PNG, a WebP or a JPG of their own with the same name in that folder. They show in color while they are ready and grayed out once they are used.

**Tile.** On top of the picture of a Pokémon sit the HP bar, the attached energy, the retreat cost (Active Pokémon only) and the status icons. For the Active Pokémon and for the bench, choose where each goes: on the picture at the top or bottom, in a corner, or below it. **Pokémon Tools** are shown as small pictures of their cards under the Pokémon (the Trainer card's picture window unless the **Tools** crop says otherwise). A tool put there by hand with no picture is a small chip with its name. The producers' switches choose how tools are drawn (Settings, Overlay): the pictures are on, and the names as text are off, so a design that prefers text can ship that setting in its `.oto` control settings (`display.toolNames: true`, `display.toolCards: false`).

---

## Prize cards

Choose the picture on the back of the prize cards: the design's own *Prize card back* picture (the English Pokémon card back when it has none), the **English** or **Japanese** Pokémon card back, or a **Poké Ball**. The card backs that come with OTO are files in [`assets/cardbacks`](../assets/README.md); a plain drawing shows when a file is missing. The prize cards stay cards: they fade out when taken, each on its own (the producer marks the very prize card a player took, so the taken ones are not always the last ones).

Choose the **layout** too: a row of six (the usual), a column, two rows of three or three rows of two. In `design.json`: `prizeStyle` (`current`, `english`, `japanese`, `pokeball`) and `prizeLayout` (`row`, `column`, `two-rows`, `three-rows`).

---

## Sounds

A design can bring a sound for any moment: deploy, bench, damage, heal, knock out, turn, energy, ability, Stadium, prize, point, start game, win, attack, Top Deck. MP3, WAV, OGG, M4A or WebM, up to 1.5 MB each. They play only while the design is on air and the producer has switched sound effects on; a sound the producer chose themselves wins over the design's, which wins over the built-in one.

---

## Style sheet and animations

A design can carry a **style sheet**: one file of CSS, `styles.css`, next to `design.json`. It comes after the classic look and after everything else the design sets, so it can restyle any piece of the overlay and animate it with `@keyframes`. For the animations, the overlay marks what just happened in the match (a Pokémon took damage, a prize card was taken, a turn started) with a class on that piece, for a short while. These are the **moments**.

A style sheet is checked when it is saved and when a design is installed, and again each time an overlay gets it. It can only restyle the overlay's stage, and it can only use the design's own pictures and fonts. It can be up to 256 KB.

### Start

- **In the editor.** Look tab, choose the design, **Edit the style sheet**: the design editor opens on its **Style sheet** tab (it is also there when you open **Layout and crop**). Type in the box and the editor's overlay changes as you type (Tab writes two spaces; `Ctrl+M` makes Tab move on to the next control instead, and back). Something that is not allowed is shown with its line, and the overlay keeps the last version that made sense. **Save** keeps the style sheet with the rest of the design. The same tab has the [pictures for the style sheet](#pictures-for-the-style-sheet), **Try a moment** (choose a moment and a side, and it plays on the editor's overlay, so you can see an animation without a match) and a **How to use it** note with the moments.
- **By hand.** Write `styles.css` as UTF-8 text and put it next to `design.json` (see [Making a design by hand](#making-a-design-by-hand)). A style sheet with something not allowed in it makes the install fail, and the message says on which line.

### Every rule is for the stage

The overlay is drawn on a **stage**, `#stage`: the 1920 × 1080 box (1080 × 1920 on a tall screen) that OBS shows. Every rule is put on it: OTO writes `.scoreboard { ... }` as `#stage .scoreboard { ... }`. So you write the classes of the pieces as they are, and nothing outside the stage can be styled. Nothing is drawn outside it either: what goes past the edge of the stage (a shadow or an outline of `#stage`, a piece moved or grown past it, a `position: fixed` piece) is cut off there, so the page around the stage stays see-through when the browser source in OBS is not the shape of the stage.

The `#stage` in front also gives your rule more weight than the built-in rule for the same piece, so yours wins without `!important`. The built-in rules that name the stage themselves weigh more: those for a tall screen (`#stage.portrait .trainer`) and for the bench in a row (`#stage.bench-row .bench`). To change those, write the same selector: yours comes after the built-in one, so it wins. What the overlay writes on a piece itself (the width of an HP bar, the scaling of the stage) wins over your rules; only an animation goes over it while it plays (see [the tips](#tips-for-the-style-sheet)).

**The page around the stage** must stay see-through for OBS. A rule for `:root` or `html` alone can only set custom properties (`--name: value`), and anything else in it is refused. That is the place for `--oto-moment-ms` (see [the moments](#the-moments)), for variables of your own, which every piece can then use (`box-shadow: var(--glow)`), and for the design's own colors and pictures: a rule for `:root` comes after them, so `:root { --accent: #ff00aa; }` wins over the design's highlight color. (Write it for `:root`: a rule for `html` weighs less than the variables of the classic look and of the design, so it only sets variables of your own.)

```css
:root { --oto-moment-ms: 1200; --glow: 0 0 12px #7c8cff; }
```

**Classes on the page.** OTO marks the page (`<html>`) with what the design has. For a rule that depends on one, start it with `:root` and the class: `:root.has-logo .scoreboard { ... }` is written `:root.has-logo #stage .scoreboard { ... }`. Without `:root`, `.has-logo .scoreboard` would look for `.has-logo` inside the stage, and find nothing.

| Class on `<html>` | When |
|-------------------|------|
| `has-logo`, `has-backdrop` | The design has a logo, a background |
| `has-avatar-a`, `has-avatar-b` | The design has an avatar for Trainer A, for Trainer B |
| `has-energy-sprite`, `has-status-sprite` | The design has its own energy icons, status icons |
| `prize-english`, `prize-japanese`, `prize-pokeball` | The picture the prize cards show (none of these when they show the design's own card back) |
| `prize-layout-column`, `prize-layout-two-rows`, `prize-layout-three-rows` | How the prize cards are laid out (none of these for a row) |

The stage itself carries `portrait` (a tall screen), `bench-row` (the bench in a row), `is-paused` (the game is paused) `features-on-a` or `features-on-b` (the feature cards are shown over the bench of Trainer A, of Trainer B) and `pile-view-on-a` or `pile-view-on-b` (a discard pile or a Lost Zone is shown over that bench): write `#stage.is-paused .scoreboard`. Other pieces have classes for their state too, for example `.trainer.is-turn` (the trainer whose turn it is), `.prize.taken`, `.token.used`, and `.hp.warn` and `.hp.low` (an HP bar at half or less, at a quarter or less). To find the pieces and their classes, open the overlay (`http://localhost:6767/overlay`) in a browser and look with its developer tools, or read [`public/css/overlay.css`](../public/css/overlay.css).

Some pieces also say what they are in an attribute, whatever their text says:

| Attribute | On | Says |
|-----------|----|------|
| `data-lock` | `.lock` | Which lock it is: `item` (Item lock) or `evolution` (Evolution lock). Draw each its own way: `.lock[data-lock="item"]` |
| `data-size` | `.bench` | How many places the bench has, from 2 to 8 (5 unless a card made it bigger or smaller) |
| `data-count` | `.bench` | How many of those places have a Pokémon in them, from 0 |
| `data-slot` | `.mon` of the bench | Its place on the bench, from 0 (the first) to 7, as the game counts them: `.bench .mon[data-slot="5"]` is the sixth place |

So a bigger bench can have a layout of its own, for example smaller tiles when it has 6 places or more: `.bench[data-size="6"] .mon.mini, .bench[data-size="7"] .mon.mini, .bench[data-size="8"] .mon.mini { height: 72px; }`.

**The feature cards** are in the piece of the trainer whose bench they cover, after the bench: `.trainer-a .features` or `.trainer-b .features`. While they are shown that trainer has `features-on` (and the stage `features-on-a` or `features-on-b`), and the classic look hides its bench with `#stage .trainer.features-on .bench { display: none; }` (write the same selector to keep the bench, under the cards). In the classic look they take the bench's place under the Active Pokémon; a design that places the bench itself (`position: absolute`) places the cards there too: `.features { position: absolute; left: 8px; top: 464px; width: 424px; }`. Each card is a `figure.feature` with its picture, `img.feature-img`, and no name written on it (it is the picture's `alt` and the card's `title`). Cards joined by a sign are a stack, `.feature-stack`, with `data-cards` (how many cards) and the signs between them (`.feature-sep`, whose text is the sign); a card on its own is a `.feature` of its own, and `.features.combo` says there is at least one sign.

**A pile over the bench** (the discard pile or the Lost Zone, while the producer shows it) is `.pile-view`, in the piece of the trainer whose pile it is, with `data-pile` (`discard` or `lostZone`) and `data-count`. That trainer has `pile-view-on` meanwhile, and the classic look hides its bench and its feature cards. Inside: `.pv-head` (`.pv-title` and `.pv-count`), then one `.pv-group` for each kind that has cards, `.pv-pokemon`, `.pv-trainer` and `.pv-energy` (with `data-count`), each a `.pv-label` (`.pv-label-text`, `.pv-label-count`) and a row `.pv-cards` of `figure.pv-card`, each with the artwork of its card (`.pv-art`, a window that cuts `img.pv-img` as the bench's crop says), `.pv-copies` (`×2`) when there are more copies of a card, and `.is-energy` for a basic Energy shown as the icon of its type. The row overlaps its pictures to fit; `--pv-card-w` and `--pv-card-h` set their size. A design that places the bench itself places it there too: `.pile-view { position: absolute; left: 8px; top: 464px; width: 424px; height: 554px; }`.

### What is not allowed, and why

| Not allowed | Why |
|-------------|-----|
| `@import` and `@namespace`; `url()` with a web address, a `data:` address or anything but one of the design's files; `image-set()`, `cross-fade()`, `image()`, `element()`, `paint()` and `src()` | A design can only use the files it carries, so it works offline and never makes an overlay contact anyone's server |
| `!important`, and a transition of `display` (`allow-discrete`, in `transition` or `transition-behavior`) | Either could show what the producer switched off (a transition that is running wins over `!important`) |
| Rules for `body`, `head`, `style`, `script`, `link`, `meta`, `title` or `iframe`; anything but custom properties in a rule for `:root` or `html` alone; a pseudo-element of the page (`:root::before`); `#stage + ...` and `#stage ~ ...` | Only the stage can be styled, and the page around it must stay see-through |
| A rule inside another rule (CSS nesting) | Write each rule on its own |
| `:has()` | It can make the overlay slow |
| `:link`, `:visited`, `:any-link`, `:target` and the like | The overlay has no links |
| `behavior` and `-moz-binding` | They could run code |
| `@charset` | A style sheet is always read as UTF-8 |
| Anything else that is not in the lists of [the package format](PACKAGE-FORMAT.md#stylescss-the-style-sheet) (`@property`, `@page`, `::backdrop`, `:host`...) | A design can use what is listed there, which has the exact rules |

**What the checks do not stop: a slow overlay.** A style sheet that is allowed can still be heavy to draw. A few `drop-shadow()` or `blur()` filters stacked on many pieces, with an animation that redraws them, can make the overlay slow or stop it drawing at all, and so can an SVG picture of the design with stacked filters and an animation in it. Keep filters few and small, and check the design in OBS. Install designs only from people you trust. If a design makes the overlay slow, choose another design (or the classic look) in the Look tab, then refresh the browser source in OBS.

### Pictures for the style sheet

Besides the pictures of the slots, a design can have up to **24 pictures of its own** for its style sheet, each with a name you choose: `css-` and then up to 32 lowercase letters, digits and dashes, starting with a letter or a digit (`css-texture`, `css-ko-burst`). Each is a file like the other pictures, `images/css-texture.png` (PNG, JPG, GIF, WebP or SVG), up to 4.5 MB, checked by what is inside it and counted in the 40 MB of the design. In the editor they are under **Pictures for the style sheet**, on the **Style sheet** tab.

Use one in either of two ways:

- **`var(--css-texture)`.** OTO sets a custom property for each picture of the design, with its name: `--css-texture`, and `--logoImage`, `--backgroundImage`, `--spaceFrame1`... for the pictures of the slots. It works whatever kind of file the picture is. Give it a fallback in case the picture is missing (`var(--css-texture, none)`): a `var()` with nothing behind it makes the whole declaration void, and the piece loses its built-in background too.
- **`url(images/css-texture.png)`**: the file as it is in the design folder. OTO keeps each file under the type it really is (a `.png` that is really a JPEG becomes `css-texture.jpg`), and finds it by its name whatever type you write. The pictures of the slots work too (`url(images/logoImage.png)`). A file the design does not have is left out, with its declaration. Nothing else can be named: no web address, no `data:`, no `..`, nothing after a `?` or a `#`.

```css
.scoreboard { background: var(--css-texture, none) center / cover, var(--bg-panel); }
```

`@font-face` can use the design's own font files the same way (`src: url(fonts/names.woff2) format("woff2")`), and `local()` for a font installed on the computer.

### The moments

When something happens in the match, the overlay puts a class on the piece it happened to, for as long as a moment lasts, and then takes it away. A rule for that class is an animation that plays each time:

```css
.mon.moment-damage .art { animation: shake 0.4s ease-out; }
@keyframes shake { 25% { transform: translateX(-8px); } 75% { transform: translateX(8px); } }
```

| Class | On | When | Extra |
|-------|----|------|-------|
| `moment-damage` | `.mon`, the tile of a Pokémon (the Active one or one on the bench) | The same Pokémon took damage (not when its maximum HP changed in the same change) | `data-damage` and `--moment-damage`: how much |
| `moment-heal` | `.mon` | The same Pokémon was healed (not when its maximum HP changed in the same change) | `data-heal` and `--moment-heal`: how much |
| `moment-ko` | `.mon` | The Pokémon left the table in the same change as the opponent took prize cards | See *Knock outs* below |
| `moment-enter` | `.mon` | A Pokémon came into the slot: put in play, moved there from another slot, or another Pokémon in its place (not an evolution, a going back or a switch) | |
| `moment-switch` | `.mon` | The Active Pokémon and a benched one changed places (both tiles) | |
| `moment-evolve`, `moment-devolve` | `.mon` | The Pokémon evolved, or went back a stage | |
| `moment-energy` | `.mon` | Energy was attached (basic or Special) | `data-energy` and `--moment-energy`: how many |
| `moment-tool` | `.mon` | A Pokémon Tool was attached | |
| `moment-status` | `.mon` | A special condition came | `data-status`: which one (`asleep`, `burned`, `confused`, `paralyzed`, `poisoned` or `trapped`) |
| `moment-ability` | `.mon` | An ability was marked used | |
| `moment-taken` | `.prize` | Each prize card that was just taken | |
| `moment-turn` | `.trainer` | That trainer's turn started | |
| `moment-used` | `.token` | A turn counter or a marker was used: energy, Stadium, Supporter, GX or VSTAR | The counters of what is used each turn are hidden for the trainer who does not have the turn (`.token.off-turn`), so theirs shows only for the trainer who has it; **Try a moment** plays it on the GX or VSTAR marker for the other one |
| `moment-enter` | `.stadium` | A Stadium came into play, where there was none or another one | |
| `moment-point` | `.sb-wins` | That trainer won a game (the games won, on the scoreboard) | |
| `moment-lock` | `.lock` | That lock was switched on (`data-lock` says which: `item` or `evolution`) | |
| `moment-unlock` | `.lock` | That lock was switched off | With a rule for `moment-unlock` in the style sheet, the lock stays until the moment is over, and goes then (as a knocked out Pokémon does) |

**On the stage too.** Each moment also puts its kind and side on the stage, for an effect over the whole overlay: `moment-damage-a`, `moment-ko-b`, `moment-taken-a`, `moment-turn-b`... The side is the trainer the piece belongs to, `a` for Trainer A and `b` for Trainer B: when Trainer A's Active Pokémon is knocked out, the stage gets `moment-ko-a` and `moment-taken-b` (Trainer B took a prize card). For a Stadium it is the trainer who played it (their Stadium play was used), or else the one whose turn it is.

**How long.** A moment lasts 1.5 seconds, unless the style sheet says otherwise with `--oto-moment-ms` in a rule for `:root` (or for one kind of moment, `--oto-moment-<kind>-ms`: `--oto-moment-lock-ms: 3000` makes a lock that is switched on say so for three seconds while the other moments keep theirs): a number of milliseconds (`1200`), or with its unit (`1200ms`, `1.2s`), from 200 to 10000 (a number outside is brought to the nearest end). OTO reads it each time moments start. Written as a plain number, it can time your animations too: `animation: fade calc(var(--oto-moment-ms) * 1ms)`. A moment that happens again on the same piece before it is over starts again from the beginning (its class is taken away and put back, which starts a CSS animation over) and lasts its whole time again.

**The numbers.** Each numbered moment writes its number under its own name, as an attribute of the tile and a custom property on it: `data-damage` and `--moment-damage` (how much damage), `data-heal` and `--moment-heal` (how much healing), `data-energy` and `--moment-energy` (how many Energy were attached). So a Pokémon that takes damage and gets Energy in the same change shows both numbers. Show one with `content: "-" attr(data-damage)` on the tile itself (`.mon.moment-damage::after`), or, on a piece inside the tile, with a counter, since the custom property reaches it: `counter-reset: amount var(--moment-damage); content: "-" counter(amount);`. Each goes when the moment that wrote it ends. `data-status` names the condition that came: `.mon.moment-status[data-status="poisoned"]`.

**Knock outs.** When your style sheet names `moment-ko` somewhere (a rule for `.mon.moment-ko`, or for `#stage.moment-ko-a` or `#stage.moment-ko-b`; a comment does not count), the tile of a knocked out Pokémon stays on the overlay as it was, with its picture, name and HP, for as long as the moment lasts, and then goes: you can animate it on its way out. A Pokémon that comes into the slot meanwhile takes the tile at once. When another Pokémon takes the slot in the same change (a draft sent with the knock out and the next Active Pokémon), only the stage gets `moment-ko-a` or `moment-ko-b`: the tile shows the newcomer, and plays its `moment-enter`. When the style sheet does not name `moment-ko`, the tile goes at once, as in the classic look; the stage still gets `moment-ko-a` or `moment-ko-b`.

**What plays.** The overlay compares the game before and after each change. A page that just opened or reconnected plays nothing for what happened before, and nothing plays for a game that replaces the whole of the one there: an imported configuration, a full reset, or undoing or redoing one. The game keeps no record of what was done, only how it is now, so undoing something plays its reverse: undoing damage is a heal.

**The producer's switch.** Producers can switch the moments off: Settings, Overlay, *Design animations (damage, knock outs, prizes...)*, which is on to begin with (and each extra overlay can have it its own way). When it is off, the overlay marks no moments: their animations do not play, a knocked out Pokémon goes at once, and the rest of the style sheet stays. **Try a moment** in the editor plays even then, and a knock out tried there does not hide the Pokémon.

**Only for what is shown.** A moment never tells what the producer switched off. Nothing plays on a piece that is switched off, or inside one (the Active Pokémon, the bench, the prize cards, a turn counter or a marker, the Stadium, the scoreboard), and a moment about a part of the tile plays only while that part is shown: `moment-damage` and `moment-heal` (and their numbers) need the HP bars, `moment-status` the status conditions, `moment-energy` the attached energy, `moment-tool` the Pokémon Tools (as cards or by name), `moment-ability` the ability tokens. `moment-turn` needs the turn highlight and `moment-point` the match score. A moment that does not play does not mark the stage either.

### Tips for the style sheet

- **Animate what is inside a piece, not a piece the layout moves.** The pieces you can move in the editor (the logo, the scoreboard, a trainer and its prize cards, turn tokens, locks, Active Pokémon and bench, the feature cards, the Stadium, the banners) keep where the design put them in their `transform`, and the stage keeps its scaling in its own. An animation of `transform` on one of them takes that away while it plays: the piece jumps back to where it was before it was moved, or the stage to its full size. Two moments land on such pieces: `moment-turn` (on `.trainer`) and `moment-enter` (on `.stadium`). Animate a piece inside them (`.trainer.moment-turn .active .art`, `.stadium.moment-enter .stadium-art`), a `::before` or `::after`, or another property. (The built-in shake of a knock out moves the stage with `margin-left`, not `transform`.)
- **Keep animations short.** A moment's class goes when the moment is over (1.5 seconds unless you say otherwise), which cuts an animation that is longer. Several moments often come at once (a knock out comes with a prize card taken), and the same moment can come again and start over.
- **Mind older OBS browsers.** OBS shows the overlay with a browser of its own, which can be older than the one you design in. CSS nesting and `:has()` are refused anyway. Something newer (`@container`, `@starting-style`, `color-mix()`...) may do nothing there: check it in OBS itself, and make sure the design still looks right without it (`@supports` can give it a rule of its own).
- **The producer's choices win.** A piece the producer switched off stays off (that is why `!important` and `allow-discrete` are refused, and the overlay stops any transition on a piece that is switched off), and the moments can be switched off: the design should look right without them.

### A complete example

With a picture for the style sheet named `css-texture`: the scoreboard on that picture; a hit shakes the Pokémon and shows the damage; a knock out fades it (and its tile stays for the moment, since the style sheet names `moment-ko`); a prize card that is taken glows; a game won makes the number jump; and the stage flashes on a knock out. Put it in the **Style sheet** tab, and use **Try a moment** to see each animation.

```css
:root {
  --oto-moment-ms: 1200;
  --hit: #ff4d6d;
}

/* the scoreboard on a picture of the design (none when it has no css-texture) */
.scoreboard { background: var(--css-texture, none) center / cover, var(--bg-panel); }

/* damage: the picture shakes, and the amount rises over it */
.mon.moment-damage .art { animation: shake 0.4s ease-out; }
.mon.moment-damage .art::after {
  counter-reset: amount var(--moment-damage);
  content: "-" counter(amount);
  position: absolute;
  left: 0;
  right: 0;
  top: 35%;
  text-align: center;
  font: 800 56px/1 var(--font-numbers, var(--font-display));
  color: var(--hit);
  text-shadow: 0 2px 8px #000;
  animation: rise calc(var(--oto-moment-ms) * 1ms) ease-out forwards;
}

/* a knock out: the picture goes gray and fades */
.mon.moment-ko .art { animation: fade calc(var(--oto-moment-ms) * 1ms) ease-in forwards; }

/* a prize card that is taken glows */
.prize.moment-taken { animation: glow 0.8s ease-out; }

/* a game won: the number on the scoreboard jumps */
.sb-wins.moment-point { animation: jump 0.6s ease-out; }

/* a knock out on either side: the whole stage flashes */
#stage.moment-ko-a::after,
#stage.moment-ko-b::after {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background: var(--hit);
  opacity: 0;
  animation: flash 0.5s ease-out;
}

@keyframes shake { 25% { transform: translateX(-8px); } 50% { transform: translateX(8px); } 75% { transform: translateX(-4px); } }
@keyframes rise { from { transform: translateY(20px); opacity: 1; } to { transform: translateY(-40px); opacity: 0; } }
@keyframes fade { to { opacity: 0; filter: grayscale(1); } }
@keyframes glow { from { box-shadow: 0 0 20px 6px var(--accent); } }
@keyframes jump { 40% { transform: scale(1.4); } }
@keyframes flash { 30% { opacity: 0.35; } }
```

---

## Several overlays, several designs

One match can feed several overlays at once, each with its own design: for example a wide design for the main stream and a tall mobile design for a phone stream. The producer adds them in Settings, Overlay, **More overlays**: each gets its own address (`/overlay?screen=<name>`) and chooses its design from your installed designs. So you only need to hand over the designs; the producer wires them up.

---

## Sharing: the `.oto` file

A **`.oto` file** puts a design, its sounds and (if you choose) the producer's control settings in one compressed file.

- **Save one:** Look tab, **Save as .oto** (with or without the control settings: what the overlay shows or hides, how long announcements stay, which sounds are on; never an API key or password).
- **Install one:** Look tab, **Install a .oto**, or drop the file on the control panel, or double-click it with the desktop app. You are shown what is inside first (a style sheet too) and choose what to install.
- A `.oto` is an ordinary **ZIP file with another name**, so you can open one to see inside. It can only ever hold pictures, fonts, sounds, settings and a style sheet that is checked before anything is installed, never scripts, and a damaged or tricky file (a style sheet with something not allowed in it too) is refused without installing any of it. A design can still make the overlay slow to draw (see [what the checks do not stop](#what-is-not-allowed-and-why)): install designs from people you trust.

---

## Making a design by hand

You do not need OTO to make a design:

1. Make a folder named after your design.
2. Put in `design.json` (start from [the example](examples/built-in-look/design.json)) and, if you have them, `images/`, `fonts/` and `sounds/` with the file names from [PACKAGE-FORMAT.md](PACKAGE-FORMAT.md), and `styles.css` for [a style sheet](#style-sheet-and-animations). A picture is found by its name (`images/logoImage.png`, or `images/css-texture.png` for a picture for the style sheet), a font by its group (`fonts/names.woff2`), a sound by its moment (`sounds/damage.mp3`), and the style sheet by its name, next to `design.json`.
3. Zip the folder and rename the zip to `.oto`.
4. Install it from Settings, Look, **Install a .oto**. If the style sheet has something that is not allowed, nothing is installed, and the message says on which line.

The Windows built-in zip, PowerShell's `Compress-Archive` and `tar` were all tested.

---

## Tips

- **Test on a full table.** The editor's sample shows a Pokémon with energy, tools, abilities and a condition, a Stadium and feature cards, but a real match has more: look at both a Pokémon with a long name and one with five energy.
- **Keep text readable at stream size.** The overlay is drawn on 1920 × 1080 (or 1080 × 1920) pixels, then OBS scales it.
- **Leave room for the producer's choices.** Producers can hide pieces and switch off the design's animations, so do not make one piece depend on another being visible, nor the look on an animation. More for the style sheet is in [its tips](#tips-for-the-style-sheet).
- **Fonts and licenses.** A font you put in a design is shared with it. Check that its license allows that. The same goes for pictures and sounds ([NOTICE.md](../NOTICE.md)).
- **Do not use Pokémon artwork you do not have the rights to** for your logo or avatars.
