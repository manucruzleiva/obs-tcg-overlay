/**
 * Announcements: the "hype" moments shown on the overlay (Top Deck, KO, Win, ...).
 *
 * They are one-shot events sent to the overlay, never part of the saved game state,
 * so reloading the overlay or restarting the app does not replay old ones.
 *
 * Each announcement can appear as a small banner (toast), a full-screen effect
 * (animation), or both, depending on the settings. How long each stays on screen is
 * also a setting (toastSeconds, animationSeconds).
 */

const SIDE_LABEL = { trainerA: 'Trainer A', trainerB: 'Trainer B' };

const sideOf = (value, fallback = 'trainerA') => (value === 'trainerB' ? 'trainerB' : value === 'trainerA' ? 'trainerA' : fallback);
const nameOf = (state, side) => state[side].name || SIDE_LABEL[side];

// Returns { type, side, title, subtitle, toast, animation, toastMs, animationMs, data } or null when both are switched off
function build(state, type, params = {}) {
  const s = state.settings;
  let spec;

  switch (type) {
    case 'startgame':
      spec = {
        side: null,
        title: 'GAME START',
        subtitle: 'Good luck to both trainers!',
        toast: s.enableStartGameToast,
        animation: s.enableStartGameAnimation
      };
      break;

    case 'topdeck': {
      const side = sideOf(params.target);
      spec = {
        side,
        title: 'TOP DECK!',
        subtitle: `${nameOf(state, side)} draws exactly what they need`,
        toast: s.enableTopDeckToast,
        animation: s.enableTopDeckAnimation
      };
      break;
    }

    case 'attack': {
      const source = params.source ? sideOf(params.source) : state.trainerA.isTurn ? 'trainerA' : 'trainerB';
      const target = source === 'trainerA' ? 'trainerB' : 'trainerA';
      const damage = Number(params.damage) || 0;
      // An ability is announced the same way (same switches), with its name and no damage; it belongs to the
      // trainer who uses it, an attack to the one who is attacked
      const ability = params.ability === true;
      spec = {
        side: ability ? source : target,
        title: params.attackName || (ability ? 'ABILITY!' : 'ATTACK!'),
        subtitle: ability ? 'ABILITY USED' : damage ? `${damage} damage` : '',
        toast: s.enableAttackToast,
        animation: s.enableAttackAnimation,
        data: { source, target, damage: ability ? 0 : damage, ability }
      };
      break;
    }

    case 'passturn': {
      const to = state.trainerA.isTurn ? 'trainerA' : 'trainerB';
      spec = {
        side: to,
        title: 'TURN PASSED',
        subtitle: `${nameOf(state, to)}'s turn`,
        toast: s.enablePassTurnToast,
        animation: s.enablePassTurnAnimation
      };
      break;
    }

    // Several Pokémon were knocked out at once (of one trainer, or of both): one banner for all of them
    case 'ko': if (params.count > 1) {
      const names = (Array.isArray(params.names) ? params.names : []).filter((name) => typeof name === 'string').slice(0, 6);
      const sides = [...new Set((Array.isArray(params.sides) ? params.sides : []).map((entry) => sideOf(entry)))];
      const both = sides.length > 1;
      const label = sides[0] === 'trainerB' ? 'B' : 'A';
      const count = Math.min(Number(params.count), 16);
      const title = count === 2 ? 'DOUBLE KO!' : count === 3 ? 'TRIPLE KO!' : `${count} KNOCKED OUT!`;
      const inCombat = Boolean(params.inCombat);
      const on = (kind) => (both ? s.enableTrainerAKOToast || s.enableTrainerBKOToast : s[`enableTrainer${label}KO${kind}`]);
      spec = {
        side: both ? null : sides[0],
        title,
        subtitle: names.join(' · ') || (inCombat ? 'In combat' : 'Out of combat'),
        toast: inCombat ? on('Toast') : false,
        animation: both
          ? (inCombat ? s.enableTrainerAKOAnimation || s.enableTrainerBKOAnimation : s.enableTrainerAKO_OOC_Animation || s.enableTrainerBKO_OOC_Animation)
          : (inCombat ? s[`enableTrainer${label}KOAnimation`] : s[`enableTrainer${label}KO_OOC_Animation`]),
        data: { outOfCombat: !inCombat, count }
      };
      break;
    } else {
      const side = sideOf(params.side);
      const label = side === 'trainerA' ? 'A' : 'B';
      const outOfCombat = Boolean(params.isOOC);
      spec = {
        side,
        title: 'KNOCKED OUT!',
        subtitle: outOfCombat ? 'Out of combat' : 'In combat',
        // Only a KO in combat gets a banner; an out-of-combat KO is animation only
        toast: outOfCombat ? false : s[`enableTrainer${label}KOToast`],
        animation: outOfCombat ? s[`enableTrainer${label}KO_OOC_Animation`] : s[`enableTrainer${label}KOAnimation`],
        data: { outOfCombat, slot: params.slot }
      };
      break;
    }

    // The game was paused and is going on: a short toast (the pause itself is not an announcement: its banner stays on the overlay for as
    // long as the game is paused)
    case 'resume':
      spec = {
        side: null,
        title: 'GAME RESUMED',
        subtitle: 'Back to the game',
        toast: s.enablePauseToast,
        animation: false
      };
      break;

    case 'win': {
      const side = sideOf(params.side);
      const label = side === 'trainerA' ? 'A' : 'B';
      // The toast of a game that has just been won (the score is already up) says which it is, with the score: the game, or the match
      // when that decided it. One announced by hand says the match.
      const { trainerAWins, trainerBWins, bestOf } = state.matchScore;
      const own = side === 'trainerA' ? trainerAWins : trainerBWins;
      const other = side === 'trainerA' ? trainerBWins : trainerAWins;
      spec = {
        side,
        title: 'VICTORY!',
        subtitle: params.game
          ? `${nameOf(state, side)} wins the ${own > bestOf / 2 ? 'match' : 'game'} (${own}–${other})`
          : `${nameOf(state, side)} wins the match!`,
        toast: s[`enableTrainer${label}WinToast`],
        animation: s[`enableTrainer${label}WinAnimation`]
      };
      break;
    }

    default:
      return null;
  }

  if (!spec.toast && !spec.animation) return null;
  return {
    type,
    ...spec,
    // How long each part stays on screen; 0 when that part is switched off
    toastMs: spec.toast ? Math.round(s.toastSeconds * 1000) : 0,
    animationMs: spec.animation ? Math.round(s.animationSeconds * 1000) : 0,
    data: spec.data || null
  };
}

module.exports = { build };
