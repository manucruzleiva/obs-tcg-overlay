/**
 * REST API.
 *
 * Two routers: `publicRouter` is reachable without signing in (health check, login, and the
 * active theme, which the overlay needs); everything else is `protectedRouter`, which the server
 * puts behind the control panel password when one is set.
 */

const express = require('express');
const { publicState } = require('../session');
const { ThemeError } = require('../services/themes');
const { getLanAddresses, isShared } = require('../services/network');
const { SoundError, MAX_SOUND_BYTES } = require('../services/sounds');
const { CatalogError } = require('../services/catalog');
const { PackageError, ZipError, MAX_PACKAGE_BYTES } = require('../services/package');

const CARD_ID = /^[\w.-]{1,40}$/;
const GAME = require('../../public/js/game-data');

// The only things a card search can be narrowed by, taken from the query string as plain text
const SEARCH_FILTERS = ['supertype', 'subtype', 'rarity', 'set', 'evolvesFrom'];

function searchRequest(query) {
  const text = typeof query.q === 'string' ? query.q.trim() : '';
  const filters = {};
  for (const key of SEARCH_FILTERS) {
    if (typeof query[key] === 'string' && query[key]) filters[key] = query[key].slice(0, 100);
  }
  // some text, or a filter that says what to look for (the evolutions of a Pokémon)
  if ((!text && !filters.evolvesFrom) || text.length > 200) return null;
  return { text, page: Math.min(100, parseInt(query.page, 10) || 1), filters };
}

