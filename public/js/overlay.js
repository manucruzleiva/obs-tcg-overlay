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

  const STAGE_WIDTH = 1920;
  const STAGE_HEIGHT = 1080;
  const PRIZE_SLOTS = 6;
  const MAX_BENCH = 8;
  const MAX_ENERGY_SHOWN = 10;
  const FADE_OUT_MS = 350;

  const SIDES = ['trainerA', 'trainerB'];
  const SIDE_CLASS = { trainerA: 'a', trainerB: 'b' };
  const ENERGY_INDEX = {};
  GAME.ENERGY_KEYS.forEach((key, index) => { ENERGY_INDEX[key] = index; });

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
    const abilities = opt(el('div', 'abilities'), 'abilityTokens');
    const statuses = opt(el('div', 'statuses'), 'statusConditions');
    [name, hp, energies, abilities, statuses].forEach((node) => details.appendChild(node));

    root.appendChild(art);
    root.appendChild(details);
    root.hidden = true;
    return { root, img, name, hp, fill, hpText, energies, abilities, statuses };
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

  function renderEnergies(container, energies) {
    const list = energies || [];
    container.textContent = '';
    list.slice(0, MAX_ENERGY_SHOWN).forEach((type) => {
      const icon = el('span', `energy energy-${type}`);
      icon.style.setProperty('--i', ENERGY_INDEX[type] === undefined ? ENERGY_INDEX.colorless : ENERGY_INDEX[type]);
      icon.title = type;
      container.appendChild(icon);
    });
    if (list.length > MAX_ENERGY_SHOWN) container.appendChild(el('span', 'energy-more', `+${list.length - MAX_ENERGY_SHOWN}`));
    container.hidden = list.length === 0;
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

    renderEnergies(mon.energies, pokemon.energies);
    renderAbilities(mon.abilities, pokemon.abilities);

    const status = pokemon.status || [];
    mon.statuses.textContent = '';
    status.forEach((condition) => mon.statuses.appendChild(el('span', 'status-chip', String(condition))));
    mon.statuses.hidden = status.length === 0;
  }

  // ------------------------------------------------------------------ the overlay

  class Overlay {
    constructor() {
      this.stage = document.getElementById('stage');
      this.state = null;
      this.themeProps = [];
      this.themeFont = null;
      this.toastTimers = {};
      this.effectNodes = [];

      this.build();
      this.fit();
      this.checkEnergyIcons();
      window.addEventListener('resize', () => this.fit());

      // role "preview" is the small copy inside the control panel: it is not counted as a screen
      const role = new URLSearchParams(window.location.search).has('preview') ? 'preview' : 'overlay';
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
        meta.appendChild(nationality);
        meta.appendChild(record);
        who.appendChild(name);
        who.appendChild(meta);
        const wins = opt(el('div', 'sb-wins'), 'matchScore');
        [avatar, who, wins].forEach((node) => root.appendChild(node));
        this.board.sides[side] = { root, name, nationality, record, wins };
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
      [energy, stadiumUse, supporter].forEach((token) => tokens.appendChild(token.root));

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
      this.trainers[side] = { root, turnTag, prizes, prizeNodes, prizeFlag, energy, stadiumUse, supporter, locks, activeMon, benchMons };
    }

    buildCenter() {
      const center = el('div', 'center');
      this.featureBox = opt(el('div', 'features'), 'featureCards');
      this.stadiumBox = opt(el('figure', 'stadium'), 'stadium');
      this.stadiumImg = el('img', 'stadium-img');
      this.stadiumImg.decoding = 'async';
      this.stadiumName = el('figcaption', 'stadium-name');
      this.stadiumBox.appendChild(this.stadiumImg);
      this.stadiumBox.appendChild(this.stadiumName);
      center.appendChild(this.featureBox);
      center.appendChild(this.stadiumBox);
      this.stage.appendChild(center);
    }

    // ---- scaling

    fit() {
      const auto = !this.state || this.state.settings.autoScale !== false;
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

      this.renderScoreboard(state);
      SIDES.forEach((side) => this.renderTrainer(side, state, display));
      this.renderCenter(state);

      // Switch elements off last, so everything that exists is covered
      this.stage.querySelectorAll('[data-opt]').forEach((node) => {
        node.classList.toggle('opt-off', display[node.dataset.opt] === false);
      });
    }

    renderScoreboard(state) {
      SIDES.forEach((side) => {
        const trainer = state[side];
        const refs = this.board.sides[side];
        refs.name.textContent = trainer.name;
        refs.nationality.textContent = trainer.nationality;
        refs.nationality.hidden = !trainer.nationality;
        const record = trainer.record || { wins: 0, losses: 0, ties: 0 };
        refs.record.textContent = `${record.wins}-${record.losses}-${record.ties}`;
        refs.wins.textContent = String(state.matchScore[`${side}Wins`]);
      });
      this.board.round.textContent = (state.matchInfo && state.matchInfo.round) || '';
      this.board.round.hidden = !(state.matchInfo && state.matchInfo.round);
      this.board.bestOf.textContent = state.matchScore.bestOf === 1 ? 'SINGLE GAME' : `BEST OF ${state.matchScore.bestOf}`;
    }

    renderTrainer(side, state, display) {
      const trainer = state[side];
      const refs = this.trainers[side];

      // turn highlight
      const hasTurn = Boolean(trainer.isTurn) && display.turnIndicator !== false;
      refs.root.classList.toggle('is-turn', hasTurn);
      refs.turnTag.hidden = !hasTurn;

      // prizes: the ones taken fade out, and a penalty marks that many of the ones still there in red
      const penalty = Math.min(Number(trainer.prizes.penalty) || 0, trainer.prizes.count);
      refs.prizeNodes.forEach((node, index) => {
        node.classList.toggle('taken', index >= trainer.prizes.count);
        node.classList.toggle('penalty', index < penalty);
      });
      refs.prizes.classList.toggle('is-hidden', Boolean(trainer.prizes.hidden));
      refs.prizes.classList.toggle('pulse', penalty > 0 && state.settings.showPenaltyAnimation !== false);
      refs.prizeFlag.textContent = penalty > 0 ? 'PENALTY' : '';

      // once-per-turn tokens
      [['energy', 'energyPerTurn'], ['stadiumUse', 'stadiumPerTurn'], ['supporter', 'supporterPerTurn']].forEach(([key, resource]) => {
        const counter = trainer.resources[resource];
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
        if (card.note) caption.appendChild(el('div', 'feature-note', card.note));
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

      const rootClasses = ['has-logo', 'has-avatar-a', 'has-avatar-b', 'has-energy-sprite', 'has-backdrop'];
      rootClasses.forEach((name) => root.classList.remove(name));

      if (this.themeFont) {
        document.fonts.delete(this.themeFont);
        this.themeFont = null;
      }
      if (!theme) return;

      const set = (name, value) => {
        root.style.setProperty(name, value);
        this.themeProps.push(name);
      };

      Object.keys(theme.colors || {}).forEach((name) => set(name, theme.colors[name]));
      const images = theme.images || {};
      Object.keys(images).forEach((key) => set(`--${key}`, cssUrl(images[key])));

      if (images.logoImage) root.classList.add('has-logo');
      if (images.trainerAAvatar) root.classList.add('has-avatar-a');
      if (images.trainerBAvatar) root.classList.add('has-avatar-b');
      if (images.energySymbols) root.classList.add('has-energy-sprite');
      if (images.backgroundImage) root.classList.add('has-backdrop');

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
