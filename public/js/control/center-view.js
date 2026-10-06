/**
 * The middle column: the match (score, round, turn), the hype buttons, the table (stadium and
 * feature cards) and the activity feed.
 */
import { h, icon, replace, ago, personColor } from './dom.js';

export class CenterView {
  constructor(app) {
    this.app = app;
    this.root = this.build();
  }

  build() {
    const { app } = this;
    const match = (action, params) => app.act('action:match', { action, ...params });

    // ---- score
    const winner = (side) => {
      const name = h('span', { class: 'win-name' });
      const count = h('span', { class: 'win-count', 'aria-live': 'polite' }, '0');
      const node = h('div', { class: `win-box ${side === 'trainerA' ? 'side-a' : 'side-b'}` },
        name,
        h('div', { class: 'win-row' },
          h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Remove a game win', onclick: () => match(`${side}MatchWinMinus`) }, icon('minus')),
          count,
          h('button', { class: 'round-btn', type: 'button', 'aria-label': 'Add a game win', onclick: () => match(`${side}MatchWinPlus`) }, icon('plus'))));
      return { node, name, count };
    };
    this.wins = { trainerA: winner('trainerA'), trainerB: winner('trainerB') };

    this.bestOf = h('select', { 'aria-label': 'Best of' },
      [1, 3, 5].map((n) => h('option', { value: n }, n === 1 ? 'Single game' : `Best of ${n}`)));
    this.bestOf.addEventListener('change', () => match('setBestOf', { bestOf: Number(this.bestOf.value) }));

    this.round = h('input', { type: 'text', maxlength: 40, placeholder: 'Round or stage (for example Top 8)', 'aria-label': 'Round or stage label' });
    this.round.addEventListener('change', () => { if (this.round.value !== this.round.dataset.shown) match('setRoundLabel', { text: this.round.value }); });
    this.round.addEventListener('keydown', (event) => { if (event.key === 'Enter') this.round.blur(); });

    const score = h('section', { class: 'block match-block' },
      h('div', { class: 'block-title' }, 'Match'),
      h('div', { class: 'score-row' }, this.wins.trainerA.node, this.wins.trainerB.node),
      h('div', { class: 'match-meta' }, this.bestOf, this.round),
      h('div', { class: 'button-row' },
        // the next game of this match: prizes, penalties and the once-per-game markers start again; the score and names stay
        h('button', { class: 'btn primary', type: 'button', title: 'Prize cards and penalties start again, and the GX and VSTAR markers come back. The score and the names stay.', onclick: () => match('nextGame') }, 'Next game'),
        h('button', { class: 'btn', type: 'button', title: 'A whole new match: the score goes back to 0 too', onclick: () => match('startGame') }, 'New match'),
        h('button', { class: 'btn', type: 'button', onclick: () => match('resetMatchScore') }, 'Reset score')));

    // ---- turn
    this.turnLabel = h('span', { class: 'turn-name' }, '');
    const turn = h('section', { class: 'block turn-pass' },
      h('button', { class: 'btn primary big', type: 'button', onclick: () => match('toggleTurn') }, icon('swap'), 'Pass the turn', h('kbd', {}, 'Space')),
      h('p', { class: 'turn-now' }, 'Turn: ', this.turnLabel));

    // ---- hype
    const hype = (label, key, run, cls = '') => h('button', { class: `btn hype ${cls}`, type: 'button', onclick: run }, label, key && h('kbd', {}, key));
    // The pause is a switch: its label says what pressing it does, and it is lit while the game is paused
    this.pauseButton = h('button', { class: 'btn hype amber', type: 'button', 'aria-pressed': 'false', title: 'The overlay shows a PAUSED banner, grayed out, until you resume', onclick: () => app.togglePause() },
      h('span', { class: 'pause-label' }, 'Pause game'), h('kbd', {}, 'Shift+P'));
    const hypeBlock = h('section', { class: 'block hype-block' },
      h('div', { class: 'block-title' }, 'Hype', h('span', { class: 'hint' }, 'Shown on the overlay')),
      h('div', { class: 'hype-grid' },
        hype('Top Deck', 'T', () => app.act('action:toast', { action: 'topDeck', target: app.focus }), 'gold'),
        hype('Attack', 'C', () => app.openAttack(), 'red'),
        hype('Knock out', 'K', () => app.openKO(app.focus), 'red'),
        hype('Pass turn', 'P', () => app.act('action:toast', { action: 'passTurn' }), 'blue'),
        hype('Game start', '', () => app.act('action:toast', { action: 'startGame' }), ''),
        this.pauseButton));

    // ---- table
    this.stadiumArt = h('div', { class: 'stadium-art' });
    this.stadiumName = h('div', { class: 'stadium-name' });
    this.featureList = h('div', { class: 'feature-list' });
    const table = h('section', { class: 'block table-block' },
      h('div', { class: 'block-title' }, 'Table'),
      h('div', { class: 'stadium-row' },
        this.stadiumArt,
        h('div', { class: 'stadium-info' }, this.stadiumName,
          h('div', { class: 'button-row' },
            h('button', { class: 'btn', type: 'button', onclick: () => app.openPicker({ kind: 'stadium' }) }, 'Stadium', h('kbd', {}, 'S')),
            h('button', { class: 'btn', type: 'button', onclick: () => app.act('action:card', { action: 'setStadium', cardId: '', name: '', image: '' }) }, 'Clear')))),
      h('div', { class: 'block-title sub' }, 'Feature cards', h('button', { class: 'btn tiny', type: 'button', onclick: () => app.openPicker({ kind: 'feature' }) }, 'Add')),
      this.featureList);

    // ---- activity
    this.feed = h('ol', { class: 'feed', 'aria-label': 'Recent changes' });
    const activity = h('section', { class: 'block activity-block' },
      h('div', { class: 'block-title' }, 'Activity', h('span', { class: 'hint' }, 'Everything any producer does')),
      this.feed);

    return h('section', { class: 'center-panel' }, score, turn, hypeBlock, table, activity);
  }

