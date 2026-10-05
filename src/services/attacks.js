/**
 * The attacks of a card, as the game keeps them: { name, damage, mod }.
 *
 * Card data writes the damage as text: "30", "50+" (more with some conditions), "20×" (times something),
 * "10-" or nothing at all (the attack does something else). The number is the base the producer starts from when
 * announcing the attack; `mod` is what came after it, so the control panel can say "50+".
 */

const MAX_ATTACKS = 4;
const MAX_NAME = 60;

// "50+" -> { damage: 50, mod: '+' }; 120 -> { damage: 120, mod: '' }; "" or "Special" -> { damage: 0, mod: '' }
function parseDamage(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return { damage: Math.max(0, Math.min(9999, Math.round(value))), mod: '' };
  const match = /^\s*(\d{1,4})\s*([+×x*-]?)/i.exec(typeof value === 'string' ? value : '');
  if (!match) return { damage: 0, mod: '' };
  const mod = match[2] === 'x' || match[2] === 'X' || match[2] === '*' ? '×' : match[2];
  return { damage: Number(match[1]), mod };
}

// One attack from card data: a name, or an object with a name and a damage. null when there is no name.
function attackOf(raw) {
  const name = typeof raw === 'string' ? raw : raw && raw.name;
  if (typeof name !== 'string' || !name.trim()) return null;
  const given = raw && typeof raw === 'object' ? raw : {};
  const parsed = parseDamage(given.damage);
  const mod = typeof given.mod === 'string' && ['+', '×', '-'].includes(given.mod) ? given.mod : parsed.mod;
  return { name: name.trim().slice(0, MAX_NAME), damage: parsed.damage, mod };
}

// A list of attacks. Undefined means "no information" (so a Pokémon keeps the attacks it had).
function attacksOf(list) {
  if (!Array.isArray(list)) return undefined;
  return list.map(attackOf).filter(Boolean).slice(0, MAX_ATTACKS);
}

// How many Energy it takes to retreat, from card data: a number (convertedRetreatCost, retreat) or a list of
// costs (retreatCost: ["Colorless", "Colorless"]). Undefined means "no information".
const MAX_RETREAT = 6;
function retreatOf(item) {
  if (!item || typeof item !== 'object') return undefined;
  const value = item.convertedRetreatCost ?? item.retreat ?? (Array.isArray(item.retreatCost) ? item.retreatCost.length : undefined);
  const number = Number(value);
  return value === undefined || value === null || !Number.isFinite(number) ? undefined : Math.max(0, Math.min(MAX_RETREAT, Math.round(number)));
}

module.exports = { MAX_ATTACKS, MAX_RETREAT, parseDamage, attackOf, attacksOf, retreatOf };
