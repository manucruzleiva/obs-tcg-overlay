# OTO for streamers and producers

This guide is for the people who run a match: store organizers, casters, producers, players who stream their own games. No code, no terminal. If you are an artist, read the [design guide](DESIGNING.md) instead; if you want to build or change OTO, read the [developer guide](DEVELOPING.md).

**Contents:** [Start in five minutes](#start-in-five-minutes) · [Run a match](#run-a-match) · [The Pokémon](#the-pokémon) · [Prizes, victory and pause](#prizes-victory-and-pause) · [Stadium and feature cards](#stadium-and-feature-cards) · [Producing together](#producing-together) · [What the audience sees](#what-the-audience-sees) · [More than one overlay](#more-than-one-overlay) · [Card library and working offline](#card-library-and-working-offline) · [Installing, repairing, updating and removing](#installing-repairing-updating-and-removing) · [Troubleshooting](#troubleshooting) · [Roadmap](#roadmap)

---

## Start in five minutes

1. **Download** the installer (`OTO-Setup-x.y.z.exe`) from the [Releases](https://github.com/manucruzleiva/obs-tcg-overlay/releases) page and run it. If you would rather not install anything, the portable file (`OTO-x.y.z-portable.exe`) works from any folder or USB stick, but it does not update itself and starts slowly (up to a minute the first time).
2. **Allow it through Windows.** The first run may show *"Windows protected your PC"* because OTO is not code-signed yet: click **More info, then Run anyway**. If the Windows Firewall asks, choose **Private networks**, so a phone or tablet on your network can reach OTO.
3. **Add the overlay to OBS.** Under *Sources* click **+**, choose **Browser** and set:
   - **URL:** `http://localhost:6767/overlay`
   - **Width / Height:** `1920` / `1080`
   - Untick **Shutdown source when not visible**, so the overlay keeps its state when you change scenes.
   - For [sound effects](#sound-effects), tick **Control audio via OBS**.
4. **Open the control panel** (it opens by itself; the tray icon near the clock can open it again), type the trainers' names, and play.

If OBS runs on a different computer than OTO, use OTO's network address instead of `localhost` (see [Producing together](#producing-together)).

How it works, in one picture: OTO runs on one computer and offers two pages. The **control panel** is where producers click; the **overlay** is the transparent graphic OBS shows. Whatever happens in the control panel appears on the overlay instantly. Nothing is uploaded: it all stays on your network.

---

## Run a match

Set the trainers' names and nationalities, pick their decks and Pokémon, and keep the score as the game goes. Everything has a button, and the things you do all game have a key. **Press `?` in the control panel to see the list.** Shortcuts are ignored while you type in a box.

| Key | What it does |
|-----|--------------|
| `Space` | Pass the turn |
| `1` / `2` | The keys below apply to Trainer A / Trainer B (the choice follows whoever has the turn on its own) |
| `↑` / `↓` | The player whose turn it is gives back / takes a prize card. With `Shift`, the player who does not have the turn |
| `A` | Deploy a new Active Pokémon (search a card, or bring one up from the bench) |
| `B` | Edit the bench. `Shift` + `B` puts it back to 5 slots when a Stadium that made it bigger is gone |
| `D` / `H` | Damage / heal: choose the Pokémon (one or several) and the amount |
| `M` | **Move damage** from one Pokémon to another, whichever trainer they belong to |
| `E` | Attach energy (it counts as the turn's attachment, or switch that off for a special attachment) |
| `K` | **Knock out**: pick one Pokémon or several, and how many prizes the opponent takes |
| `S` | Put a Stadium in play. `Shift` + `S`: a Supporter was played this turn |
| `X` | Ability tokens: mark an ability used |
| `I` / `V` | Item lock / Evolution lock on or off |
| `C` | Announce an attack |
| `T` | Announce a Top Deck |
| `P` | **Pause** the game, or resume it |
| `Ctrl` + `Z` | Undo |
| `Ctrl` + `Y` (or `Ctrl` + `Shift` + `Z`) | Redo |
| `Shift` + `Enter` | Turn **draft mode** on or off |
| `Ctrl` + `Enter` | Send the draft to the overlay (draft mode stays on) |
| `Esc` | Close a dialog |

Other things that make a match easier:

- **Preview** shows the overlay inside the control panel. **Shift + click on Preview opens the overlay in a browser tab** instead.
- **Autosave:** if OTO closes unexpectedly, the match is back when you open it again.
- **Activity feed and history:** every change is listed with the name of whoever made it, and undo and redo say what they did.
- **Deck or GLC type:** under each trainer's name, write the deck (`Charizard ex`, `Lightning GLC`, `Mega Lucario`). Suggestions start with the most played decks of the moment (a snapshot of [Limitless TCG](https://limitlesstcg.com/decks)), then energy types and every Pokémon. The overlay shows the deck next to the record, with a picture: the Pokémon the name mentions or the icon of its energy type. Use the **Picture** box to pick another one (`Gardevoir` for a deck called `Control`) or `none`. The line under the boxes says what will show.
- **Nationality:** type a code (`USA`, `JP`) or a country name (`Chile`). With *Nationality as a flag emoji* on, the overlay shows the flag.

---

## The Pokémon

### Active and bench

Pick a Pokémon with `A` (Active) or `B` (bench) and search for the card. HP, abilities, attacks and the retreat cost come from the card. Each Pokémon card in the control panel is compact and has small buttons (hover for the names): **Switch in** (or **Deploy another** for the Active Pokémon), **Evolve**, **Go back a stage**, **Tool**, **Energy**, **Damage**, **Heal**, **Abilities**, **Knock out**, **Remove**.

- **Fossils and Dolls.** An Item card that is played as a Pokémon (a Fossil, a Pokémon Doll, the Snorlax Doll) is found in the same picker: choose **Fossil or Doll (an Item)** at the top, or type `fossil` or `doll`. It is placed as a Basic Pokémon with 60 HP.
- **Evolve and go back.** **Evolve** opens a search of the cards that evolve from this Pokémon. The new card keeps the energy, the tools and the damage taken; as the rules say, its special conditions are cured. **Go back a stage** (a de-evolution) puts the earlier card back at once when OTO saw the Pokémon evolve, and otherwise asks you to search for it; it keeps everything the same way. Both work on the Active Pokémon and on the bench.
- **Tools.** **Tool** attaches a Pokémon Tool to any Pokémon, Active or benched, and the overlay shows it. If the tool says "+50 HP", write 50 in *Adds to the maximum HP*: that Pokémon has the extra HP while the tool is on it, and loses it when you click the tool chip to take it off.
- **Maximum HP.** The `−` and `+` beside the maximum HP raise or lower it by 10 (the damage it has taken stays), and clicking the HP number sets both values by hand.
- **Energy.** Click an energy chip to remove it; **right-click** one to attach another of the same kind. Special Energy cards go on with *Add a Special Energy card*.
- **Special conditions** (Asleep, Burned, Confused, Paralyzed, Poisoned, Trapped) are chips on the Active Pokémon and show as icons on the overlay. A condition ends when the Pokémon leaves the Active spot.
- **Abilities** show as tokens, ready or used. A once-per-turn ability is ready again when its trainer's turn begins; a once-per-game one stays used. The **GX** and **VSTAR** markers appear in the control panel only when the overlay is set to show them.
- **Drag and drop.** Drag a Pokémon onto an empty slot to move it, or onto another Pokémon to swap places.

### Damage, healing and moving damage

- `D` (damage) and `H` (heal) choose one or several Pokémon of one trainer and an amount in tens.
- `M` **moves damage**: choose the Pokémon to take it from (it is healed) and the Pokémon to put it on (it is damaged by the same amount), either of them on either side: your bench to your Active, an enemy Pokémon to your own, and the reverse. A Pokémon can only give away the damage it has taken.
- **Attack announcements** (`C`) list the attacks of the Active Pokémon. Pick one, or press its number, and its name and damage are filled in. If the damage on the card says **`×`**, you are asked how many times; if it says **`+`**, how much more (in tens); `−` works the same way. The damage can always be changed by hand, and you can leave it off the Pokémon. A list that is closed until you open it holds the attacks of the benched Pokémon, for an attack that is copied from the bench.

### Knock outs and a lost board

- `K` opens a list of Pokémon of both trainers. Tick **one or several** (a double or triple knock out) and give how many prizes each is worth: the overlay announces it (*DOUBLE KO!*), clears the slots and offers the next Active Pokémon.
- A player who has **no Pokémon left on the table** after a knock out or after one is removed from the board **loses at once**: the other player gets the victory.

---

## Prizes, victory and pause

- **Prize cards** are taken with `↓` for the player whose turn it is (`↑` gives one back). `Shift` is for the other player. The prize cards start **face down** at the beginning of each game; switch **Hide prizes** off to turn them face up.
- **Set prizes** opens the six prize cards of a player: choose the card of each with the search. The overlay then shows those cards where the prize cards are, and the small pips in the control panel show them too.
- **Penalties** are set on the player who got one: that many of the **other** player's prize cards show in red, and that player needs that many fewer to win.
- **Victory comes by itself.** When a player has taken the prize cards they need (all of them, or all but the other player's penalty) the victory banner shows and that player gets a game win. **Next game** starts the next one (prizes and penalties start again, the GX and VSTAR markers come back, the score and names stay). **New match** starts over with the score at 0.
- **Winner** (in the Hype box) shows the victory banner for the player whose turn it is. It is only the banner: the game and the score do not change.
- **Pause** (`P`) puts a PAUSED banner in the middle of the overlay and grays out the rest until you resume.

---

## Stadium and feature cards

- **Stadium** (`S`): putting one in play uses the Stadium play of the player who played it (the one whose turn it is unless you choose the other). Turn the switch in the picker off for a correction, or for a Stadium an effect put there. The control panel shows just the art of the card; Settings, General, can show the whole card instead (a choice of that browser only).
- **Feature cards** let you show something to the audience during commentary. The overlay shows the last three, in the order they are in, and **Between cards** adds a sign (`+`, `→`, `=` or `or`) to explain a combo: *Boss's Orders + Ultra Ball → …*. **Drag a card or a sign to put it where you want it** in the row. A sign is removed like a card.

---

## Producing together

Often the person running the game is not at the streaming PC. They can use their own laptop, tablet or phone on **the same network** (the same Wi-Fi or router).

### Sharing the link

- The top of the control panel shows a link such as `http://192.168.1.20:6767/control`. Click it to copy and send it to the other producer.
- Or right-click the tray icon and choose **Copy Control Link for Other Devices**. Settings, General, lists every address.
- The same address works for the overlay if OBS runs on another computer: replace `/control` with `/overlay`.

### Working at the same time is safe

- **Pages stay in sync**, live, and you see who is connected at the top.
- **A click is never counted twice.** If someone changed the same thing a moment before you click, your click is refused with a short message ("Maya just changed this") so a prize card is not taken twice. Look at the new value and click again if you still need to.
- **Undo and redo are shared**, and the activity feed says who did what.
- **Your name:** double-click your own name in the list at the top to change it.

### Draft mode

**Draft mode** (`Shift` + `Enter`, or the button at the top) lets the team prepare changes without the overlay showing them: for example the setup before a game starts. There is **one draft for the whole table**: every producer's page goes into it, sees the same preview and the same list of changes (with the name of who made each).

- Any of you can **Send to overlay** (`Ctrl` + `Enter`): all the changes apply at once, as a single step you can undo. **Draft mode stays on** after a send, with an empty draft, until someone turns it off (`Shift` + `Enter` again, or *Leave draft mode*).
- If something changed the same things meanwhile, you are shown what clashes and can send only the rest, send everything anyway, or keep editing.
- **Undo** takes a sent draft back in one step; **redo** reopens the draft with the changes that were sent, in case somebody wants to change something before it goes again.

### The host

The **host** is the person on the computer that runs OTO. Only the host:

- can **rename other producers** (double-click a name at the top) and **remove** them (the small button on a name). A removed producer cannot come back for an hour, unless the host chooses **Let N removed back in** first.
- can set, change or remove the **control panel password** from the tray icon (below).

### Password

Right-click the tray icon, **Control panel password**, **Set a password…** (or *Change* / *Remove*). It can be any text, with no rules. Everyone has to sign in once after that, on every device; the overlay for OBS never needs it. The password is stored scrambled, never as typed, and wrong guesses are slowed down. You can also set one in Settings, General.

- To set it before the app starts, use the `OTO_PASSWORD` environment variable (it wins over the app and cannot be changed there).
- **Forgot it?** Quit OTO and start it once with the environment variable `OTO_RESET_PASSWORD=1`. The password is removed and you can choose a new one. (Whoever can start OTO on the computer can already read its files, so this gives nothing away.)

### Good to know

- Without a password, anyone on the network who has the link can control your overlay. Share it only with people you trust, avoid open public Wi-Fi, and set a password on shared networks. To accept only the local computer, start with `HOST=127.0.0.1`.
- Guest Wi-Fi networks often stop devices from talking to each other. If the link does not open, see [Troubleshooting](#troubleshooting).

---

## What the audience sees

### Show and hide

Settings, **Overlay**, has a switch for every piece: the scoreboard, match score, round label, names, nationality, record, deck and its picture, prize cards, counters, lock badges, the Active Pokémon and bench, Pokémon names, HP bars, attached energy and tools, retreat cost, ability tokens, status conditions, the Stadium, feature cards, banners and full-screen animations. Hide the GX or VSTAR marker here and it disappears from the control panel too. Two presets help: **Show everything** and **Minimal** (score, names, the Active Pokémon and HP). The bench is stacked down the edge of the screen by default; a switch puts it in a row. **Attacks of the benched Pokémon** are off until you switch them on.

The same tab has a table of announcements (start of game, victory, Top Deck, attack, pass turn, knock out, pause): each can show a **banner**, a **full-screen effect**, or both, and you set how long they stay (1 to 30 seconds). The **All** column and the **All moments** row switch whole rows and columns at once. A new announcement replaces the one still showing; the pause banner stays until you resume.

### Sound effects

Settings, **Sounds**. Sounds play from the overlay, so OBS picks them up as browser source audio. They are **off until you switch them on**, because a surprise noise on a live stream is worse than none.

- Each moment has its own switch and volume: deploying, benching, damage, heal, knock out, passing the turn, energy, an ability, a Stadium, a prize, winning a game or the match, an attack, a Top Deck. Every moment has a built-in sound.
- **Use my own** gives a moment your own MP3, WAV, OGG, M4A or WebM file (up to 1.5 MB), and a [design](DESIGNING.md) can bring its own. Yours wins over the design's, which wins over the built-in one. **Test** plays any of them.
- To put sounds on their own audio track in OBS, tick **Control audio via OBS** on the browser source.

### The look

The **Look** tab changes colors, pictures, fonts and the position of everything. You can install a design made by an artist (a `.oto` file: drop it on the control panel or double-click it) or make your own: see the [design guide](DESIGNING.md).

---

## More than one overlay

Streaming to a wide screen and a phone at the same time? Settings, **Overlay**, **More overlays**, **Add an overlay** (up to three more besides the main one). Every overlay shows the same match, and each has:

- **an address of its own** (`/overlay?screen=vertical`) to put in its own OBS browser source (a tall mobile design wants 1080 × 1920);
- **a design of its own**, or the same as the main overlay;
- **its own switches**: *What it shows* lists every piece as the same as the main overlay, shown or hidden;
- **a sound switch**. The main overlay plays the sound effects; leave the others silent, or every sound plays twice.

---

## Card library and working offline

Searching for cards normally asks an online service, which can be slow, rate-limited or unreachable at a venue with poor Wi-Fi. Settings, **Cards**, keeps a copy of the cards you need on your computer:

| Library | What is in it |
|---------|---------------|
| **Standard** | The current rotation and basic Energy |
| **Gym Leader Challenge** | Every Expanded-legal card except Pokémon with a rule box (ex, V, VMAX, VSTAR, GX and the like) |
| **Expanded** | Every Expanded-legal card. A big download (around 15,000 cards): you are asked first |

- **Download** runs in the background with a progress bar, and **you can keep producing** while it runs. If the card service fails halfway, it carries on from where it stopped.
- **Update** brings only what is new: it asks how many cards each part of the library has now, skips the parts that did not change and downloads only the new cards. After a rotation, the cards that left the format go. It says how it went ("Standard is up to date: 3,291 cards. 12 new.").
- Pick one library to **search**. Searching it is instant and works with no internet, and a card it does not have is looked up online.
- **Card pictures** are saved the first time they are shown, so a card shown once still shows offline. You can also **save the pictures ahead of time** and delete them again.
- **The picker** starts from your favorite cards, then the ones you use most and the ones saved on this computer. Click the star on a card, or **right-click the card**, to make it a favorite or take it off.
- **Which service answers.** *Automatic* asks the Pokémon TCG API and, when it does not answer, [TCGdex](https://tcgdex.dev/) (no account, many languages). You can pick one on purpose, or use **Scrydex** with your own account (the keys are kept on your computer, always shown masked, and never go into an exported file or a `.oto`). A free key from [pokemontcg.io](https://pokemontcg.io/) raises the request limits.

---

## Installing, repairing, updating and removing

**The installer** installs OTO for your user account. Run it again while OTO is installed and it first asks what you want:

- **Repair:** put the program files back (and update them if the installer is newer). Your matches, designs, sounds and settings stay.
- **Reinstall from scratch:** as Repair, and OTO starts with empty data. What you had is **moved into a backup folder, not deleted**.
- **Uninstall:** remove OTO. At the end it asks whether to also delete what OTO saved; the answer it starts with is No.
- **Destroy:** remove OTO **and delete everything it saved**: matches, designs, sounds, card libraries, pictures, settings and logs. It asks once to be sure, and it cannot be undone.

If OTO is running, the installer **closes it the polite way**: OTO is asked to save the match and quit, and is only ended by force if it does not finish in about fifteen seconds. For scripts: `OTO-Setup.exe /S` repairs silently, `OTO-Setup.exe /S --mode=reinstall` starts fresh, and `"Uninstall OTO.exe" /S --destroy` removes everything.

**Updates.** The installed version checks GitHub for a newer release shortly after it starts and every few hours. A new version downloads in the background and is **never installed while you are live**: it applies the next time you quit, or at once if you choose **Restart to update** in the tray menu. The portable version does not update itself. Set `OBS_TCG_DISABLE_UPDATES=1` to turn the check off.

**The tray icon** keeps OTO running when you close the window (Settings, General). Right-click it for:

- Open the control panel or the overlay, and copy the control link for other devices
- **Control panel password:** set, change or remove it
- **Troubleshooting:** restart the service, open the data or logs folder, or **Back up and start fresh**
- Update actions and **Quit**

**Where is my data?** In `%APPDATA%\obs-tcg-overlay\`: `data` holds the match database, designs, sounds, card libraries and pictures, and `logs` holds the logs. Set `OTO_DATA_DIR` to keep everything somewhere else, a USB stick for example.

---

## Troubleshooting

**The overlay is blank in OBS.** Make sure OTO is running (look for the tray icon), the URL is exactly `http://localhost:6767/overlay`, and open that address in a normal browser to check. Another program may be using port 6767.

**The producer's device cannot open the link.**
- Both devices must be on the same network. Guest Wi-Fi often blocks devices from talking to each other.
- Allow OTO through Windows Firewall for **Private networks** (Windows Security, Firewall & network protection, *Allow an app through firewall*).
- Check that the link starts with this computer's current address. It can change if the router restarts; the top of the control panel always shows the current one.
- If you started OTO with `HOST=127.0.0.1`, it only accepts connections from the same computer.

**There is no sound.** Sound effects are off until you switch them on (Settings, Sounds). In OBS the browser source must not be muted. Use **Test** next to a sound to hear it from the control panel.

**Card search shows nothing.** Searching online needs an internet connection and the card service, which is sometimes slow or down. Keep a [card library](#card-library-and-working-offline) to be independent of it.

**Windows warns me when I run it.** OTO is not code-signed yet, so SmartScreen asks for confirmation. Choose **More info, then Run anyway**.

**I was removed by the host.** Ask them to choose **Let N removed back in** at the top of the control panel.

**I forgot the password.** See [Password](#password).

**Something is badly wrong.** Tray, **Troubleshooting**, **Back up and start fresh**, or run the installer again and choose **Repair**. If you really want to start from nothing, choose **Destroy**.

---

## Roadmap

These are plans, not promises. Ideas and pull requests are welcome.

### Version 2: the overlay understands the cards

Today the producer types every number in by hand. Version 2 would teach the overlay what the cards in play do, so the board keeps itself up to date: a Tool that adds HP raises the maximum HP by itself, a Stadium that changes the retreat cost changes it on the overlay, and anything the automation gets wrong can be corrected by hand. It would also add a discard pile display and card counters (hand, deck, discard) for each trainer, and a vertical overlay for players who record their own matches. (Several overlays and the mobile screen are already here; the cards logic and the counters are not.)
