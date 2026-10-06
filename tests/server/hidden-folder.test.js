/**
 * The app can be put in any folder, also one under a hidden folder (".local", ".apps", a path with a dot in front of a name): the pages, the logo and the files
 * of the app are sent all the same. (A page sent by its whole path would be answered with 404 by the dotfile check of Express, which
 * the control panel showed as {"error":"The request could not be read"} and nothing else.)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, ROOT } = require('../support/harness');
const GAME = require('../../public/js/game-data');

describe('the app started from a folder under a hidden one', () => {
  let home;
  let server;

  before(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'oto-hidden-'));
    const appRoot = path.join(home, '.apps', '.oto');
    for (const entry of ['src', 'public', 'assets', 'package.json']) fs.cpSync(path.join(ROOT, entry), path.join(appRoot, entry), { recursive: true });
    server = await startServer({ label: 'hidden-folder', appRoot });
  });

  after(async () => {
    await server.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const get = (url) => fetch(`${server.base}${url}`);

  it('is running from there', () => {
    assert.match(server.appRoot, /[\\/]\.apps[\\/]\.oto$/);
  });

  it('sends the control panel, the overlay and the sign-in page', async () => {
    for (const [url, mark] of [['/control', /OTO/], ['/overlay', /<body/i]]) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
      assert.match(response.headers.get('content-type'), /text\/html/, url);
      assert.match(await response.text(), mark, url);
    }
    const login = await get('/login'); // (there is no password: it goes to the control panel)
    assert.equal(login.status, 200);
    assert.match(login.url, /\/control$/);
  });

  it('sends the logo and the tab icon', async () => {
    for (const url of ['/logo.gif', '/logo.ico', '/favicon.ico']) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
      assert.ok((await response.arrayBuffer()).byteLength > 100, url);
    }
  });

  it('sends the scripts, the styles, the icons and the markers', async () => {
    const energy = path.basename(GAME.ENERGY_TYPES[0].icon);
    for (const url of ['/js/pokedex.js', '/css/control.css', '/js/control/app.js', `/assets/energy/${energy}`, '/assets/markers/gx', '/assets/fonts/TwemojiCountryFlags.woff2']) {
      const response = await get(url);
      assert.equal(response.status, 200, url);
    }
    assert.equal((await get('/js/deck-popular.js')).status, 200);
  });
});
