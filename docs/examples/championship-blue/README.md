# Championship Blue

A design for a **top-down table camera**: two blue columns, one for each trainer, frame the table, the way big tournament streams do. The middle of the screen stays see-through, so put the camera under the overlay in OBS.

<p align="center"><img src="preview.png" alt="Championship Blue on a sample match" width="720"></p>

**Install it:** Settings, Look, **Install a .oto**, and choose [`../championship-blue.oto`](../championship-blue.oto). Install the control settings too: they switch on the attacks of the benched Pokémon and switch off the turn highlight (see below).

## What is where

Each column is a medium blue frame with navy cards stacked inside it, and a light bar on the side that faces the table.

| Place | What shows |
|-------|-----------|
| Each column, top | The prize cards in a row, face down: a navy card with a white Poké Ball. A taken prize fades out. A light-blue PRIZES tag sits beside them |
| The ACTIVE card | The Active Pokémon: its picture with the HP bar, the energy and the retreat cost on it, the name and abilities beside it |
| The BENCH card | The bench, one under the other, with the abilities and the attacks (name and damage). The card is navy at the top and turns lighter blue at the bottom, where the bench is usually empty, with a Poké Ball outline there |
| Each column, bottom | ENERGY, STADIUM and SUPPORTER, in a navy tray between two white lines. They show only for the trainer whose turn it is, so they also say whose turn it is |
| Top middle | The Stadium, as a thin strip of its picture with its name, in a tab that hangs from the top edge. With no Stadium in play the tab shows an empty window with a faint Poké Ball and the word STADIUM |
| Bottom middle | The scoreboard, in a tab that rises from the bottom edge: names, country, record, deck, games won and the round |

The HP bar is blue while the Pokémon is healthy, yellow at half its HP or less and orange at a quarter or less. The scores are white.

## Colors

The colors are taken from the stream frames that inspired the design:

| Part | Color |
|------|-------|
| Column frame | Medium blue, `#0a609e` at the top to `#004a7c` at the bottom, with a light rim |
| Cards | Dark navy, `#03196a` to `#010f4f`, with a thin light-blue border |
| Bottom of the bench card | `#01538a` with a `#6cb9ec` border, the color of the empty bench places on the original stream |
| PRIZES, ACTIVE and BENCH | Light-blue bars, `#80b6ec` to `#4785cf`, with white letters |
| Light bar | A white core, a cyan glow (`#86e0fa`) and a blue glow (`#3aa6ef`) |

Two colors in `design.json` are gradients rather than plain colors. `--bg-panel` (the scoreboard, the box of the prize cards, the turn tokens, the Stadium's name) is a navy gradient that is lighter at the top. `--bg-card` (the attack lines and the ability pills) runs from dark navy to a lighter navy, so the lines stand out on the navy cards.

## Why the turn highlight is off

The turn highlight adds a TURN tag at the top of the trainer's column, which pushes the whole column down while it is that trainer's turn. On a design with a fixed background that would make the pieces jump off their cards at every turn, so the control settings switch it off. A producer can switch it back on (Settings, Overlay); it then glows white around the Active Pokémon.

## Long and short names

The right column's Active Pokémon is as wide as its name, so its picture moves a little sideways with the length of the name. The layout leaves room for that: with a name of five letters or more, the picture and the name stay inside the ACTIVE card, and a long name wraps onto two lines. A name of four letters or less puts the picture a few pixels over the edge of the card, on the blue frame. This is also why the pictures sit a little in from the outer edge of the cards.

## Files

| File | What it is |
|------|-----------|
| `design.json` | Colors, fonts, where every piece goes, where the HP bar, energy, retreat cost and status sit on the pictures, the crop of the Stadium |
| `images/backgroundImage.svg` | The two columns with their cards, the light bars and the two tabs in the middle, drawn as shapes. The words PRIZES, ACTIVE, BENCH and STADIUM are drawn as outlines, so they look the same on every PC whatever fonts it has |
| `images/prizeCardBack.svg` | The back of the prize cards |
| `controls.json` | The control settings that go with it |

To change it, edit these files, zip the **contents** of this folder and rename the zip to `.oto` (see [Making a design by hand](../../DESIGNING.md#making-a-design-by-hand)). The cards in the background are drawn where the layout puts the pieces, so if you move or resize a piece in `design.json`, move its card in `backgroundImage.svg` too. The bench card holds a whole bench, so a bench of five Pokémon with long text still fits; if you make the pictures bigger, test it with a full bench.