  update(state) {
    const { app } = this;
    for (const side of ['trainerA', 'trainerB']) {
      this.wins[side].name.textContent = state[side].name || (side === 'trainerA' ? 'Trainer A' : 'Trainer B');
      this.wins[side].count.textContent = state.matchScore[`${side}Wins`];
    }
    this.bestOf.value = String(state.matchScore.bestOf);

    this.pauseButton.classList.toggle('on', state.paused === true);
    this.pauseButton.setAttribute('aria-pressed', String(state.paused === true));
    this.pauseButton.querySelector('.pause-label').textContent = state.paused === true ? 'Resume game' : 'Pause game';

    const round = (state.matchInfo && state.matchInfo.round) || '';
    this.round.dataset.shown = round;
    if (document.activeElement !== this.round) this.round.value = round;

    const holder = state.trainerA.isTurn ? 'trainerA' : state.trainerB.isTurn ? 'trainerB' : null;
    this.turnLabel.textContent = holder ? state[holder].name : 'nobody yet';
    this.turnLabel.className = `turn-name${holder ? (holder === 'trainerA' ? ' side-a' : ' side-b') : ''}`;

    // stadium
    const stadium = state.stadium;
    const present = Boolean(stadium && stadium.inPlay);
    replace(this.stadiumArt, present && stadium.image ? h('img', { src: stadium.image, alt: '' }) : h('span', { class: 'art-fallback' }, icon('star', 22)));
    this.stadiumName.textContent = present ? stadium.name || 'Stadium in play' : 'No stadium in play';

    // feature cards
    replace(this.featureList, state.featureCards.length === 0
      ? h('p', { class: 'empty' }, 'Nothing featured. Add a card to show it to the audience.')
      : state.featureCards.map((card) => h('div', { class: 'feature-item' },
        h('img', { src: card.image, alt: '', loading: 'lazy' }),
        h('div', { class: 'feature-text' }, h('strong', {}, card.name)),
        h('button', { class: 'round-btn small', type: 'button', 'aria-label': `Remove ${card.name}`, onclick: () => app.act('action:card', { action: 'removeFeatureCard', id: card.id }) }, icon('close', 14)))));
  }

  updateActivity(entries, you) {
    replace(this.feed, entries.length === 0
      ? h('li', { class: 'empty' }, 'Nothing has happened yet.')
      : entries.slice().reverse().slice(0, 40).map((entry) => h('li', { class: `feed-item kind-${entry.kind}` },
        h('span', { class: 'who', style: { color: personColor(entry.by.clientId) } }, entry.by.name, you && entry.by.clientId === you.clientId ? ' (you)' : ''),
        h('span', { class: 'what' }, entry.label),
        h('time', { class: 'when', dateTime: new Date(entry.ts).toISOString() }, ago(entry.ts)))));
  }
}
