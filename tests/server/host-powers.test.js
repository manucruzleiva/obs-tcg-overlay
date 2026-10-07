/**
 * The host (the person on the computer that runs OTO) and the producers who join from other devices: everybody can rename themselves, only
 * the host renames the others or removes them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../support/harness');

describe('the host and the other producers', () => {
  let server;
  let host;
  let maya;
  let noah;

  before(async () => {
    server = await startServer({ label: 'host-powers' });
    host = server.client({ clientId: 'host-client-001', name: 'Host' });
    maya = server.client({ clientId: 'maya-client-001', name: 'Maya', guest: true });
    noah = server.client({ clientId: 'noah-client-001', name: 'Noah', guest: true });
    await Promise.all([host.ready(), maya.ready(), noah.ready()]);
  });

  after(() => server.stop());

  it('knows which page is the host: the one on the computer that runs OTO, and nobody who joins from another device', async () => {
    // (each page is told who it is on its own: wait for the list with the three of them, and for both pages to know)
    const allHere = () => host.events.presence && host.events.presence.at(-1).producers.length === 3 && host.events.you && maya.events.you;
    for (let i = 0; i < 60 && !allHere(); i++) await wait(50);
    const presence = host.events.presence.at(-1);
    assert.deepEqual(presence.producers.map((p) => [p.name, p.host]).sort(), [['Host', true], ['Maya', false], ['Noah', false]], 'who is in it, whatever the order');
    assert.equal(host.events.you.at(-1).host, true);
    assert.equal(maya.events.you.at(-1).host, false);
  });

  it('lets everybody rename themselves, and nobody else but the host', async () => {
    const renamed = host.expect('presence', (p) => p.producers.some((x) => x.name === 'Maya P.'));
    const mayaTold = maya.expect('you', (you) => you.name === 'Maya P.'); // (her own page hears it on its own, not necessarily before the host's)
    maya.emit('presence:rename', { name: 'Maya P.' });
    await Promise.all([renamed, mayaTold]);
    assert.equal(maya.events.you.at(-1).name, 'Maya P.');

    // a guest cannot rename another producer
    const refused = maya.expect('action:rejected', (r) => r.reason === 'forbidden');
    maya.emit('presence:rename', { name: 'Hacked', clientId: 'noah-client-001' });
    assert.match((await refused).message, /Only the host/);
    await wait(100);
    assert.equal(noah.events.you.at(-1).name, 'Noah');

    // the host can, and the page of that producer is told its new name
    const told = noah.expect('you', (you) => you.name === 'Noah Q.');
    const seen = host.expect('presence', (p) => p.producers.some((x) => x.name === 'Noah Q.'));
    host.emit('presence:rename', { name: 'Noah Q.', clientId: 'noah-client-001' });
    await Promise.all([told, seen]);

    // a name that is empty, or of a producer who is not here, changes nothing
    host.emit('presence:rename', { name: '   ', clientId: 'noah-client-001' });
    host.emit('presence:rename', { name: 'Ghost', clientId: 'nobody-client-1' });
    await wait(150);
    assert.deepEqual(host.events.presence.at(-1).producers.map((p) => p.name).sort(), ['Host', 'Maya P.', 'Noah Q.']);
  });

  it('only lets the host remove a producer, never the host itself, and tells the producer', async () => {
    const refused = maya.expect('action:rejected', (r) => r.reason === 'forbidden');
    maya.emit('presence:kick', { clientId: 'noah-client-001' });
    assert.match((await refused).message, /Only the host/);
    assert.equal(noah.socket.connected, true, 'nothing happened to Noah');

    // the host cannot be removed (not even by itself)
    host.emit('presence:kick', { clientId: 'host-client-001' });
    await wait(150);
    assert.equal(host.socket.connected, true);

    const kicked = noah.expect('kicked');
    const gone = host.expect('presence', (p) => p.producers.length === 2 && p.kicked === 1);
    const logged = host.expect('activity', (entry) => /Removed Noah Q\. from the session/.test(entry.label));
    host.emit('presence:kick', { clientId: 'noah-client-001' });
    assert.equal((await kicked).by, 'Host');
    const presence = await gone;
    assert.deepEqual(presence.producers.map((p) => p.name).sort(), ['Host', 'Maya P.']);
    await logged;
    await wait(100);
    assert.equal(noah.socket.connected, false, 'their page is closed');
  });

  it('keeps a removed producer out until the host lets them back in', async () => {
    const again = server.client({ clientId: 'noah-client-001', name: 'Noah', guest: true });
    await wait(400);
    assert.equal(again.connectError, 'kicked', 'the same producer is refused');
    assert.equal(again.state, null);
    // so is another browser on the same device
    const other = server.client({ clientId: 'noah-client-002', name: 'Noah again', guest: true });
    await wait(400);
    assert.equal(other.connectError, 'kicked', 'the same address is refused too');

    // a viewer (an overlay) is not affected
    const overlay = server.client({ clientId: 'overlay-client-1', role: 'overlay', guest: true });
    await overlay.ready();
    assert.ok(overlay.state);

    // only the host lets them back in
    maya.emit('presence:forgive');
    await wait(150);
    assert.equal(host.events.presence.at(-1).kicked, 1, 'a guest cannot');
    const clear = host.expect('presence', (p) => p.kicked === 0);
    host.emit('presence:forgive');
    await clear;
    const back = server.client({ clientId: 'noah-client-001', name: 'Noah', guest: true });
    await back.ready();
    await wait(150);
    assert.equal(back.connectError, null);
    assert.equal(back.events.you.at(-1).host, false);
  });
});
