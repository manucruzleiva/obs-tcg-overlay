/**
 * OTO overlay: draws the match on a 1920x1080 stage.
 *
 * It only ever receives data. The server sends the game state (state:full / state:update), one-shot
 * announcements (announce) and a note when the theme changes (theme:changed). Every element carries a
 * data-opt key from the shared catalogue (public/js/display-options.js) so it can be switched off.
 *
 * A design can bring a style sheet of its own (checked before it gets here, see public/js/theme-css.js): it goes
 * in <style id="oto-design-css">, after the built-in sheets. For it to animate what happens in the game, the
 * overlay puts "moments" on the pieces it happened to for a short while (see markMoments): classes such as
 * moment-damage on a Pokémon's tile or moment-taken on a prize card, and moment-damage-a on the stage.
 *
 * Kept to syntax that older OBS browser engines understand.
 */
(function () {
  'use strict';

  const GAME = window.OTO_GAME;
  const DISPLAY = window.OTO_DISPLAY;
  const THEME = window.OTO_THEME;
  const COUNTRIES = window.OTO_COUNTRIES;
  const DECK = window.OTO_DECK;

  const STAGE_WIDTH = 1920;
  const STAGE_HEIGHT = 1080;
  const PRIZE_SLOTS = 6;
  const MAX_BENCH = 8;
  const MAX_ENERGY_SHOWN = 10;
  const MAX_ENERGY_SHOWN_ON_BENCH = 6; // the picture of a bench Pokémon is small
  const MAX_RETREAT_SHOWN = 6;
  const FADE_OUT_MS = 350;

  const SIDES = ['trainerA', 'trainerB'];
  const SIDE_CLASS = { trainerA: 'a', trainerB: 'b' };
  const ENERGY_INDEX = {};
  GAME.ENERGY_KEYS.forEach((key, index) => { ENERGY_INDEX[key] = index; });
  const PER_TURN = ['energy', 'stadiumUse', 'supporter']; // the trackers of what is used once each turn (the GX and VSTAR markers are for the game)
  // each tracker and marker, with the counter of the game it shows
  const TOKENS = [['energy', 'energyPerTurn'], ['stadiumUse', 'stadiumPerTurn'], ['supporter', 'supporterPerTurn'], ['gx', 'gxPerGame'], ['vstar', 'vstarPerGame']];
  // A moment lasts as long as the design's style sheet says (--oto-moment-ms, set in a rule for :root), within these bounds
  const MOMENT_MS = 1500;
  const MOMENT_MIN_MS = 200;
  const MOMENT_MAX_MS = 10000;
  // the moments there are (each is the class moment-<kind>; see markMoments for when each one happens)
  const MOMENT_KINDS = ['damage', 'heal', 'ko', 'enter', 'switch', 'evolve', 'devolve', 'energy', 'tool', 'status', 'ability', 'taken', 'turn', 'used', 'point'];
  const STATUS = {};
  const STATUS_INDEX = {};
  GAME.STATUS_CONDITIONS.forEach((condition, index) => { STATUS[condition.key] = condition; STATUS_INDEX[condition.key] = index; });
  // the status icons whose picture could not be loaded (see checkStatusIcons): a colored disc with a letter is drawn instead
  const MISSING_STATUS_ICON = {};

  // ------------------------------------------------------------------ helpers

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Mark an element as switchable with the given visibility option
  function opt(node, key) {
    node.dataset.opt = key;
    return node;
  }

  // Only touch an image when its address changed, so the card does not flash on every update
  function setImage(img, src, alt) {
    const wanted = src || '';
    if (img.getAttribute('src') !== wanted) {
      if (wanted) img.setAttribute('src', wanted);
      else img.removeAttribute('src');
    }
    img.alt = alt || '';
  }

  function hasPokemon(pokemon) {
    return Boolean(pokemon && (pokemon.cardId || pokemon.name));
  }

  function cssUrl(value) {
    return `url("${String(value).replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
  }

  // ------------------------------------------------------------------ moments

  // Who the Pokémon in a slot is, to tell whether the slot still holds the same one ('' for an empty slot). A Pokémon on the table has no
  // id of its own, so two copies of one card look the same.
  function occupantOf(pokemon) {
    return hasPokemon(pokemon) ? `${pokemon.cardId || ''}|${pokemon.name || ''}` : '';
  }

  function sameCard(a, b) {
    return Boolean(a && b) && (a.cardId || '') === (b.cardId || '') && (a.name || '') === (b.name || '');
  }

  function countOf(list) {
    return Array.isArray(list) ? list.length : 0;
  }

  // Stop a moment that is still playing on a node: its class goes now, and what it was to do at its end is not done
  // (node.moments holds the moments playing on a node, by class, each with its timer)
  function endMoment(node, name) {
    const playing = node.moments && node.moments[name];
    if (playing) {
      clearTimeout(playing.timer);
      delete node.moments[name];
    }
    node.classList.remove(name);
    // the number and the status condition that this moment wrote on the node go with it
    const owners = node.momentOwners || {};
    if (owners.amount === name) {
      delete owners.amount;
      node.removeAttribute('data-amount');
      node.style.removeProperty('--moment-amount');
    }
    if (owners.status === name) {
      delete owners.status;
      node.removeAttribute('data-status');
    }
  }

  function endMoments(node) {
    Object.keys(node.moments || {}).forEach((name) => endMoment(node, name));
  }

  // ------------------------------------------------------------- building blocks

  function createMon(mini) {
    const root = el('div', mini ? 'mon mini' : 'mon');
    const art = el('div', 'art');
    const img = el('img', 'art-img');
    img.decoding = 'async';
    art.appendChild(img);

    // The picture has a band at its top and one at its bottom, each with a place for the HP bar and for a part in each of its
    // corners; placeParts puts the HP bar, the energy and the retreat cost where the design says (or below the picture)
    const bands = {};
    ['top', 'bottom'].forEach((edge) => {
      const band = el('div', `band band-${edge}`);
      const bar = el('div', 'band-bar');
      const corners = el('div', 'band-corners');
      const left = el('div', 'corner corner-left');
      const right = el('div', 'corner corner-right');
      corners.appendChild(left);
      corners.appendChild(right);
      band.appendChild(bar);
      band.appendChild(corners);
      art.appendChild(band);
      bands[edge] = { bar, left, right };
    });

    const details = el('div', 'details');
    const name = opt(el('div', 'mon-name'), 'pokemonNames');
    const hp = opt(el('div', 'hp'), 'hpBars');
    const bar = el('div', 'hp-bar');
    const fill = el('div', 'hp-fill');
    bar.appendChild(fill);
    const hpText = el('div', 'hp-text');
    hp.appendChild(bar);
    hp.appendChild(hpText);
    const energies = opt(el('div', 'energies'), 'attachments');
    const retreat = opt(el('div', 'retreat'), 'retreatCost');
    const abilities = opt(el('div', 'abilities'), 'abilityTokens');
    const attacks = opt(el('div', 'attacks'), 'benchAttacks'); // (the benched Pokémon only)
    const toolCards = opt(el('div', 'tool-cards'), 'toolCards'); // the Pokémon Tools as pictures of their cards
    const tools = opt(el('div', 'tools'), 'toolNames'); // and, when asked for, by name
    const statuses = opt(el('div', 'statuses'), 'statusConditions');
    [name, hp, energies, retreat, abilities, toolCards, tools, attacks, statuses].forEach((node) => details.appendChild(node));

    root.appendChild(art);
    root.appendChild(details);
    root.hidden = true;
    return { root, mini: Boolean(mini), bands, details, img, name, hp, fill, hpText, energies, retreat, abilities, toolCards, tools, attacks, statuses };
  }

  // Where the parts of a tile go: the usual places, with what a design says (a design is checked by the server, this only
  // makes sure that nothing unknown gets through)
  function tileOf(given) {
    const tile = {};
    THEME.TILE_KEYS.forEach((key) => {
      tile[key] = Object.assign({}, THEME.TILE_DEFAULT);
      const entry = given && given[key];
      THEME.TILE_PARTS.forEach((part) => {
        if (entry && part.places.indexOf(entry[part.key]) !== -1) tile[key][part.key] = entry[part.key];
      });
    });
    return tile;
  }

  // Put the HP bar, the attached energy and the retreat cost on the picture (at its top or bottom, or in a corner) or below it
  function placeParts(mon, tile) {
    const bands = mon.bands;
    [bands.top, bands.bottom].forEach((band) => [band.bar, band.left, band.right].forEach((slot) => { slot.textContent = ''; }));
    const below = [];
    const put = (part, node) => {
      const place = tile[part];
      if (place === 'top' || place === 'bottom') bands[place].bar.appendChild(node);
      else if (place === 'below') below.push(node);
      else {
        const corner = place.split('-'); // 'bottom-left' is the bottom band's left corner
        bands[corner[0]][corner[1]].appendChild(node);
      }
    };
    put('hp', mon.hp);
    put('energy', mon.energies);
    if (!mon.mini) put('retreat', mon.retreat); // (the bench does not show the retreat cost)
    // what stays under the picture keeps its order: the name, then whatever came down, then the abilities and the status icons
    mon.details.appendChild(mon.name);
    below.forEach((node) => mon.details.appendChild(node));
    mon.details.appendChild(mon.abilities);
    mon.details.appendChild(mon.toolCards);
    mon.details.appendChild(mon.tools);
    mon.details.appendChild(mon.attacks);
    below.length = 0;
    put('status', mon.statuses);
    below.forEach((node) => mon.details.appendChild(node));
    // on the picture the status icons are drawn as round icons alone; below it they are chips with their names
    mon.statuses.classList.toggle('on-art', tile.status !== 'below');
  }

  // `kind` says what the token is for (its color: a Stadium is green, a Supporter orange); `icon` is a picture that takes its place (the GX attack and
  // the VSTAR Power), which is the pill with its name again when the picture is not there
  function createToken(optionKey, label, { kind = '', icon = '' } = {}) {
    const root = opt(el('div', 'token'), optionKey);
    if (kind) root.dataset.kind = kind;
    const dot = el('span', 'dot');
    const text = el('span', 'token-label', label);
    const count = el('span', 'token-count');
    if (icon) {
      const picture = el('img', 'marker-icon');
      picture.alt = label;
      picture.addEventListener('error', () => root.classList.add('no-icon'));
      picture.addEventListener('load', () => { if (picture.naturalWidth === 0) root.classList.add('no-icon'); });
      picture.src = icon;
      root.appendChild(picture);
    }
    root.appendChild(dot);
    root.appendChild(text);
    root.appendChild(count);
    return { root, count };
  }

  function renderEnergies(container, energies, specials, maxShown) {
    const list = energies || [];
    const cards = specials || [];
    container.textContent = '';
    list.slice(0, maxShown).forEach((type) => {
      const icon = el('span', `energy energy-${type}`);
      icon.style.setProperty('--i', ENERGY_INDEX[type] === undefined ? ENERGY_INDEX.colorless : ENERGY_INDEX[type]);
      icon.title = type;
      container.appendChild(icon);
    });
    if (list.length > maxShown) container.appendChild(el('span', 'energy-more', `+${list.length - maxShown}`));

    // A Special Energy card is a circle cut out of the card, so it can be told apart at a glance
    cards.forEach((card) => {
      const chip = el('span', 'energy energy-special');
      chip.title = card.name || 'Special Energy';
      if (card.image) {
        const img = el('img', 'energy-special-img');
        img.decoding = 'async';
        img.alt = card.name || '';
        img.setAttribute('src', card.image);
        chip.appendChild(img);
      }
      container.appendChild(chip);
    });
    container.hidden = list.length === 0 && cards.length === 0;
  }

  // The retreat cost: that many colorless Energy, crossed out while the Pokémon cannot retreat. Nothing when it costs nothing.
  function renderRetreat(container, cost, blocked) {
    const count = Math.max(0, Math.min(MAX_RETREAT_SHOWN, Number(cost) || 0));
    container.textContent = '';
    for (let i = 0; i < count; i++) {
      const icon = el('span', 'energy energy-colorless');
      icon.style.setProperty('--i', ENERGY_INDEX.colorless);
      container.appendChild(icon);
    }
    container.title = blocked ? "Can't retreat" : `Retreat cost ${count}`;
    container.classList.toggle('blocked', Boolean(blocked) && count > 0);
    container.hidden = count === 0;
  }

  function renderAbilities(container, abilities) {
    const list = abilities || [];
    container.textContent = '';
    list.forEach((ability) => {
      const chip = el('span', ability.used ? 'ability used' : 'ability');
      chip.appendChild(el('span', 'ability-name', ability.name));
      if (ability.used) chip.appendChild(el('span', 'ability-state', 'USED'));
      container.appendChild(chip);
    });
    container.hidden = list.length === 0;
  }

  // The Pokémon Tools on a Pokémon as the pictures of their cards (the part of the card that the crop says). A tool with no picture (put there by
  // hand) is shown by its name. Only drawn again when something about them changed, so the pictures
  // do not flash on every update.
  function renderToolCards(container, tools) {
    const list = Array.isArray(tools) ? tools : [];
    const signature = JSON.stringify(list.map((tool) => [tool.image, tool.name]));
    container.hidden = list.length === 0;
    if (container.dataset.tools === signature) return;
    container.dataset.tools = signature;
    container.textContent = '';
    list.forEach((tool) => {
      const card = el('span', tool.image ? 'tool-card' : 'tool-card plain');
      card.title = tool.name;
      if (tool.image) {
        const img = el('img', 'tool-card-img');
        img.decoding = 'async';
        img.alt = tool.name;
        img.src = tool.image;
        card.appendChild(img);
      } else {
        card.appendChild(el('span', 'tool-card-name', tool.name));
      }
      container.appendChild(card);
    });
  }

  // The Pokémon Tools on a Pokémon by name (not on by default; a design can ask for it)
  function renderTools(container, tools) {
    const list = Array.isArray(tools) ? tools : [];
    container.textContent = '';
    list.forEach((tool) => {
      const chip = el('span', 'tool');
      chip.title = tool.name;
      chip.appendChild(el('span', 'tool-name', tool.name));
      container.appendChild(chip);
    });
    container.hidden = list.length === 0;
  }

  // What a benched Pokémon can do, as the card says: the name of each attack and its damage ("60", "50+", "20×")
  function renderAttacks(container, attacks) {
    const list = attacks || [];
    container.textContent = '';
    list.forEach((attack) => {
      const line = el('div', 'attack-line');
      line.appendChild(el('span', 'attack-line-name', attack.name));
      const amount = attack.damage ? `${attack.damage}${attack.mod || ''}` : attack.mod || '';
      if (amount) line.appendChild(el('span', 'attack-line-damage', amount));
      container.appendChild(line);
    });
    container.hidden = list.length === 0;
  }

  function renderMon(mon, pokemon) {
    const present = hasPokemon(pokemon);
    // A Pokémon that was just knocked out stays on its tile, as it was, until its moment is over (see markMoments). A Pokémon that comes
    // into the slot meanwhile ends that at once: the tile is drawn again for the newcomer.
    if (mon.knockedOut) {
      if (!present) return;
      mon.knockedOut = false;
      endMoments(mon.root);
    }
    mon.root.hidden = !present;
    if (!present) return;

    setImage(mon.img, pokemon.image, pokemon.name);
    mon.name.textContent = pokemon.name || '';

    const max = (pokemon.hp && pokemon.hp.max) || 0;
    const current = (pokemon.hp && pokemon.hp.current) || 0;
    const percent = max ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
    mon.hp.hidden = !max;
    mon.hp.classList.toggle('warn', percent <= 50 && percent > 25);
    mon.hp.classList.toggle('low', percent <= 25);
    mon.fill.style.width = `${percent}%`;
    mon.hpText.textContent = max ? `${current}/${max}` : '';

    const status = pokemon.status || [];
    renderEnergies(mon.energies, pokemon.energies, pokemon.specialEnergies, mon.mini ? MAX_ENERGY_SHOWN_ON_BENCH : MAX_ENERGY_SHOWN);
    // only the Active Pokémon shows what it costs to retreat
    if (mon.mini) {
      mon.retreat.textContent = '';
      mon.retreat.hidden = true;
    } else {
      renderRetreat(mon.retreat, pokemon.retreat, status.indexOf('trapped') !== -1);
    }
    renderAbilities(mon.abilities, pokemon.abilities);
    renderToolCards(mon.toolCards, pokemon.tools);
    renderTools(mon.tools, pokemon.tools);
    renderAttacks(mon.attacks, mon.mini ? pokemon.attacks : []);

    mon.statuses.textContent = '';
    status.forEach((key) => {
      const known = STATUS[key];
      const chip = el('span', 'status-chip');
      chip.dataset.status = String(key);
      // the icon of the status (a design can bring its own strip), then its name
      const icon = el('span', MISSING_STATUS_ICON[key] ? 'status-icon no-icon' : 'status-icon');
      chip.appendChild(icon);
      chip.appendChild(el('span', 'status-label', known ? known.label : String(key)));
      if (known) {
        chip.style.setProperty('--c', known.color);
        chip.style.setProperty('--ink', known.ink);
        chip.title = known.hint ? `${known.label}: ${known.hint}` : known.label;
        icon.style.setProperty('--s', String(STATUS_INDEX[key]));
        icon.style.setProperty('--icon', cssUrl(known.icon));
        icon.dataset.glyph = known.glyph;
      } else {
        icon.hidden = true;
      }
      mon.statuses.appendChild(chip);
    });
    mon.statuses.hidden = status.length === 0;
  }

  // ------------------------------------------------------------------ the overlay

  class Overlay {
    constructor() {
      this.stage = document.getElementById('stage');
      this.frame = document.getElementById('stage-frame'); // (it clips the stage: see fit)
      this.state = null;
      this.themeProps = [];
      this.layoutNodes = []; // the pieces a design has moved
      this.stageSize = { width: STAGE_WIDTH, height: STAGE_HEIGHT }; // a mobile design has a tall one
      this.portrait = false;
      this.themeFonts = []; // the fonts of the design that is on (see applyTheme)
      this.themeGeneration = 0;
      this.toastTimers = {};
      this.effectNodes = [];
      // the style sheet of the design that is on (see applyTheme), after the built-in ones so that it wins when both say something
      this.designCss = document.createElement('style');
      this.designCss.id = 'oto-design-css';
      document.head.appendChild(this.designCss);

      // "editor" is the copy inside the design editor: it draws what the editor sends and talks to no server
      const params = new URLSearchParams(window.location.search);
      this.editor = params.has('editor');
      // one of the screens of this controller (another overlay in OBS, with a design of its own): its id is in the address
      this.screenId = params.get('screen') || '';
      this.screenDesign = null; // the design its settings say, as it was when the design was loaded

      this.build();
      this.tile = tileOf(null);
      this.placeAll();
      this.fit();
      this.checkEnergyIcons();
      this.checkStatusIcons();
      window.addEventListener('resize', () => this.fit());
      if (this.editor) {
        this.listenToEditor();
        return;
      }

      // role "preview" is the small copy inside the control panel: it is not counted as a screen
      const role = params.has('preview') ? 'preview' : 'overlay';
      this.socket = window.io({ auth: { role } });
      // (the whole game is sent when the page connects, and again when it reconnects: it is drawn as it is, and what happened while the
      // page was away is not played as moments)
      this.socket.on('state:full', (state) => this.update(state, { full: true }));
      this.socket.on('state:update', (state) => this.update(state));
      this.socket.on('announce', (announcement) => this.announce(announcement));
      this.socket.on('theme:changed', () => this.loadTheme());
      this.socket.on('decks:changed', () => this.loadDecks());
      this.loadTheme();

      // Sound effects play here so OBS can capture them (the control panel's preview stays silent)
      this.sfx = new window.OTO_SFX.Engine();
      if (role === 'overlay') {
        this.socket.on('sfx', (message) => {
          // (the screens besides the main overlay are silent unless their settings say they play the sounds: two of them would play every sound twice)
          if (this.state && this.playsSound(this.state)) this.sfx.play(message.cue, this.state.settings.sound);
        });
        this.socket.on('sounds:changed', () => this.loadSounds());
        this.loadSounds();
      }
    }

    // ---- screens

    // The settings of this page's screen (null for the main overlay, and for a screen that does not exist any more)
    screenOf(state) {
      if (!this.screenId || !state || !state.settings) return null;
      return (state.settings.screens || []).find((screen) => screen.id === this.screenId) || null;
    }

    // What this page shows or hides: the switches of the overlay, with what the screen says differently
    displayOf(state) {
      const own = (state && state.settings && state.settings.display) || DISPLAY.DEFAULTS;
      const screen = this.screenOf(state);
      return screen ? Object.assign({}, own, screen.display) : own;
    }

    playsSound(state) {
      if (!this.screenId) return true;
      const screen = this.screenOf(state);
      return Boolean(screen && screen.sound === true);
    }

    // The status icons are files in the assets folder too. One that is not there is drawn as a colored disc with a letter.
    checkStatusIcons() {
      GAME.STATUS_CONDITIONS.forEach((condition) => {
        const probe = new Image();
        probe.onerror = () => {
          MISSING_STATUS_ICON[condition.key] = true;
          if (this.state) this.update(this.state);
        };
        probe.src = condition.icon;
      });
    }

    // The energy icons are files in the assets folder. If they are not there (it can be deleted), draw plain colored discs.
    checkEnergyIcons() {
      const probe = new Image();
      probe.onerror = () => document.documentElement.classList.add('no-energy-icons');
      probe.src = GAME.ENERGY_TYPES[0].icon;
    }

    // Learn which cues have an uploaded sound and fetch them
    // The list of the decks that are played the most was read again (Settings, Cards): the pictures of the decks that are named by it follow
    async loadDecks() {
      try {
        const answer = await (await fetch('/api/decks/popular')).json();
        window.OTO_DECK_POPULAR.replace(answer.decks, answer.source);
        if (this.state) this.update(this.state);
      } catch (error) {
        /* the list in the page stays */
      }
    }

    async loadSounds() {
      try {
        const response = await fetch('/api/sounds', { cache: 'no-store' });
        await this.sfx.setCustom((await response.json()).custom);
      } catch (error) {
        // the built-in sounds still work without the uploads
      }
    }

    // ---- structure

    build() {
      const stage = this.stage;

      this.backdrop = el('div', 'backdrop');
      this.logo = el('div', 'logo');
      // the reserved spaces (a design's camera feeds and the like): frames, behind everything else
      this.spacesLayer = opt(el('div', 'spaces'), 'spaces');
      stage.appendChild(this.backdrop);
      stage.appendChild(this.spacesLayer);
      stage.appendChild(this.logo);

      this.buildScoreboard();
      this.trainers = {};
      SIDES.forEach((side) => this.buildTrainer(side));
      this.buildCenter();

      this.toasts = el('div', 'toasts');
      ['a', 'b', 'c'].forEach((slot) => this.toasts.appendChild(el('div', `toast-slot ${slot}`)));
      this.fx = el('div', 'fx-layer');
      stage.appendChild(this.toasts);
      stage.appendChild(this.fx);

      // the banner of a paused game: it stays for as long as the game is paused (see update)
      this.pauseBanner = el('div', 'pause-banner');
      this.pauseBanner.hidden = true;
      this.pauseBanner.appendChild(el('div', 'pause-icon'));
      this.pauseBanner.appendChild(el('div', 'pause-title', 'GAME PAUSED'));
      this.pauseBanner.appendChild(el('div', 'pause-sub', 'Play will resume shortly'));
      stage.appendChild(this.pauseBanner);

      // a design can move and resize these pieces (see public/js/theme-options.js)
      THEME.BLOCKS.forEach((block) => {
        stage.querySelectorAll(block.selector).forEach((node) => node.setAttribute('data-block', block.key));
      });
    }

    buildScoreboard() {
      const board = opt(el('header', 'scoreboard'), 'scoreboard');
      this.board = { root: board, sides: {} };

      SIDES.forEach((side) => {
        const s = SIDE_CLASS[side];
        const root = el('div', `sb-side sb-${s}`);
        const avatar = el('div', 'sb-avatar');
        const who = el('div', 'sb-who');
        const name = opt(el('div', 'sb-name'), 'trainerName');
        const meta = el('div', 'sb-meta');
        const nationality = opt(el('span', 'sb-nat'), 'nationality');
        const record = opt(el('span', 'sb-record'), 'record');
        // the deck: its text, with a picture in front of it when it names a Pokémon or an energy type (that picture can be switched off on its own)
        const deck = opt(el('span', 'sb-deck'), 'deckType');
        const deckIcon = opt(el('img', 'sb-deck-icon'), 'deckIcon');
        deckIcon.alt = '';
        deckIcon.hidden = true;
        // a picture that cannot be had (no internet for a Pokémon that has not been shown before) leaves the text alone
        deckIcon.addEventListener('error', () => { deckIcon.hidden = true; });
        const deckText = el('span', 'sb-deck-text');
        deck.appendChild(deckIcon);
        deck.appendChild(deckText);
        deck.hidden = true;
        meta.appendChild(nationality);
        meta.appendChild(record);
        meta.appendChild(deck);
        who.appendChild(name);
        who.appendChild(meta);
        const wins = opt(el('div', 'sb-wins'), 'matchScore');
        [avatar, who, wins].forEach((node) => root.appendChild(node));
        this.board.sides[side] = { root, name, nationality, record, deck, deckIcon, deckText, wins };
      });

      const center = el('div', 'sb-center');
      this.board.round = opt(el('div', 'sb-round'), 'roundLabel');
      this.board.bestOf = opt(el('div', 'sb-bo'), 'bestOf');
      center.appendChild(this.board.round);
      center.appendChild(this.board.bestOf);

      board.appendChild(this.board.sides.trainerA.root);
      board.appendChild(center);
      board.appendChild(this.board.sides.trainerB.root);
      this.stage.appendChild(board);
    }

    buildTrainer(side) {
      const s = SIDE_CLASS[side];
      const root = el('section', `trainer trainer-${s}`);

      const turnTag = opt(el('div', 'turn-tag', 'TURN'), 'turnIndicator');
      const top = el('div', 't-top');

      const prizes = opt(el('div', 'prizes'), 'prizes');
      const prizeNodes = [];
      for (let i = 0; i < PRIZE_SLOTS; i++) {
        const prize = el('div', 'prize');
        prizeNodes.push(prize);
        prizes.appendChild(prize);
      }
      const prizeFlag = el('div', 'prize-flag');
      prizes.appendChild(prizeFlag);

      const tokens = el('div', 'tokens');
      const energy = createToken('energyCounter', 'ENERGY');
      const stadiumUse = createToken('stadiumCounter', 'STADIUM', { kind: 'stadium' });
      const supporter = createToken('supporterCounter', 'SUPPORTER', { kind: 'supporter' });
      // the GX attack and the VSTAR Power: once per game, and not shown unless the producer asks for them
      const gx = createToken('gxMarker', 'GX', { icon: '/assets/markers/gx' });
      const vstar = createToken('vstarMarker', 'VSTAR', { icon: '/assets/markers/vstar' });
      [gx, vstar].forEach((token) => token.root.classList.add('marker'));
      [energy, stadiumUse, supporter, gx, vstar].forEach((token) => tokens.appendChild(token.root));

      const locks = opt(el('div', 'locks'), 'locks');
      [prizes, tokens, locks].forEach((node) => top.appendChild(node));

      const active = opt(el('div', 'active'), 'activePokemon');
      const activeMon = createMon(false);
      active.appendChild(activeMon.root);

      const bench = opt(el('div', 'bench'), 'benchPokemon');
      const benchMons = [];
      for (let i = 0; i < MAX_BENCH; i++) {
        const mon = createMon(true);
        benchMons.push(mon);
        bench.appendChild(mon.root);
      }

      [turnTag, top, active, bench].forEach((node) => root.appendChild(node));
      this.stage.appendChild(root);
      this.trainers[side] = { root, turnTag, prizes, prizeNodes, prizeFlag, energy, stadiumUse, supporter, gx, vstar, locks, activeMon, benchMons };
    }

    buildCenter() {
      const center = el('div', 'center');
      this.featureBox = opt(el('div', 'features'), 'featureCards');
      // the Stadium: the part of its card that the crop says (the picture, unless a design says otherwise) and its name below
      this.stadiumBox = opt(el('figure', 'stadium'), 'stadium');
      this.stadiumArt = el('div', 'stadium-art');
      this.stadiumImg = el('img', 'stadium-img');
      this.stadiumImg.decoding = 'async';
      this.stadiumArt.appendChild(this.stadiumImg);
      this.stadiumName = el('figcaption', 'stadium-name');
      this.stadiumBox.appendChild(this.stadiumArt);
      this.stadiumBox.appendChild(this.stadiumName);
      center.appendChild(this.featureBox);
      center.appendChild(this.stadiumBox);
      this.stage.appendChild(center);
    }

    // ---- scaling

    fit() {
      // the editor shows the stage at its real size (the editor zooms the whole picture)
      const auto = !this.editor && (!this.state || this.state.settings.autoScale !== false);
      const { width, height } = this.stageSize;
      const scale = auto ? Math.min(window.innerWidth / width, window.innerHeight / height) : 1;
      const x = auto ? (window.innerWidth - width * scale) / 2 : 0;
      const y = auto ? (window.innerHeight - height * scale) / 2 : 0;
      // The frame is the box of the stage on the page, and nothing is drawn outside it: whatever a design does to the stage or to what is
      // in it (a shadow, a piece bigger than the stage, an animation of the stage's transform), the page around it stays see-through
      const frame = this.frame.style;
      frame.left = `${x}px`;
      frame.top = `${y}px`;
      frame.width = `${width * scale}px`;
      frame.height = `${height * scale}px`;
      this.stage.style.transform = `scale(${scale})`;
    }

    // The screen of the design: a wide one (1920 x 1080) or a tall one for a phone (1080 x 1920, with its own arrangement: see #stage.portrait)
    setScreen(orientation) {
      this.portrait = orientation === 'portrait';
      this.stageSize = THEME.stageSizeOf(this.portrait ? 'portrait' : 'landscape');
      this.stage.style.width = `${this.stageSize.width}px`;
      this.stage.style.height = `${this.stageSize.height}px`;
      this.stage.classList.toggle('portrait', this.portrait);
      this.syncBenchRow();
      this.fit();
    }

    // The bench is a row under the Active Pokémon when the producer asks for it, and always on a tall screen (there is no room at the side)
    syncBenchRow() {
      const display = this.displayOf(this.state);
      this.stage.classList.toggle('bench-row', this.portrait || display.benchRow === true);
    }

    // The reserved spaces of the design, as frames: an outline of the shape, or the design's picture for it (spaceFrame<id>)
    renderSpaces(theme) {
      this.spacesLayer.textContent = '';
      const images = (theme && theme.images) || {};
      ((theme && Array.isArray(theme.spaces)) ? theme.spaces : []).forEach((space) => {
        if (!space || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(space[key]))) return;
        const shape = THEME.SPACE_SHAPE_KEYS.includes(space.shape) ? space.shape : 'rect';
        const node = el('div', `space shape-${shape}`);
        node.style.left = `${space.x}px`;
        node.style.top = `${space.y}px`;
        node.style.width = `${space.w}px`;
        node.style.height = `${space.h}px`;
        const frame = images[`spaceFrame${space.id}`];
        if (frame) {
          node.classList.add('has-frame');
          node.style.backgroundImage = cssUrl(frame);
        }
        this.spacesLayer.appendChild(node);
      });
    }

    // ---- the game

    // `full`: the whole game, sent when the page (re)connects (see the constructor)
    update(state, { full = false } = {}) {
      const previous = this.state;
      this.state = state;
      const display = this.displayOf(state);
      // the design this screen wears can be changed from the control panel: the page asks for it again
      if (!this.editor && this.screenId) {
        const wanted = (this.screenOf(state) || {}).design || '';
        if (this.screenDesign !== null && wanted !== this.screenDesign) this.loadTheme(state);
        this.screenDesign = wanted;
      }

      this.stage.style.opacity = String(Math.max(0, Math.min(100, state.settings.overlayOpacity)) / 100);
      if (!previous || previous.settings.autoScale !== state.settings.autoScale) this.fit();

      this.renderScoreboard(state, display);
      SIDES.forEach((side) => this.renderTrainer(side, state, display));
      this.renderCenter(state);

      // A paused game: the banner, and the rest of the overlay grayed out. Unlike a toast it stays until the game is resumed. Banners can
      // be switched off (Settings, Overlay), and then the game is not shown as paused.
      const paused = state.paused === true && state.settings.enablePauseToast !== false && display.toasts !== false;
      this.stage.classList.toggle('is-paused', paused);
      // the bench is stacked at the side unless it is asked to be a row under the Active Pokémon
      this.syncBenchRow();
      this.pauseBanner.hidden = !paused;

      // Switch elements off last, so everything that exists is covered
      this.stage.querySelectorAll('[data-opt]').forEach((node) => {
        node.classList.toggle('opt-off', display[node.dataset.opt] === false);
      });

      // Then what just happened, for the design's style sheet to animate. Not for the first state the page gets, nor for the whole game sent
      // again after a reconnection (everything that happened meanwhile would play at once), nor when the same state is drawn again.
      if (previous && previous !== state && !full && display.moments !== false) this.markMoments(previous, state);
    }

    renderScoreboard(state, display) {
      SIDES.forEach((side) => {
        const trainer = state[side];
        const refs = this.board.sides[side];
        refs.name.textContent = trainer.name;
        // the nationality as typed, or as a flag when the overlay is set to show flags and it names a country (the text stays as the title)
        const flag = display.nationalityFlag === true ? COUNTRIES.flagOf(trainer.nationality) : '';
        refs.nationality.textContent = flag || trainer.nationality;
        refs.nationality.classList.toggle('is-flag', Boolean(flag));
        if (flag) refs.nationality.title = trainer.nationality;
        else refs.nationality.removeAttribute('title');
        refs.nationality.hidden = !trainer.nationality;
        const record = trainer.record || { wins: 0, losses: 0, ties: 0 };
        refs.record.textContent = `${record.wins}-${record.losses}-${record.ties}`;
        this.renderDeck(refs, trainer, display);
        refs.wins.textContent = String(state.matchScore[`${side}Wins`]);
      });
      this.board.round.textContent = (state.matchInfo && state.matchInfo.round) || '';
      this.board.round.hidden = !(state.matchInfo && state.matchInfo.round);
      this.board.bestOf.textContent = state.matchScore.bestOf === 1 ? 'SINGLE GAME' : `BEST OF ${state.matchScore.bestOf}`;
    }

    // The deck of a trainer: its text, and the picture it names (a Pokémon or an energy type), unless the picture box says there is none
    renderDeck(refs, trainer, display) {
      const deck = trainer.deck || '';
      const picture = display.deckIcon === false ? null : DECK.pictureFor(deck, trainer.deckIcon);
      refs.deck.hidden = !deck && !picture;
      refs.deck.classList.toggle('has-icon', Boolean(picture));
      refs.deck.classList.toggle('no-text', !deck);
      refs.deckText.textContent = deck;
      refs.deckText.hidden = !deck;
      if (picture) {
        // only touched when the address changed, so the picture does not flash on every update (or come back after it failed to load)
        if (refs.deckIcon.getAttribute('src') !== picture.src) {
          refs.deckIcon.hidden = false;
          refs.deckIcon.setAttribute('src', picture.src);
        }
        refs.deckIcon.dataset.kind = picture.kind;
        refs.deckIcon.title = picture.name;
      } else {
        refs.deckIcon.hidden = true;
        refs.deckIcon.removeAttribute('src');
        refs.deckIcon.removeAttribute('title');
      }
    }

    renderTrainer(side, state, display) {
      const trainer = state[side];
      const refs = this.trainers[side];

      // turn highlight
      const hasTurn = Boolean(trainer.isTurn) && display.turnIndicator !== false;
      refs.root.classList.toggle('is-turn', hasTurn);
      refs.turnTag.hidden = !hasTurn;

      // prizes: the ones taken fade out. The OTHER trainer's penalty is that many prize cards this one counts as already taken, so that many
      // of the ones still there are marked red
      const opponent = state[side === 'trainerA' ? 'trainerB' : 'trainerA'];
      const penalty = Math.min(Number(opponent.prizes.penalty) || 0, trainer.prizes.count);
      // (the cards chosen for the prizes show on the prize cards, unless the prizes are hidden: then the picture of the card is not given to
      // the prize card at all, so no style sheet can show a card that is face down)
      const faces = trainer.prizes.cards || [];
      const faceDown = Boolean(trainer.prizes.hidden);
      refs.prizeNodes.forEach((node, index) => {
        node.classList.toggle('taken', index >= trainer.prizes.count);
        node.classList.toggle('penalty', index < penalty);
        const face = faces[index] && faces[index].image;
        node.classList.toggle('has-face', Boolean(face));
        if (face && !faceDown) node.style.setProperty('--prize-face', cssUrl(face));
        else node.style.removeProperty('--prize-face');
      });
      refs.prizes.classList.toggle('is-hidden', faceDown);
      refs.prizes.classList.toggle('pulse', penalty > 0 && state.settings.showPenaltyAnimation !== false);
      refs.prizeFlag.textContent = penalty > 0 ? 'PENALTY' : '';

      // once-per-turn tokens, and the once-per-game markers
      TOKENS.forEach(([key, resource]) => {
        const counter = trainer.resources[resource];
        if (!counter) return;
        refs[key].root.classList.toggle('used', counter.used >= counter.available);
        refs[key].count.textContent = counter.available > 1 ? `${counter.used}/${counter.available}` : '';
        // what is used each turn is for the player whose turn it is: the other one (and both, before anybody has the turn) show none
        // (they are not there, but keep their room, so nothing moves when the turn passes)
        if (PER_TURN.indexOf(key) !== -1) refs[key].root.classList.toggle('off-turn', !trainer.isTurn);
      });

      // locks
      refs.locks.textContent = '';
      if (trainer.locks.itemLock) refs.locks.appendChild(el('span', 'lock', 'ITEM LOCK'));
      if (trainer.locks.evoLock) refs.locks.appendChild(el('span', 'lock', 'EVOLUTION LOCK'));
      refs.locks.hidden = !(trainer.locks.itemLock || trainer.locks.evoLock);

      // Pokémon
      renderMon(refs.activeMon, trainer.active);
      refs.benchMons.forEach((mon, index) => {
        renderMon(mon, index < trainer.benchSize ? trainer.bench[index] : null);
      });
    }

    renderCenter(state) {
      const stadium = state.stadium;
      const present = Boolean(stadium && stadium.inPlay && (stadium.image || stadium.name));
      this.stadiumBox.hidden = !present;
      if (present) {
        setImage(this.stadiumImg, stadium.image, stadium.name);
        this.stadiumName.textContent = stadium.name || '';
      }

      // the last three cards that were featured, in the order they were added, with the separators between them ("A + B → C")
      this.featureBox.textContent = '';
      const shown = [];
      let counted = 0;
      for (let i = state.featureCards.length - 1; i >= 0; i--) {
        const entry = state.featureCards[i];
        if (!entry.separator) {
          if (counted === 3) break;
          counted++;
        }
        shown.unshift(entry);
      }
      while (shown.length && shown[0].separator) shown.shift(); // a sign with nothing before it
      this.featureBox.classList.toggle('combo', shown.some((entry) => entry.separator));
      shown.forEach((card) => {
        if (card.separator) {
          this.featureBox.appendChild(el('div', 'feature-sep', card.separator));
          return;
        }
        const figure = el('figure', 'feature');
        const img = el('img', 'feature-img');
        setImage(img, card.image, card.name);
        figure.appendChild(img);
        const caption = el('figcaption', 'feature-caption');
        caption.appendChild(el('div', 'feature-name', card.name));
        figure.appendChild(caption);
        this.featureBox.appendChild(figure);
      });
      this.featureBox.hidden = shown.length === 0;
    }

    // ---- announcements

    announce(announcement) {
      const display = this.displayOf(this.state);
      if (announcement.toast && announcement.toastMs > 0 && display.toasts !== false) this.showToast(announcement);
      if (announcement.animation && announcement.animationMs > 0 && display.animations !== false) this.showEffect(announcement);
    }

    slotFor(side) {
      return side === 'trainerA' ? 'a' : side === 'trainerB' ? 'b' : 'c';
    }

    // Run `show` now, `hide` shortly before the end and `remove` at the end
    schedule(node, durationMs, remove) {
      const timers = [
        setTimeout(() => node.classList.add('out'), Math.max(0, durationMs - FADE_OUT_MS)),
        setTimeout(remove, durationMs)
      ];
      node.cancelTimers = () => timers.forEach(clearTimeout);
    }

    // Take away whatever announcement is still showing in `container`, so a new one never piles up on it
    clearAnnouncements(container) {
      Array.prototype.slice.call(container.querySelectorAll('.toast, .fx')).forEach((old) => {
        if (old.cancelTimers) old.cancelTimers();
        old.remove();
      });
    }

    showToast(announcement) {
      const slotName = this.slotFor(announcement.side);
      const slot = this.toasts.querySelector(`.toast-slot.${slotName}`);

      // only one banner at a time, whichever side it belongs to: a new one removes the last
      this.clearAnnouncements(this.toasts);

      const toast = el('div', `toast toast-${announcement.type}`);
      toast.appendChild(el('div', 'toast-title', announcement.title));
      if (announcement.subtitle) toast.appendChild(el('div', 'toast-sub', announcement.subtitle));
      slot.appendChild(toast);

      // let the browser draw the hidden state first so the slide-in animates
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => toast.classList.add('in')));
      this.schedule(toast, announcement.toastMs, () => toast.remove());
    }

    showEffect(announcement) {
      const fx = el('div', `fx fx-${announcement.type} fx-side-${this.slotFor(announcement.side)}`);
      fx.appendChild(el('div', 'fx-glow'));
      const text = el('div', 'fx-text');
      text.appendChild(el('div', 'fx-title', announcement.title));
      if (announcement.subtitle) text.appendChild(el('div', 'fx-sub', announcement.subtitle));
      fx.appendChild(text);

      if (announcement.type === 'win') {
        for (let i = 0; i < 40; i++) {
          const piece = el('span', 'confetti');
          piece.style.left = `${Math.round(Math.random() * 100)}%`;
          piece.style.animationDelay = `${(Math.random() * 1.6).toFixed(2)}s`;
          piece.style.animationDuration = `${(2.4 + Math.random() * 1.8).toFixed(2)}s`;
          piece.style.background = `hsl(${Math.round(Math.random() * 360)}, 90%, 62%)`;
          fx.appendChild(piece);
        }
      }
      if (announcement.type === 'attack' && announcement.data && announcement.data.damage) {
        fx.appendChild(el('div', 'fx-damage', `-${announcement.data.damage}`));
      }

      // likewise only one full-screen effect at a time
      this.clearAnnouncements(this.fx);
      this.fx.appendChild(fx);
      if (announcement.type === 'ko') {
        this.stage.classList.add('shake');
        setTimeout(() => this.stage.classList.remove('shake'), 700);
      }
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => fx.classList.add('in')));
      this.schedule(fx, announcement.animationMs, () => fx.remove());
    }

    // ---- moments

    // What just happened in the game, found by comparing the state before with the state now, as classes on the pieces it happened to for
    // a short while (see playMoments), so a design's style sheet can animate them:
    //   on a Pokémon's tile (.mon): moment-damage and moment-heal (data-amount and --moment-amount say how much), moment-ko (knocked out),
    //   moment-enter (a Pokémon came into the slot: played, moved there, or another one in its place), moment-switch (the Active Pokémon
    //   and a benched one changed places: both tiles), moment-evolve, moment-devolve, moment-energy (data-amount: how many were attached),
    //   moment-tool, moment-status (data-status: the condition that came) and moment-ability (an ability was used);
    //   moment-taken on each prize card that was just taken, moment-turn on the trainer whose turn it is now, moment-used on a tracker or
    //   a marker that was used, moment-enter on a Stadium that came into play and moment-point on the games won of a trainer.
    // Each also marks the stage with its kind and side (moment-damage-a, moment-taken-b...), for effects over the whole stage.
    // None plays about a piece the producer switched off (see switchedOff): no damage while the HP bars are off, nothing on the bench while
    // it is off...
    // The game keeps no record of what was done, only how it is now: undoing something plays its reverse (undoing damage is a heal).
    markMoments(previous, state) {
      const list = [];
      const left = (trainer) => Math.max(0, Math.min(PRIZE_SLOTS, Number(trainer && trainer.prizes && trainer.prizes.count) || 0));
      SIDES.forEach((side) => {
        const before = previous[side];
        const now = state[side];
        if (!before || !now) return;
        const refs = this.trainers[side];
        const opponent = side === 'trainerA' ? 'trainerB' : 'trainerA';

        // (when the opponent took prize cards in the same change, a Pokémon that left the table was knocked out)
        this.markPokemon(list, side, before, now, left(state[opponent]) < left(previous[opponent]));

        // the prize cards that were just taken, the turn that starts, a tracker or a marker that was used, a game won
        for (let index = left(now); index < left(before); index++) this.queueShown(list, refs.prizeNodes[index], 'taken', side);
        if (now.isTurn && !before.isTurn) this.queueShown(list, refs.root, 'turn', side, {}, refs.turnTag);
        TOKENS.forEach(([key, resource]) => {
          const was = before.resources && before.resources[resource];
          const is = now.resources && now.resources[resource];
          if (was && is && is.used > was.used) this.queueShown(list, refs[key].root, 'used', side);
        });
        const wins = `${side}Wins`;
        if (previous.matchScore && state.matchScore && state.matchScore[wins] > previous.matchScore[wins]) {
          this.queueShown(list, this.board.sides[side].wins, 'point', side);
        }
      });

      // a Stadium that came into play (where there was none, or another one), on the side of the trainer who played it when the game says
      // so (their Stadium play was used), or else of the trainer whose turn it is
      const stadiumOf = (game) => (game.stadium && game.stadium.inPlay && (game.stadium.image || game.stadium.name) ? game.stadium : null);
      const stadium = stadiumOf(state);
      if (stadium && !sameCard(stadiumOf(previous), stadium)) {
        const played = (side) => {
          const was = previous[side] && previous[side].resources && previous[side].resources.stadiumPerTurn;
          const is = state[side] && state[side].resources && state[side].resources.stadiumPerTurn;
          return Boolean(was && is && is.used > was.used);
        };
        const by = SIDES.find(played) || SIDES.find((side) => Boolean(state[side] && state[side].isTurn)) || null;
        this.queueShown(list, this.stadiumBox, 'enter', by);
      }

      this.playMoments(list);
    }

    // Whether what a moment is about is off the overlay: the piece it plays on is in one the producer switched off, or so is every piece
    // that shows what it is about (`shows`: the HP bar for damage, the status icons for a condition...). Such a moment does not play, so
    // that no design can show what the producer hid (the damage, the condition, whose turn it is, a game won).
    switchedOff(node, shows) {
      if (node.closest('.opt-off')) return true;
      const pieces = shows ? [].concat(shows) : [];
      return pieces.length > 0 && pieces.every((piece) => Boolean(piece.closest('.opt-off')));
    }

    // queueMoment, for a moment of the game that is on the overlay (see switchedOff)
    queueShown(list, node, kind, side, extra, shows) {
      if (!this.switchedOff(node, shows)) this.queueMoment(list, node, kind, side, extra);
    }

    // The moments of the Pokémon of one trainer (see markMoments). `prizesTaken`: the opponent took prize cards in the same change.
    markPokemon(list, side, before, now, prizesTaken) {
      const refs = this.trainers[side];
      const tiles = [refs.activeMon].concat(refs.benchMons);
      // what each tile showed and shows now: the Active Pokémon, then the bench (a slot that is not in use shows nothing)
      const shown = (trainer) => [trainer.active].concat(refs.benchMons.map((mon, index) => (index < trainer.benchSize && trainer.bench ? trainer.bench[index] : null)));
      const was = shown(before);
      const is = shown(now);

      // the Pokémon that are in a slot they were not in: a slot that was emptied, and held one of them, saw it move to another slot
      const arrivals = [];
      is.forEach((pokemon, index) => {
        if (hasPokemon(pokemon) && occupantOf(pokemon) !== occupantOf(was[index])) arrivals.push(occupantOf(pokemon));
      });
      // the Active Pokémon and a benched one that changed places (switched in, or dragged onto each other)
      let switched = -1;
      if (hasPokemon(was[0]) && hasPokemon(is[0]) && occupantOf(was[0]) !== occupantOf(is[0])) {
        for (let index = 1; index < is.length && switched === -1; index++) {
          if (occupantOf(is[0]) === occupantOf(was[index]) && occupantOf(is[index]) === occupantOf(was[0])) switched = index;
        }
      }

      tiles.forEach((mon, index) => {
        const old = was[index];
        const pokemon = is[index];
        const node = mon.root;
        if (!hasPokemon(pokemon)) {
          if (!hasPokemon(old)) return;
          const moved = arrivals.indexOf(occupantOf(old));
          if (moved !== -1) arrivals.splice(moved, 1); // (the slot it went to plays)
          else if (prizesTaken) this.markKnockOut(list, mon, side);
          // (a Pokémon taken off the table some other way just goes)
          return;
        }
        // another Pokémon on the tile: what was still playing on it was about the one before (`fresh`)
        if (!hasPokemon(old)) {
          this.queueShown(list, node, 'enter', side, { fresh: true });
          return;
        }
        if (switched !== -1 && (index === 0 || index === switched)) {
          this.queueShown(list, node, 'switch', side, { fresh: true });
          return;
        }
        // an evolution remembers the card it was (the last of its stages), and going back takes that card again
        const oldStages = Array.isArray(old.stages) ? old.stages : [];
        const stages = Array.isArray(pokemon.stages) ? pokemon.stages : [];
        if (stages.length === oldStages.length + 1 && sameCard(stages[stages.length - 1], old)) {
          this.queueShown(list, node, 'evolve', side);
          return;
        }
        if (stages.length === oldStages.length - 1 && sameCard(oldStages[oldStages.length - 1], pokemon)) {
          this.queueShown(list, node, 'devolve', side);
          return;
        }
        if (occupantOf(pokemon) !== occupantOf(old) || stages.length !== oldStages.length) {
          this.queueShown(list, node, 'enter', side, { fresh: true });
          return;
        }

        // the same Pokémon: the damage it took (or was healed of), what was attached to it, a condition that came, an ability used.
        // (A change of its maximum HP is not a hit, even when it leaves the Pokémon short of its full HP: nothing plays for the HP then.)
        const oldHp = old.hp || {};
        const hp = pokemon.hp || {};
        if ((oldHp.max || 0) === (hp.max || 0)) {
          const change = (oldHp.current || 0) - (hp.current || 0);
          if (change > 0) this.queueShown(list, node, 'damage', side, { amount: change }, mon.hp);
          else if (change < 0) this.queueShown(list, node, 'heal', side, { amount: -change }, mon.hp);
        }
        const attached = Math.max(0, countOf(pokemon.energies) - countOf(old.energies)) + Math.max(0, countOf(pokemon.specialEnergies) - countOf(old.specialEnergies));
        if (attached > 0) this.queueShown(list, node, 'energy', side, { amount: attached }, mon.energies);
        if (countOf(pokemon.tools) > countOf(old.tools)) this.queueShown(list, node, 'tool', side, {}, [mon.toolCards, mon.tools]);
        const had = Array.isArray(old.status) ? old.status : [];
        const came = (Array.isArray(pokemon.status) ? pokemon.status : []).filter((key) => had.indexOf(key) === -1);
        if (came.length) this.queueShown(list, node, 'status', side, { status: String(came[came.length - 1]) }, mon.statuses);
        const oldAbilities = Array.isArray(old.abilities) ? old.abilities : [];
        const used = (Array.isArray(pokemon.abilities) ? pokemon.abilities : []).some((ability, i) => Boolean(ability && ability.used
          && oldAbilities[i] && !oldAbilities[i].used && oldAbilities[i].name === ability.name));
        if (used) this.queueShown(list, node, 'ability', side, {}, mon.abilities);
      });
    }

    // A Pokémon that was knocked out. When the design's style sheet animates it (it has a rule for moment-ko), its tile stays as it was,
    // with what it showed, until the moment is over, and goes then (a Pokémon that comes into the slot meanwhile takes it at once: see
    // renderMon). Without such a rule the tile goes at once, as it always has.
    markKnockOut(list, mon, side) {
      if (this.switchedOff(mon.root)) return; // (the Active Pokémon, or the bench, is switched off: the tile goes, and nothing plays)
      const extra = {};
      if (this.designCss.textContent.indexOf('moment-ko') !== -1) {
        mon.root.hidden = false; // (renderMon has just hidden it, and left what it showed)
        mon.knockedOut = true;
        extra.end = () => {
          mon.knockedOut = false;
          mon.root.hidden = true;
        };
      }
      this.queueMoment(list, mon.root, 'ko', side, extra);
    }

    // Add a moment to `list` (see playMoments), with the mark of its kind and side on the stage. One that is in it already is not added twice.
    queueMoment(list, node, kind, side, extra) {
      const put = (target, name, more) => {
        const found = list.find((moment) => moment.node === target && moment.name === name);
        if (found) Object.assign(found, more);
        else list.push(Object.assign({ node: target, name }, more));
      };
      put(node, `moment-${kind}`, extra || {});
      if (SIDE_CLASS[side]) put(this.stage, `moment-${kind}-${SIDE_CLASS[side]}`, {});
    }

    // Play moments: each is { node, name (its class), amount, status, fresh, end }. The class stays on the node for as long as a moment
    // lasts (momentDuration). A moment that is still playing on that node starts again from the beginning and lasts its whole time again:
    // its class is taken away and put back once the page has been laid out without it, which is what starts a CSS animation over.
    // `fresh`: the tile has another Pokémon now, so whatever was still playing on it ends. `end` is done when the moment is over, just
    // before its class goes (so the tile of a knocked out Pokémon is hidden before its animation lets go of it, and does not flash back).
    playMoments(list) {
      if (!list.length) return;
      const ms = this.momentDuration();
      list.forEach((moment) => {
        const playing = moment.node.moments && moment.node.moments[moment.name];
        // (what the one that starts again was to do at its end still has to be done)
        if (playing && playing.end && !moment.end) moment.end = playing.end;
        if (moment.fresh) endMoments(moment.node);
        else endMoment(moment.node, moment.name);
      });
      void this.stage.offsetWidth; // (one layout for all of them)
      list.forEach((moment) => {
        const node = moment.node;
        const owners = node.momentOwners || (node.momentOwners = {});
        if (Number.isFinite(moment.amount)) {
          node.setAttribute('data-amount', String(moment.amount));
          node.style.setProperty('--moment-amount', String(moment.amount));
          owners.amount = moment.name;
        }
        if (moment.status) {
          node.setAttribute('data-status', moment.status);
          owners.status = moment.name;
        }
        node.classList.add(moment.name);
        const playing = { end: moment.end, timer: 0 };
        playing.timer = setTimeout(() => {
          if (playing.end) playing.end();
          endMoment(node, moment.name);
        }, ms);
        (node.moments || (node.moments = {}))[moment.name] = playing;
      });
    }

    // How long a moment lasts, in milliseconds: what the design's style sheet says in --oto-moment-ms (in a rule for :root), else 1.5 seconds
    momentDuration() {
      const value = getComputedStyle(document.documentElement).getPropertyValue('--oto-moment-ms').trim();
      const number = parseFloat(value);
      if (!Number.isFinite(number)) return MOMENT_MS;
      const ms = /[0-9.]s$/i.test(value) ? number * 1000 : number; // (seconds are understood too: "1.2s")
      return Math.max(MOMENT_MIN_MS, Math.min(MOMENT_MAX_MS, ms));
    }

    // Play one moment as if it had happened (the design editor's "Try a moment", and the tests). `moment` is its kind ('damage', 'ko'...:
    // see MOMENT_KINDS), `side` 'a' or 'b', `target` the piece it plays on ('active', 'bench0' to 'bench7', 'prize0' to 'prize5', 'trainer',
    // 'token-energy', 'token-stadium', 'token-supporter', 'token-gx', 'token-vstar', 'stadium' or 'wins') and `amount` the number it is
    // about (the damage, the energy attached), if any. A knock out plays on the tile as it is and does not hide it. It plays even while the
    // design animations are switched off: it is asked for. False when there is no such moment or piece.
    playMoment(moment, side, target, amount) {
      const trainer = side === 'a' || side === 'trainerA' ? 'trainerA' : side === 'b' || side === 'trainerB' ? 'trainerB' : null;
      const node = trainer && MOMENT_KINDS.indexOf(moment) !== -1 ? this.momentNode(trainer, String(target || '')) : null;
      if (!node) return false;
      const extra = {};
      const number = amount === null || amount === undefined || amount === '' ? NaN : Number(amount);
      if (Number.isFinite(number)) extra.amount = Math.round(number);
      if (moment === 'status') {
        // the condition the tile shows last, or the first there is
        const chips = node.querySelectorAll('.status-chip');
        extra.status = chips.length ? chips[chips.length - 1].dataset.status : GAME.STATUS_CONDITIONS[0].key;
      }
      const list = [];
      this.queueMoment(list, node, moment, trainer, extra);
      this.playMoments(list);
      return true;
    }

    // The piece a moment plays on, for playMoment
    momentNode(side, target) {
      const refs = this.trainers[side];
      const bench = /^bench([0-7])$/.exec(target);
      const prize = /^prize([0-5])$/.exec(target);
      if (target === 'active') return refs.activeMon.root;
      if (bench) return refs.benchMons[Number(bench[1])].root;
      if (prize) return refs.prizeNodes[Number(prize[1])];
      const pieces = {
        trainer: refs.root,
        'token-energy': refs.energy.root,
        'token-stadium': refs.stadiumUse.root,
        'token-supporter': refs.supporter.root,
        'token-gx': refs.gx.root,
        'token-vstar': refs.vstar.root,
        stadium: this.stadiumBox,
        wins: this.board.sides[side].wins
      };
      return Object.prototype.hasOwnProperty.call(pieces, target) ? pieces[target] : null;
    }

    // ---- the design editor

    // The editor sends the design being edited, a made-up match, whether to show a banner and a moment to try
    // ({ kind: 'moment', moment, side, target, amount }: see playMoment)
    listenToEditor() {
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        const message = event.data || {};
        if (message.kind === 'design') this.applyTheme(message.theme || null);
        else if (message.kind === 'state') this.update(message.state);
        else if (message.kind === 'banner') this.editorBanner(Boolean(message.show));
        else if (message.kind === 'moment') this.playMoment(message.moment, message.side, message.target, message.amount);
        else return;
        // so the editor can measure the pieces now that they are where they are going to be
        window.parent.postMessage({ kind: 'drawn' }, window.location.origin);
      });
      window.parent.postMessage({ kind: 'ready' }, window.location.origin);
    }

    // A banner that stays, so its place can be chosen
    editorBanner(show) {
      if (show) this.showToast({ type: 'attack', side: 'trainerA', title: 'Thunderbolt', subtitle: 'Ash attacks for 120', toastMs: 24 * 60 * 60 * 1000 });
      else this.clearAnnouncements(this.toasts);
    }

    // Put the parts of every Pokémon's tile where the design says (see placeParts)
    placeAll() {
      SIDES.forEach((side) => {
        const refs = this.trainers[side];
        if (!refs) return;
        placeParts(refs.activeMon, this.tile.active);
        refs.benchMons.forEach((mon) => placeParts(mon, this.tile.bench));
      });
    }

    // Where each piece of the stage is right now, in stage pixels (the editor draws its handles there).
    // A piece that is not showing (switched off, or empty) is null.
    blockRects() {
      const rects = {};
      THEME.BLOCKS.forEach((block) => {
        let box = null;
        this.stage.querySelectorAll(block.selector).forEach((node) => {
          if (node.hidden || node.closest('[hidden]') || node.closest('.opt-off')) return;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          box = box
            ? { left: Math.min(box.left, rect.left), top: Math.min(box.top, rect.top), right: Math.max(box.right, rect.right), bottom: Math.max(box.bottom, rect.bottom) }
            : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
        rects[block.key] = box && { x: box.left, y: box.top, w: box.right - box.left, h: box.bottom - box.top };
      });
      return rects;
    }

    // ---- themes

    async loadTheme() {
      try {
        const response = await fetch(`/api/theme${this.screenId ? `?screen=${encodeURIComponent(this.screenId)}` : ''}`, { cache: 'no-store' });
        const data = await response.json();
        this.applyTheme(data.theme);
      } catch (error) {
        // Without the server the built-in look stays; the page reconnects by itself
      }
    }

    applyTheme(theme) {
      const root = document.documentElement;
      this.themeProps.forEach((name) => root.style.removeProperty(name));
      this.themeProps = [];

      const rootClasses = ['has-logo', 'has-avatar-a', 'has-avatar-b', 'has-energy-sprite', 'has-status-sprite', 'has-backdrop']
        .concat(THEME.PRIZE_KEYS.map((key) => `prize-${key}`), THEME.PRIZE_LAYOUT_KEYS.map((key) => `prize-layout-${key}`));
      rootClasses.forEach((name) => root.classList.remove(name));

      // pieces the last design moved go back to where they belong
      this.layoutNodes.forEach((node) => {
        node.classList.remove('moved');
        ['--lx', '--ly', '--ls'].forEach((name) => node.style.removeProperty(name));
      });
      this.layoutNodes = [];

      this.themeFonts.forEach((face) => document.fonts.delete(face));
      this.themeFonts = [];
      const generation = ++this.themeGeneration; // (a font that arrives after the design has changed again is not for this page any more)

      // the design's style sheet is not emptied here with the rest: it is only written below when it is not the same any more
      const oldCss = this.designCss.textContent;

      // the screen (wide, or a tall one for a phone) and the reserved spaces
      this.setScreen(theme && theme.orientation);
      this.renderSpaces(theme);

      // where the HP bar, the attached energy and the retreat cost go (the usual places when there is no design)
      this.tile = tileOf(theme && theme.tile);
      this.placeAll();

      // the picture on the prize cards: the English card back when the design says nothing (or there is no design), unless the design has a
      // prize card back or a card back picture of its own; a card back or a Poké Ball when it asks. And how the six are laid out.
      const own = Boolean(theme && theme.images && (theme.images.prizeCardBack || theme.images.cardBackImage));
      let style = theme && THEME.PRIZE_KEYS.includes(theme.prizeStyle) ? theme.prizeStyle : THEME.PRIZE_DEFAULT;
      if (style === THEME.PRIZE_DEFAULT) style = own ? THEME.PRIZE_DEFAULT : 'english';
      if (style !== THEME.PRIZE_DEFAULT) root.classList.add(`prize-${style}`);
      if (theme && THEME.PRIZE_LAYOUT_KEYS.includes(theme.prizeLayout) && theme.prizeLayout !== THEME.PRIZE_LAYOUT_DEFAULT) root.classList.add(`prize-layout-${theme.prizeLayout}`);

      // The design's own style sheet (and its animations: see markMoments), as text only. It was checked before it got here: by the server
      // for the overlays, by the design editor for its copy. Written only when it changed: the editor sends the design again at every step
      // of a drag, and writing it again would start every animation over. No design (or one without a style sheet) empties it.
      const css = theme && typeof theme.css === 'string' ? theme.css : '';
      if (css !== oldCss) this.designCss.textContent = css;
      if (!theme) return;

      const set = (name, value) => {
        root.style.setProperty(name, value);
        this.themeProps.push(name);
      };

      Object.keys(theme.colors || {}).forEach((name) => set(name, theme.colors[name]));
      const images = theme.images || {};
      Object.keys(images).forEach((key) => set(`--${key}`, cssUrl(images[key])));

      // layout: move and resize pieces of the overlay
      const layout = theme.layout || {};
      THEME.BLOCKS.forEach((block) => {
        const entry = layout[block.key];
        if (!entry) return;
        this.stage.querySelectorAll(block.selector).forEach((node) => {
          node.style.setProperty('--lx', `${entry.x}px`);
          node.style.setProperty('--ly', `${entry.y}px`);
          node.style.setProperty('--ls', String(entry.scale));
          node.classList.add('moved');
          this.layoutNodes.push(node);
        });
      });

      // crop: the part of the card that shows for the Active Pokémon (ca), the bench (cb), the Stadium (sa), the cards put on the prize
      // cards (cp) and the Pokémon Tools (ct); the artwork unless the design says (the whole card for the prize cards)
      const crop = theme.crop || {};
      [['active', 'ca'], ['bench', 'cb'], ['stadium', 'sa'], ['prize', 'cp'], ['tool', 'ct']].forEach(([which, prefix]) => {
        const rect = crop[which];
        if (!rect) return;
        ['x', 'y', 'w', 'h'].forEach((side) => set(`--${prefix}-${side}`, String(rect[side])));
      });
      // the circle cut out of a Special Energy card: where its middle is on the card, and how wide it is
      if (crop.energy) {
        set('--ex', String(crop.energy.x + crop.energy.w / 2));
        set('--ey', String(crop.energy.y + crop.energy.h / 2));
        set('--ed', String(crop.energy.w));
      }

      if (images.logoImage) root.classList.add('has-logo');
      if (images.trainerAAvatar) root.classList.add('has-avatar-a');
      if (images.trainerBAvatar) root.classList.add('has-avatar-b');
      if (images.energySymbols) root.classList.add('has-energy-sprite');
      if (images.statusSymbols) root.classList.add('has-status-sprite');
      if (images.backgroundImage) root.classList.add('has-backdrop');

      // Fonts: the main one and one for each group of text. A group can have a font file in the design and/or a list of fonts (a CSS font-family)
      // to use; what a group does not have is the main font's (and the main font falls back on the font of the page).
      const files = Object.assign({}, theme.fonts, theme.font ? { display: theme.font } : {});
      const families = theme.fontFamilies || {};
      THEME.FONT_ROLES.forEach((role) => {
        const file = files[role.key];
        const listed = typeof families[role.key] === 'string' ? families[role.key] : '';
        if (!file && !listed) return;
        const fallback = role.key === 'display' ? 'var(--font-body)' : role.key === 'text' || role.key === 'subtitles' ? 'system-ui, sans-serif' : 'var(--font-display)';
        const stack = (face) => [face, listed, fallback].filter(Boolean).join(', ');
        if (!file) {
          set(role.variable, stack(''));
          return;
        }
        const family = role.key === 'display' ? 'OTO Theme' : `OTO Theme ${role.key}`;
        const face = new window.FontFace(family, cssUrl(file));
        face.load().then(() => {
          if (generation !== this.themeGeneration) return;
          document.fonts.add(face);
          this.themeFonts.push(face);
          set(role.variable, stack(`"${family}"`));
        }).catch(() => {
          // a font that fails to load leaves the list of fonts that was named, or the built-in one
          if (generation === this.themeGeneration && listed) set(role.variable, stack(''));
        });
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.oto = new Overlay();
  });
}());
