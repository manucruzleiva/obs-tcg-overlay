#!/usr/bin/env node
/**
 * Brings the snapshot of the decks that are played the most (public/js/deck-popular.js) up to date, from the deck page of Limitless TCG.
 *
 *   npm run update:decks
 *
 * It reads https://limitlesstcg.com/decks (set OTO_LIMITLESS_URL to read another page), keeps the names, the share of each deck and the Pokémon on its
 * icon, and rewrites the file. Look at what changed (git diff) before committing it. The app does the same by itself when someone presses Update in
 * Settings, Cards, and keeps the result in its data folder instead (see src/services/limitless.js).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LimitlessDecks, render } = require('../src/services/limitless');

const target = path.join(__dirname, '..', 'public', 'js', 'deck-popular.js');

(async () => {
  const reader = new LimitlessDecks({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'oto-decks-')) });
  const decks = await reader.read();
  const unmapped = decks.filter((deck) => deck.pokemon.length < deck.icons.length);
  fs.writeFileSync(target, render(decks, { url: reader.url }));
  console.log(`${decks.length} decks written to ${path.relative(process.cwd(), target)}`);
  console.log(`The most played: ${decks.slice(0, 5).map((deck) => `${deck.name} (${deck.share}%)`).join(', ')}`);
  if (unmapped.length) console.log(`Some icons are of Pokémon this app does not know yet: ${unmapped.map((deck) => `${deck.name} [${deck.icons.join(', ')}]`).join('; ')}`);
})().catch((error) => {
  console.error(`The snapshot was not changed: ${error.message}`);
  process.exit(1);
});
