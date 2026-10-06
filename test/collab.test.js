const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { Collab, Presence, overlaps } = require('../src/services/collab');

const change = (rev, clientId, targets, label = `change ${rev}`) => ({ rev, clientId, by: { clientId, name: clientId }, label, targets });

describe('overlaps', () => {
  it('treats a part and its sub-parts as the same area', () => {
    assert.equal(overlaps('trainerA.active', 'trainerA.active'), true);
    assert.equal(overlaps('trainerA.active', 'trainerA.active.hp'), true);
    assert.equal(overlaps('trainerA.active.hp', 'trainerA.active'), true);
  });

  it('keeps different parts apart, including look-alike names', () => {
    assert.equal(overlaps('trainerA.prizes', 'trainerA.energy'), false);
    assert.equal(overlaps('trainerA.bench.1', 'trainerA.bench.12'), false);
    assert.equal(overlaps('trainerA.active', 'trainerB.active'), false);
  });

  it('lets "*" touch everything', () => {
    assert.equal(overlaps('*', 'trainerA.prizes'), true);
    assert.equal(overlaps('turn', '*'), true);
  });
});

describe('Collab.findConflict', () => {
  it('finds a newer change by someone else to the same area', () => {
    const collab = new Collab();
    collab.recordChange(change(5, 'bob', ['trainerA.prizes']));
    const found = collab.findConflict(4, 'alice', ['trainerA.prizes']);
    assert.equal(found.rev, 5);
    assert.equal(found.by.name, 'bob');
  });

  it('ignores changes the sender had already seen', () => {
    const collab = new Collab();
    collab.recordChange(change(5, 'bob', ['trainerA.prizes']));
    assert.equal(collab.findConflict(5, 'alice', ['trainerA.prizes']), null);
    assert.equal(collab.findConflict(9, 'alice', ['trainerA.prizes']), null);
  });

  it('ignores the sender\'s own changes and unrelated areas', () => {
    const collab = new Collab();
    collab.recordChange(change(5, 'alice', ['trainerA.prizes']));
    collab.recordChange(change(6, 'bob', ['trainerB.energy']));
    assert.equal(collab.findConflict(4, 'alice', ['trainerA.prizes']), null);
  });

  it('reports the newest conflicting change', () => {
    const collab = new Collab();
    collab.recordChange(change(5, 'bob', ['turn'], 'old'));
    collab.recordChange(change(6, 'carol', ['turn'], 'new'));
    assert.equal(collab.findConflict(4, 'alice', ['turn']).label, 'new');
  });

  it('treats undo and import (which touch "*") as conflicting with any newer change', () => {
    const collab = new Collab();
    collab.recordChange(change(5, 'bob', ['trainerB.prizes']));
    assert.ok(collab.findConflict(4, 'alice', ['*']));
    collab.recordChange(change(6, 'bob', ['*']));
    assert.ok(collab.findConflict(5, 'alice', ['trainerA.prizes']));
  });

  it('forgets the oldest changes beyond its limit', () => {
    const collab = new Collab({ changeLogSize: 3 });
    for (let rev = 1; rev <= 5; rev++) collab.recordChange(change(rev, 'bob', ['turn']));
    assert.deepEqual(collab.changes.map((c) => c.rev), [3, 4, 5]);
  });
});

describe('Collab bookkeeping', () => {
  it('lets an action sequence number through only once per client', () => {
    const collab = new Collab();
    assert.equal(collab.claim('alice', 1), true);
    assert.equal(collab.claim('alice', 1), false);
    assert.equal(collab.claim('bob', 1), true);
  });

  it('bounds how many sequence numbers it remembers', () => {
    const collab = new Collab({ seqMemory: 3 });
    for (let seq = 1; seq <= 5; seq++) collab.claim('alice', seq);
    assert.equal(collab.claim('alice', 5), false);
    assert.equal(collab.claim('alice', 1), true, 'the oldest was forgotten');
  });

  it('keeps an undo history, a redo history that a new change clears, and a short activity feed', () => {
    const collab = new Collab({ undoSize: 2, activitySize: 2 });
    for (const label of ['a', 'b', 'c']) collab.pushUndo({ label });
    assert.equal(collab.peekUndo().label, 'c');
    assert.equal(collab.popUndo().label, 'c');
    assert.equal(collab.popUndo().label, 'b');
    assert.equal(collab.popUndo(), null, 'only the last two were kept');

    collab.pushRedo({ label: 'r' });
    collab.clearRedo();
    assert.equal(collab.popRedo(), null);

    for (const label of ['x', 'y', 'z']) collab.addActivity({ rev: 1, by: {}, label, kind: 'action' });
    assert.deepEqual(collab.activity.map((a) => a.label), ['y', 'z']);
    assert.deepEqual(collab.activity.map((a) => a.id), [2, 3]);
  });
});

describe('Presence', () => {
  it('names producers in order, keeping the same name across pages and reloads', () => {
    const presence = new Presence();
    presence.join('s1', { role: 'producer', clientId: 'alice' });
    presence.join('s2', { role: 'producer', clientId: 'bob' });
    presence.join('s3', { role: 'producer', clientId: 'alice' }); // a second tab

    assert.deepEqual(presence.producers(), [
      { clientId: 'alice', name: 'Producer 1', tabs: 2, host: false },
      { clientId: 'bob', name: 'Producer 2', tabs: 1, host: false }
    ]);

    // the host is the one with a page on the computer that runs OTO, whichever of its pages that is
    presence.join('s5', { role: 'producer', clientId: 'bob', host: true });
    assert.equal(presence.isHost('bob'), true);
    assert.equal(presence.isHost('alice'), false);
    assert.equal(presence.producers()[1].host, true);
    assert.deepEqual(presence.socketIdsOf('bob').sort(), ['s2', 's5']);
    presence.leave('s5');
    assert.equal(presence.isHost('bob'), false);

    presence.leave('s1');
    presence.leave('s3');
    presence.join('s4', { role: 'producer', clientId: 'alice' }); // reload
    assert.equal(presence.who('alice').name, 'Producer 1');
  });

  it('uses a chosen name and cleans it up', () => {
    const presence = new Presence();
    presence.join('s1', { role: 'producer', clientId: 'alice', name: '  Dana \u0007 the producer with a very very long name  ' });
    const name = presence.who('alice').name;
    assert.ok(name.startsWith('Dana'));
    assert.ok(name.length <= 24);
    assert.equal(/[\u0000-\u001f]/.test(name), false);

    assert.equal(presence.rename('alice', '   '), false);
    assert.equal(presence.rename('alice', 'Sam'), true);
    assert.equal(presence.who('alice').name, 'Sam');
  });

  it('counts viewers separately and knows who is still connected', () => {
    const presence = new Presence();
    presence.join('o1', { role: 'viewer', clientId: 'overlay-1' });
    presence.join('o2', { role: 'viewer', clientId: 'overlay-2' });
    presence.join('s1', { role: 'producer', clientId: 'alice' });
    assert.equal(presence.viewerCount(), 2);
    assert.equal(presence.producers().length, 1, 'viewers are not producers');
    assert.equal(presence.hasClient('alice'), true);
    presence.leave('s1');
    assert.equal(presence.hasClient('alice'), false);
  });
});
