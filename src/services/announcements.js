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
      const source = state.trainerA.isTurn ? 'trainerA' : 'trainerB';
      const target = source === 'trainerA' ? 'trainerB' : 'trainerA';
      const damage = Number(params.damage) || 0;
      spec = {
        side: target,
        title: params.attackName || 'ATTACK!',
        subtitle: damage ? `${damage} damage` : '',
        toast: s.enableAttackToast,
        animation: s.enableAttackAnimation,
        data: { source, target, damage }
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

    case 'ko': {
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

    case 'win': {
      const side = sideOf(params.side);
      const label = side === 'trainerA' ? 'A' : 'B';
      spec = {
        side,
        title: 'VICTORY!',
        subtitle: `${nameOf(state, side)} wins the match!`,
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
