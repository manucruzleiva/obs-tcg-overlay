/**
 * OTO overlay: draws the match on a 1920x1080 stage.
 *
 * It only ever receives data. The server sends the game state (state:full / state:update), one-shot
 * announcements (announce) and a note when the theme changes (theme:changed). Every element carries a
 * data-opt key from the shared catalogue (public/js/display-options.js) so it can be switched off.
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
    const statuses = opt(el('div', 'statuses'), 'statusConditions');
    [name, hp, energies, retreat, abilities, statuses].forEach((node) => details.appendChild(node));

    root.appendChild(art);
    root.appendChild(details);
    root.hidden = true;
    return { root, mini: Boolean(mini), bands, details, img, name, hp, fill, hpText, energies, retreat, abilities, statuses };
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
    put('retreat', mon.retreat);
    // what stays under the picture keeps its order: the name, then whatever came down, then the abilities and the status icons
    mon.details.appendChild(mon.name);
    below.forEach((node) => mon.details.appendChild(node));
    mon.details.appendChild(mon.abilities);
    below.length = 0;
    put('status', mon.statuses);
    below.forEach((node) => mon.details.appendChild(node));
    // on the picture the status icons are drawn as round icons alone; below it they are chips with their names
    mon.statuses.classList.toggle('on-art', tile.status !== 'below');
  }

  function createToken(optionKey, label) {
    const root = opt(el('div', 'token'), optionKey);
    const dot = el('span', 'dot');
    const text = el('span', 'token-label', label);
    const count = el('span', 'token-count');
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

  function renderMon(mon, pokemon) {
    const present = hasPokemon(pokemon);
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
    renderRetreat(mon.retreat, pokemon.retreat, status.indexOf('trapped') !== -1);
    renderAbilities(mon.abilities, pokemon.abilities);

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
      this.state = null;
      this.themeProps = [];
      this.layoutNodes = []; // the pieces a design has moved
      this.themeFont = null;
      this.toastTimers = {};
      this.effectNodes = [];

      // "editor" is the copy inside the design editor: it draws what the editor sends and talks to no server
      const params = new URLSearchParams(window.location.search);
      this.editor = params.has('editor');

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
      this.socket.on('state:full', (state) => this.update(state));
      this.socket.on('state:update', (state) => this.update(state));
      this.socket.on('announce', (announcement) => this.announce(announcement));
      this.socket.on('theme:changed', () => this.loadTheme());
      this.loadTheme();

      // Sound effects play here so OBS can capture them (the control panel's preview stays silent)
      this.sfx = new window.OTO_SFX.Engine();
      if (role === 'overlay') {
        this.socket.on('sfx', (message) => {
          if (this.state) this.sfx.play(message.cue, this.state.settings.sound);
        });
        this.socket.on('sounds:changed', () => this.loadSounds());
        this.loadSounds();
      }
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
      stage.appendChild(this.backdrop);
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
      const stadiumUse = createToken('stadiumCounter', 'STADIUM');
      const supporter = createToken('supporterCounter', 'SUPPORTER');
      // the GX attack and the VSTAR Power: once per game, and not shown unless the producer asks for them
      const gx = createToken('gxMarker', 'GX');
      const vstar = createToken('vstarMarker', 'VSTAR');
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
      const scale = auto ? Math.min(window.innerWidth / STAGE_WIDTH, window.innerHeight / STAGE_HEIGHT) : 1;
      const x = auto ? (window.innerWidth - STAGE_WIDTH * scale) / 2 : 0;
      const y = auto ? (window.innerHeight - STAGE_HEIGHT * scale) / 2 : 0;
      this.stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }

    // ---- the game

    update(state) {
      const previous = this.state;
      this.state = state;
      const display = (state.settings && state.settings.display) || DISPLAY.DEFAULTS;

      this.stage.style.opacity = String(Math.max(0, Math.min(100, state.settings.overlayOpacity)) / 100);
      if (!previous || previous.settings.autoScale !== state.settings.autoScale) this.fit();

      this.renderScoreboard(state, display);
      SIDES.forEach((side) => this.renderTrainer(side, state, display));
      this.renderCenter(state);

      // A paused game: the banner, and the rest of the overlay grayed out. Unlike a toast it stays until the game is resumed. Banners can
      // be switched off (Settings, Overlay), and then the game is not shown as paused.
      const paused = state.paused === true && state.settings.enablePauseToast !== false && display.toasts !== false;
      this.stage.classList.toggle('is-paused', paused);
      this.pauseBanner.hidden = !paused;

      // Switch elements off last, so everything that exists is covered
      this.stage.querySelectorAll('[data-opt]').forEach((node) => {
        node.classList.toggle('opt-off', display[node.dataset.opt] === false);
      });
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
      // (the cards chosen for the prizes show on the prize cards, unless the prizes are hidden)
      const faces = trainer.prizes.cards || [];
      refs.prizeNodes.forEach((node, index) => {
        node.classList.toggle('taken', index >= trainer.prizes.count);
        node.classList.toggle('penalty', index < penalty);
        const face = faces[index] && faces[index].image;
        node.classList.toggle('has-face', Boolean(face));
        if (face) node.style.setProperty('--prize-face', cssUrl(face));
        else node.style.removeProperty('--prize-face');
      });
      refs.prizes.classList.toggle('is-hidden', Boolean(trainer.prizes.hidden));
      refs.prizes.classList.toggle('pulse', penalty > 0 && state.settings.showPenaltyAnimation !== false);
      refs.prizeFlag.textContent = penalty > 0 ? 'PENALTY' : '';

      // once-per-turn tokens, and the once-per-game markers
      [['energy', 'energyPerTurn'], ['stadiumUse', 'stadiumPerTurn'], ['supporter', 'supporterPerTurn'], ['gx', 'gxPerGame'], ['vstar', 'vstarPerGame']].forEach(([key, resource]) => {
        const counter = trainer.resources[resource];
        if (!counter) return;
        refs[key].root.classList.toggle('used', counter.used >= counter.available);
        refs[key].count.textContent = counter.available > 1 ? `${counter.used}/${counter.available}` : '';
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

      this.featureBox.textContent = '';
      state.featureCards.slice(0, 3).forEach((card) => {
        const figure = el('figure', 'feature');
        const img = el('img', 'feature-img');
        setImage(img, card.image, card.name);
        figure.appendChild(img);
        const caption = el('figcaption', 'feature-caption');
        caption.appendChild(el('div', 'feature-name', card.name));
        figure.appendChild(caption);
        this.featureBox.appendChild(figure);
      });
      this.featureBox.hidden = state.featureCards.length === 0;
    }

    // ---- announcements

    announce(announcement) {
      const display = (this.state && this.state.settings.display) || DISPLAY.DEFAULTS;
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

    // ---- the design editor

    // The editor sends the design being edited, a made-up match and whether to show a banner
    listenToEditor() {
      window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        const message = event.data || {};
        if (message.kind === 'design') this.applyTheme(message.theme || null);
        else if (message.kind === 'state') this.update(message.state);
        else if (message.kind === 'banner') this.editorBanner(Boolean(message.show));
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
        const response = await fetch('/api/theme', { cache: 'no-store' });
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
        .concat(THEME.PRIZE_KEYS.map((key) => `prize-${key}`));
      rootClasses.forEach((name) => root.classList.remove(name));

      // pieces the last design moved go back to where they belong
      this.layoutNodes.forEach((node) => {
        node.classList.remove('moved');
        ['--lx', '--ly', '--ls'].forEach((name) => node.style.removeProperty(name));
      });
      this.layoutNodes = [];

      if (this.themeFont) {
        document.fonts.delete(this.themeFont);
        this.themeFont = null;
      }

      // where the HP bar, the attached energy and the retreat cost go (the usual places when there is no design)
      this.tile = tileOf(theme && theme.tile);
      this.placeAll();
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

      // crop: the part of the card that shows for the Active Pokémon (ca), the bench (cb) and the Stadium (sa); the artwork unless the design says
      const crop = theme.crop || {};
      [['active', 'ca'], ['bench', 'cb'], ['stadium', 'sa']].forEach(([which, prefix]) => {
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
      // the picture on the prize cards: a card back or a ball when the design asks for one (the CSS draws it), its own look otherwise
      if (THEME.PRIZE_KEYS.includes(theme.prizeStyle) && theme.prizeStyle !== THEME.PRIZE_DEFAULT) root.classList.add(`prize-${theme.prizeStyle}`);

      if (theme.font) {
        const face = new window.FontFace('OTO Theme', cssUrl(theme.font));
        face.load().then(() => {
          document.fonts.add(face);
          this.themeFont = face;
          set('--font-display', '"OTO Theme", var(--font-body)');
        }).catch(() => { /* a font that fails to load leaves the built-in one */ });
      }
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    window.oto = new Overlay();
  });
}());
