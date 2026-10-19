# Championship Blue

A design for a **top-down table camera**: two blue columns, one for each trainer, frame the table, the way big tournament streams do. The middle of the screen stays see-through, so put the camera under the overlay in OBS.

<p align="center"><img src="preview.png" alt="Championship Blue on a sample match" width="720"></p>

**Install it:** Settings, Look, **Install a .oto**, and choose [`../championship-blue.oto`](../championship-blue.oto). Install the control settings too: they switch on the attacks of the benched Pokémon and switch off the turn highlight (see below).

## What is where

| Place | What shows |
|-------|-----------|
| Each column, top | The prize cards, as Poké Balls in a row |
| Under them | The Active Pokémon: its picture with the HP bar and the energy on it, the name and abilities beside it |
| The rest of the column | The bench, one under the other, with the abilities and the attacks (name and damage) |
| Each column, bottom | ENERGY, STADIUM and SUPPORTER: they show only for the trainer whose turn it is, so they also say whose turn it is |
| Top middle | The Stadium, as a thin strip of its picture with its name |
| Bottom middle | The scoreboard: names, country, record, deck, games won and the round |

The HP bar is blue while the Pokémon is healthy, yellow at half its HP or less and orange at a quarter or less.

## Why the turn highlight is off

The turn highlight adds a TURN tag at the top of the trainer's column, which pushes the whole column down while it is that trainer's turn. On a design with a fixed background that would make the pieces jump off their panels at every turn, so the control settings switch it off. A producer can switch it back on (Settings, Overlay); it then glows gold around the Active Pokémon.

## Files

| File | What it is |
|------|-----------|
| `design.json` | Colors, fonts, where every piece goes, the crop of the Stadium |
| `images/backgroundImage.svg` | The two columns (plain shapes, no pictures) |
| `controls.json` | The control settings that go with it |

To change it, edit these files, zip the **contents** of this folder and rename the zip to `.oto` (see [Making a design by hand](../../DESIGNING.md#making-a-design-by-hand)). The layout counts on the bench taking the whole column, so a bench of five Pokémon with long text still fits; if you make the pictures bigger, test it with a full bench.