module.exports = (services) => {
  const { gameState, pokemonTCG, cardUsage, cache, db, session, auth, themes, sounds, catalog, packages, io } = services;

  const publicRouter = express.Router();
  const protectedRouter = express.Router();

  // Wrap a handler so an error becomes a JSON response instead of a crash
  const handle = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof ThemeError) return res.status(error.status).json({ error: error.message });
      if (error instanceof SoundError || error instanceof PackageError || error instanceof ZipError) return res.status(400).json({ error: error.message });
      if (error instanceof CatalogError) return res.status(error.status).json({ error: error.message, ...error.extra });
      res.status(500).json({ error: error.message });
    }
  };

  const body = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

  // ------------------------------------------------------------------ public

  // `instance` tells this copy of OTO apart from any other program on the same port (see port-check.js)
  publicRouter.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now(), instance: services.instanceId });
  });

  publicRouter.get('/auth/status', (req, res) => {
    res.json({
      required: auth.isEnabled(),
      authenticated: auth.isAuthorized(req.headers.cookie),
      source: auth.source()
    });
  });

  publicRouter.post('/login', (req, res) => {
    const wait = auth.lockedFor(req.ip);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Too many attempts. Try again in ${wait} seconds.` });
    }
    if (!auth.isEnabled()) return res.json({ ok: true });

    if (!auth.verifyPassword(body(req).password)) {
      auth.recordFailure(req.ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
    auth.recordSuccess(req.ip);
    res.set('Set-Cookie', auth.sessionCookie(auth.issueToken()));
    res.json({ ok: true });
  });

  publicRouter.post('/logout', (req, res) => {
    res.set('Set-Cookie', auth.clearedCookie());
    res.json({ ok: true });
  });

  // Files of a design are shown or played, never run: this keeps even an SVG from doing anything on its own
  const sendAsset = (res, found, ref) => {
    res.set('Content-Type', found.mime);
    res.set('Cache-Control', 'no-cache');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.sendFile(ref, { root: found.root, dotfiles: 'deny', cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  };

  // The design the overlay should wear (null means the built-in look), with an address for each of its files
  publicRouter.get('/theme', (req, res) => {
    const active = themes.active();
    res.json({ name: active ? active.name : null, theme: active ? themes.resolved(active.name) : null });
  });
  // The pictures and font of the design on air (the overlay loads them without signing in)
  publicRouter.get('/theme/assets/:folder/:file', (req, res) => {
    const { folder, file } = req.params;
    const active = themes.active();
    const found = active && ['images', 'fonts'].includes(folder) ? themes.assetFile(active.name, `${folder}/${file}`) : null;
    if (!found) return res.status(404).json({ error: 'Not found' });
    sendAsset(res, found, `${folder}/${file}`);
  });

  // Which cues have a sound of their own, and the files themselves (the overlay plays them): the
  // producer's own upload if there is one, otherwise the sound of the design on air
  const effectiveSounds = () => {
    const list = {};
    for (const [cue, info] of Object.entries(themes.activeSounds())) list[cue] = { ...info, source: 'design' };
    for (const [cue, info] of Object.entries(sounds.list())) list[cue] = { ...info, source: 'custom' };
    return list;
  };
  publicRouter.get('/sounds', (req, res) => {
    res.json({ custom: effectiveSounds() });
  });
  publicRouter.get('/sounds/:cue', (req, res) => {
    const sound = sounds.read(req.params.cue) || themes.activeSound(req.params.cue);
    if (!sound) return res.status(404).json({ error: 'No custom sound for that cue' });
    res.set('Content-Type', sound.mime);
    res.set('Cache-Control', 'no-cache');
    res.send(sound.buffer);
  });

  // --------------------------------------------------------------- protected

  protectedRouter.post('/auth/password', handle((req, res) => {
    const password = body(req).password;
    if (auth.source() === 'environment') {
      return res.status(409).json({ error: 'The password is set by the OTO_PASSWORD environment variable' });
    }
    try {
      auth.setPassword(password);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    // Changing the password signs everyone out, so give the person who just did it a fresh session
    if (auth.isEnabled()) res.set('Set-Cookie', auth.sessionCookie(auth.issueToken()));
    else res.set('Set-Cookie', auth.clearedCookie());
    res.json({ required: auth.isEnabled() });
  }));

  // Game state
  protectedRouter.get('/state', (req, res) => {
    res.json(publicState(gameState.state));
  });
  protectedRouter.get('/state/trainerA', (req, res) => {
    res.json(gameState.state.trainerA);
  });
  protectedRouter.get('/state/trainerB', (req, res) => {
    res.json(gameState.state.trainerB);
  });
  protectedRouter.get('/state/match', (req, res) => {
    res.json(gameState.state.matchScore);
  });

  // Settings
  protectedRouter.get('/settings', (req, res) => {
    res.json(publicState(gameState.state).settings);
  });
  protectedRouter.post('/settings', handle((req, res) => {
    session.commit('Settings changed (API)', (gs) => gs.updateSettings(body(req)));
    res.json({ success: true });
  }));

  // Cards
  protectedRouter.get('/cards/search', handle(async (req, res) => {
    const request = searchRequest(req.query);
    if (!request) return res.status(400).json({ error: 'Query required' });
    res.json(await pokemonTCG.searchCards(request.text, request.page, request.filters));
  }));

  // The cards to start from when nothing has been typed: the most used ones, then those already saved on this computer.
  // Before /cards/:id, which would take "popular" for a card.
  protectedRouter.get('/cards/popular', handle((req, res) => {
    const filters = {};
    for (const key of ['supertype', 'subtype']) {
      if (typeof req.query[key] === 'string') filters[key] = req.query[key].slice(0, 100);
    }
    res.json(cardUsage.popular({ ...filters, page: Math.min(100, parseInt(req.query.page, 10) || 1), favorites: gameState.state.favoriteCardIds }));
  }));
  // A card that got a star: how it looks is remembered (without counting a use), so it can be listed later
  protectedRouter.post('/cards/known', handle((req, res) => {
    if (!cardUsage.remember(body(req))) return res.status(400).json({ error: 'That is not a card' });
    res.json({ ok: true });
  }));
  // The picker says which card was chosen (the card as it showed it), so it can be offered first next time
  protectedRouter.post('/cards/used', handle((req, res) => {
    if (!cardUsage.record(body(req))) return res.status(400).json({ error: 'That is not a card' });
    res.json({ ok: true });
  }));
  protectedRouter.delete('/cards/used', handle((req, res) => {
    cardUsage.clear(gameState.state.favoriteCardIds);
    res.json({ ok: true });
  }));

  protectedRouter.get('/cards/:id', handle(async (req, res) => {
    if (!CARD_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid card id' });
    // which card service the card came from, and in which language, when the page knows
    const hint = {};
    if (['pokemontcg', 'scrydex', 'tcgdex'].includes(req.query.source)) hint.source = req.query.source;
    if (GAME.CARD_LANGUAGES.some(([code]) => code === req.query.language)) hint.language = req.query.language;
    const card = await pokemonTCG.getCard(req.params.id, hint);
    if (!card) return res.status(404).json({ error: 'Card not found' });
    res.json(card);
  }));

  protectedRouter.get('/evolution/search', handle(async (req, res) => {
    const request = searchRequest(req.query);
    if (!request) return res.status(400).json({ error: 'Query required' });
    res.json(await pokemonTCG.searchCards(request.text, request.page, request.filters));
  }));

  // The card library kept on this computer (Standard, Gym Leader Challenge, Expanded) and card pictures.
  // Fixed paths come before /catalog/:profile so "pictures" and "active" are not read as a library name.
  protectedRouter.get('/catalog', (req, res) => {
    res.json(catalog.status({ pictures: true }));
  });
  protectedRouter.post('/catalog/cancel', (req, res) => {
    res.json({ stopped: catalog.cancel() });
  });
  protectedRouter.put('/catalog/active', handle((req, res) => {
    const { profile } = body(req);
    catalog.setActive(profile === null || profile === undefined || profile === '' ? null : String(profile));
    res.json(catalog.status());
  }));
  protectedRouter.post('/catalog/pictures', handle((req, res) => {
    const { sizes, confirm } = body(req);
    res.status(202).json(catalog.downloadPictures({ sizes, confirm: confirm === true }));
  }));
  protectedRouter.delete('/catalog/pictures', handle((req, res) => {
    catalog.clearPictures();
    res.json(catalog.status({ pictures: true }));
  }));
  protectedRouter.post('/catalog/:profile/download', handle((req, res) => {
    res.status(202).json(catalog.download(req.params.profile, { confirm: body(req).confirm === true }));
  }));
  protectedRouter.delete('/catalog/:profile', handle((req, res) => {
    catalog.remove(req.params.profile);
    res.json(catalog.status());
  }));

  // Favorites
  protectedRouter.get('/favorites', (req, res) => {
    res.json(gameState.state.favoriteCardIds);
  });
  protectedRouter.post('/favorites/:id', handle((req, res) => {
    if (!CARD_ID.test(req.params.id)) return res.status(400).json({ error: 'Invalid card id' });
    session.commit('Favorite toggled (API)', (gs) => gs.toggleFavorite(req.params.id));
    res.json({ favorites: gameState.state.favoriteCardIds });
  }));

  // Match history (without the saved game states, which are large)
  protectedRouter.get('/matches', (req, res) => {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    res.json(db.getMatchHistory(limit).map(({ state, state_json, ...match }) => match));
  });

  // Cache
  protectedRouter.get('/cache/stats', (req, res) => {
    res.json(cache.getStats());
  });
  protectedRouter.post('/cache/clear', (req, res) => {
    cache.clearAll();
    res.json({ success: true });
  });

  // Export / import the configuration. The API key is a secret and is never exported.
  protectedRouter.get('/config/export', (req, res) => {
    const state = gameState.state;
    res.setHeader('Content-Disposition', 'attachment; filename="overlay-config.json"');
    res.setHeader('Content-Type', 'application/json');
    // the keys of the card services are secrets: a file made for sharing never has them
    res.send(JSON.stringify({ ...state, settings: { ...state.settings, ...Object.fromEntries(GAME.SECRET_SETTINGS.map((name) => [name, ''])) } }, null, 2));
  });
  protectedRouter.post('/config/import', handle((req, res) => {
    try {
      session.commit('Configuration imported (API)', (gs) => gs.importState(body(req)));
    } catch (error) {
      return res.status(400).json({ error: 'Invalid config file' });
    }
    res.json({ success: true });
  }));

  // How to reach the control panel and overlay: from this machine and from other devices
  protectedRouter.get('/network', (req, res) => {
    const port = req.socket.localPort;
    const shared = isShared(process.env.HOST || '0.0.0.0');
    const lan = shared ? getLanAddresses() : [];
    res.json({
      port,
      shared,
      local: {
        control: `http://localhost:${port}/control`,
        overlay: `http://localhost:${port}/overlay`
      },
      lan: lan.map(({ name, address }) => ({
        name,
        address,
        control: `http://${address}:${port}/control`,
        overlay: `http://${address}:${port}/overlay`
      }))
    });
  });

  // Upload or remove the custom sound for a cue (the body is the audio file itself)
  protectedRouter.put('/sounds/:cue', express.raw({ type: () => true, limit: MAX_SOUND_BYTES + 1024 }), handle((req, res) => {
    const saved = sounds.save(req.params.cue, req.body);
    io.emit('sounds:changed');
    res.json({ cue: req.params.cue, ...saved });
  }));
  protectedRouter.delete('/sounds/:cue', handle((req, res) => {
    if (!sounds.remove(req.params.cue)) return res.status(404).json({ error: 'No custom sound for that cue' });
    io.emit('sounds:changed');
    res.json({ success: true });
  }));

  // Designs (called themes here). Editing the one on air updates the overlay right away: the look, and
  // the sounds, since a design brings its own.
  const designChanged = (name) => {
    if (!themes.isActive(name)) return;
    io.emit('theme:changed');
    io.emit('sounds:changed');
  };

  protectedRouter.get('/themes', (req, res) => {
    res.json({ active: themes.activeName(), names: themes.list() });
  });
  protectedRouter.get('/themes/:name', handle((req, res) => {
    const design = themes.get(req.params.name);
    if (!design) return res.status(404).json({ error: 'Design not found' });
    res.json(design);
  }));
  // Make a design, or change its colors, author and description. Its files have their own calls below.
  protectedRouter.put('/themes/:name', handle((req, res) => {
    const saved = themes.save(req.params.name, body(req));
    designChanged(saved.name);
    res.json(saved);
  }));
  // A design in the older format: one JSON document with the pictures inside. The name comes from the file.
  protectedRouter.post('/themes', handle((req, res) => {
    const saved = themes.importLegacy(body(req));
    designChanged(saved.name);
    res.status(201).json(saved);
  }));
  protectedRouter.delete('/themes/:name', handle((req, res) => {
    const wasActive = themes.isActive(req.params.name);
    if (!themes.remove(req.params.name)) return res.status(404).json({ error: 'Design not found' });
    if (wasActive) {
      io.emit('theme:changed');
      io.emit('sounds:changed');
    }
    res.json({ success: true });
  }));
  // Choose which design the overlay wears; { name: null } goes back to the built-in look
  protectedRouter.post('/theme/active', handle((req, res) => {
    const { name } = body(req);
    themes.setActive(name === null || name === undefined || name === '' ? null : name);
    io.emit('theme:changed');
    io.emit('sounds:changed');
    res.json({ active: themes.activeName() });
  }));

  // The pictures, font and sounds of a design arrive as the file itself
  const file = express.raw({ type: () => true, limit: 6 * 1024 * 1024 });
  const slots = [
    ['images/:key', (name, req) => themes.setImage(name, req.params.key, req.body), (name, req) => themes.removeImage(name, req.params.key)],
    ['font', (name, req) => themes.setFont(name, req.body), (name) => themes.removeFont(name)],
    ['fonts/:role', (name, req) => themes.setFontRole(name, req.params.role, req.body), (name, req) => themes.removeFontRole(name, req.params.role)],
    ['sounds/:cue', (name, req) => themes.setSound(name, req.params.cue, req.body), (name, req) => themes.removeSound(name, req.params.cue)]
  ];
  for (const [route, set, unset] of slots) {
    protectedRouter.put(`/themes/:name/${route}`, file, handle((req, res) => {
      const saved = set(req.params.name, req);
      designChanged(saved.name);
      res.json(saved);
    }));
    protectedRouter.delete(`/themes/:name/${route}`, handle((req, res) => {
      const saved = unset(req.params.name, req);
      designChanged(saved.name);
      res.json(saved);
    }));
  }
  // Any design's files, for the editor's previews
  protectedRouter.get('/themes/:name/assets/:folder/:file', (req, res) => {
    const ref = `${req.params.folder}/${req.params.file}`;
    const found = themes.assetFile(req.params.name, ref);
    if (!found) return res.status(404).json({ error: 'Not found' });
    sendAsset(res, found, ref);
  });

  // .oto packages: a design with its sounds, and the control settings, in one file
  const packageFile = express.raw({ type: () => true, limit: MAX_PACKAGE_BYTES + 1024 });
  protectedRouter.get('/packages/export', handle((req, res) => {
    const { buffer, filename } = packages.exportPackage({
      design: typeof req.query.design === 'string' && req.query.design ? req.query.design : null,
      mySounds: req.query.mySounds === '1',
      controls: req.query.controls === '1'
    });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  }));
  // What a package holds, without changing anything
  protectedRouter.post('/packages/inspect', packageFile, handle((req, res) => {
    res.json(packages.inspect(req.body));
  }));
  // Use a package: add its design, put it on air, apply its control settings (each can be left out).
  // The control panel says who is installing it, so the activity feed can show their name.
  protectedRouter.post('/packages/install', packageFile, handle((req, res) => {
    const { query } = req;
    let name = '';
    try { name = decodeURIComponent(req.get('x-oto-name') || ''); } catch { /* an unreadable name is no name */ }
    const clientId = req.get('x-oto-client') || '';
    const by = { clientId: /^[\w-]{8,64}$/.test(clientId) ? clientId : 'api', name: name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'API' };
    res.json(packages.install(req.body, {
      design: query.design !== '0',
      controls: query.controls !== '0',
      activate: query.activate !== '0',
      replace: query.replace === '1'
    }, by));
  }));

  return { publicRouter, protectedRouter };
};
