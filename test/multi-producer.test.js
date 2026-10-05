/**
 * Several producers driving the same match: syncing, double-click protection, shared undo and redo,
 * presence, and the private "draft then send" mode.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../test-support/harness');

const reset = (client) => client.act('action:reset', { action: 'full', confirm: 'FULL_RESET' });

describe('two producers', () => {
  let server;
  let alice;
  let bob;

  before(async () => {
    server = await startServer({ label: 'multi' });
    alice = server.client({ clientId: 'alice-client-01', name: 'Alice' });
    bob = server.client({ clientId: 'bob-client-0001', name: 'Bob' });
    await Promise.all([alice.ready(), bob.ready()]);
  });

  after(() => server.stop());

  // Wait until both pages have caught up with the latest change
  async function inSync() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (alice.revision === bob.revision) return;
      await wait(10);
    }
    throw new Error(`pages out of sync: ${alice.revision} vs ${bob.revision}`);
  }

  beforeEach(async () => {
    await reset(alice);
    await inSync();
  });

  it('shows each producer the other\'s changes straight away, and says who did what', async () => {
    const seen = bob.expect('state:update', (s) => s.trainerA.prizes.count === 5);
    const activity = bob.expect('activity', (a) => /prizes/.test(a.label));
    await alice.act('action:trainerA', { action: 'prizeMinus' });

    await seen;
    const entry = await activity;
    assert.equal(entry.by.name, 'Alice');
    assert.equal(entry.label, 'Trainer A prizes −1 (5 left)');
  });

  it('tells a producer when an action was applied', async () => {
    const result = await alice.act('action:trainerA', { action: 'prizeMinus' });
    assert.equal(result.ok, true);
    assert.equal(result.applied.revision, alice.revision);
  });

  it('applies a click once when both producers click at the same moment', async () => {
    const base = alice.revision;

    const first = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base });
    assert.equal(first.ok, true);
    assert.equal(first.state.trainerA.prizes.count, 5);

    // Bob had not seen Alice's change yet, so his click is the same click again
    const second = await bob.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base });
    assert.equal(second.ok, false);
    assert.equal(second.rejected.reason, 'conflict');
    assert.equal(second.rejected.by, 'Alice');
    assert.equal(alice.state.trainerA.prizes.count, 5, 'not decremented twice');

    // Once Bob can see the new value, a click of his is a real one
    await inSync();
    const third = await bob.act('action:trainerA', { action: 'prizeMinus' });
    assert.equal(third.ok, true);
    assert.equal(third.state.trainerA.prizes.count, 4);
  });

  it('lets changes to different things go through even from an out-of-date view', async () => {
    const base = alice.revision;
    const a = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base });
    const b = await bob.act('action:trainerB', { action: 'energyPlus' }, { baseRevision: base });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(b.state.trainerA.prizes.count, 5);
    assert.equal(b.state.trainerB.resources.energyPerTurn.used, 1);
  });

  it('lets one producer click quickly without waiting for the screen to update', async () => {
    const base = alice.revision;
    const one = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base });
    const two = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base });
    assert.equal(one.ok && two.ok, true);
    assert.equal(two.state.trainerA.prizes.count, 4);
  });

  it('protects replacements only where overwriting would lose work', async () => {
    const base = alice.revision;
    await alice.act('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: 'https://img.test/a.png', hp: 60 });

    // Bob, still looking at an empty slot, clears it: that would throw away Alice's Pokémon
    const clear = await bob.act('action:trainerA', { action: 'clearSlot', slot: -1 }, { baseRevision: base });
    assert.equal(clear.ok, false);
    assert.equal(alice.state.trainerA.active.name, 'Pikachu');

    // ...but a plain "set the name" is last-writer-wins and always applies
    const rename = await bob.act('action:trainerA', { action: 'setName', name: 'Bob was here' }, { baseRevision: base });
    assert.equal(rename.ok, true);
  });

  it('lets two producers agree about an ability token instead of cancelling each other out', async () => {
    await alice.act('action:trainerA', { action: 'setActive', cardId: 'a-1', name: 'Pikachu', image: 'https://img.test/a.png', hp: 60, abilities: ['Static'] });
    await inSync();
    const base = alice.revision;

    // both click "used" at the same time
    const a = await alice.act('action:trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true }, { baseRevision: base });
    const b = await bob.act('action:trainerA', { action: 'setAbilityUsed', slot: -1, index: 0, used: true }, { baseRevision: base });
    assert.equal(a.ok && b.ok, true);
    assert.equal(b.state.trainerA.active.abilities[0].used, true);
  });

  it('applies an action that is delivered twice only once', async () => {
    const base = alice.revision;
    const first = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base, seq: 9001 });
    assert.equal(first.ok, true);

    // the same sequence number again (a retry) is acknowledged but not applied again
    const again = await alice.act('action:trainerA', { action: 'prizeMinus' }, { baseRevision: base, seq: 9001 });
    assert.equal(again.ok, true);
    assert.equal(again.applied.duplicate, true);
    assert.equal(alice.state.trainerA.prizes.count, 5);
  });

  it('shares one undo and redo history between producers', async () => {
    await bob.act('action:trainerA', { action: 'setName', name: 'Bob\'s name' });
    await inSync();

    // Alice undoes the last change, which was Bob's, and the feed says so
    const feed = alice.expect('activity', (a) => /^Undid:/.test(a.label));
    const undone = await alice.act('action:undo', {});
    assert.equal(undone.ok, true);
    assert.equal(undone.state.trainerA.name, 'Trainer A');
    assert.match((await feed).label, /^Undid: .*\(made by Bob\)$/);

    await inSync();
    const redone = await bob.act('action:redo', {});
    assert.equal(redone.ok, true);
    assert.equal(redone.state.trainerA.name, 'Bob\'s name');

    // a new change ends the redo history
    await inSync();
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    const nothing = await alice.act('action:redo', {});
    assert.equal(nothing.ok, false);
    assert.equal(nothing.rejected.reason, 'nothing-to-redo');
  });

  it('refuses an undo that would reach past a change the sender has not seen', async () => {
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    await inSync();
    const stale = alice.revision;

    await bob.act('action:trainerB', { action: 'prizeMinus' });

    const refused = await alice.act('action:undo', {}, { baseRevision: stale });
    assert.equal(refused.ok, false);
    assert.equal(refused.rejected.reason, 'conflict');
    assert.equal(refused.rejected.by, 'Bob');
    assert.equal(bob.state.trainerB.prizes.count, 5, 'Bob\'s change is still there');
  });

  it('says there is nothing to undo when the history is empty', async () => {
    const fresh = await startServer({ label: 'empty-history' });
    try {
      const lonely = fresh.client({ clientId: 'lonely-client-1' });
      await lonely.ready();
      const refused = await lonely.act('action:undo', {});
      assert.equal(refused.ok, false);
      assert.equal(refused.rejected.reason, 'nothing-to-undo');
    } finally {
      await fresh.stop();
    }
  });

  it('says who is connected, lets people rename themselves, and counts overlay screens', async () => {
    const counted = alice.expect('presence', (p) => p.viewers >= 1);
    const overlay = server.client({ role: 'overlay', clientId: 'overlay-screen-1' });
    await overlay.ready();
    const presence = await counted;

    assert.deepEqual(presence.producers.map((p) => p.name).sort(), ['Alice', 'Bob']);
    assert.ok(presence.viewers >= 1);

    const left = alice.expect('presence', (p) => p.viewers === presence.viewers - 1);
    overlay.close();
    await left;

    const renamed = alice.expect('presence', (p) => p.producers.some((x) => x.name === 'Alicia'));
    const you = alice.expect('you', (u) => u.name === 'Alicia');
    alice.emit('presence:rename', { name: 'Alicia' });
    await renamed;
    await you;

    const back = alice.expect('you', (u) => u.name === 'Alice');
    alice.emit('presence:rename', { name: 'Alice' });
    await back;
  });

  it('keeps screens that are not signed in as producers read-only', async () => {
    const overlay = server.client({ role: 'overlay', clientId: 'overlay-screen-2' });
    await overlay.ready();
    const before = alice.revision;

    const refused = await overlay.act('action:trainerA', { action: 'prizeMinus' });
    assert.equal(refused.ok, false);
    assert.equal(refused.rejected.reason, 'read-only');
    await wait(100);
    assert.equal(alice.revision, before);
  });

  it('gives a newly connected producer the recent activity', async () => {
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    const late = server.client({ clientId: 'late-client-001', name: 'Late' });
    await late.ready();
    // the history arrives with the state, so it may already be here
    const history = late.last('activity:history') || await late.expect('activity:history');
    assert.ok(history.length > 0);
    assert.equal(history[history.length - 1].label, 'Trainer A prizes −1 (5 left)');
  });
});

describe('draft then send', () => {
  let server;
  let alice;
  let bob;

  before(async () => {
    server = await startServer({ label: 'drafts' });
    alice = server.client({ clientId: 'alice-client-01', name: 'Alice' });
    bob = server.client({ clientId: 'bob-client-0001', name: 'Bob' });
    await Promise.all([alice.ready(), bob.ready()]);
  });

  after(() => server.stop());

  async function inSync() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (alice.revision === bob.revision) return;
      await wait(10);
    }
    throw new Error('pages out of sync');
  }

  async function startDraft(client) {
    const started = client.expect('draft:state', (d) => d.active);
    client.emit('draft:start');
    return started;
  }

  beforeEach(async () => {
    // end any draft left open by the previous test, then start from a clean game
    const closed = bob.expect('draft:state', (d) => !d.active, 300).catch(() => null);
    bob.emit('draft:discard');
    await closed;
    await reset(alice);
    await inSync();
  });

  it('keeps a draft private until it is sent', async () => {
    const drafting = alice.expect('presence', (p) => p.producers.some((x) => x.name === 'Bob' && x.drafting));
    const draft = await startDraft(bob);
    assert.deepEqual(draft.changes, []);
    await drafting;

    const before = alice.revision;
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const { draft: preview } = await bob.draftAct('action:trainerA', { action: 'setName', name: 'Drafted' });

    assert.equal(preview.preview.trainerA.prizes.count, 4);
    assert.equal(preview.preview.trainerA.name, 'Drafted');
    assert.deepEqual(preview.changes.map((c) => c.label), [
      'Trainer A prizes −1 (5 left)',
      'Trainer A prizes −1 (4 left)',
      'Trainer A name → Drafted'
    ]);

    // nothing is live: Alice and the overlay still see the original
    await wait(150);
    assert.equal(alice.revision, before);
    assert.equal(alice.state.trainerA.prizes.count, 6);
    assert.equal(alice.state.trainerA.name, 'Trainer A');
  });

  it('applies a draft in one step, with one history entry and one undo', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerB', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerA', { action: 'setName', name: 'Drafted' });

    const before = alice.revision;
    const live = alice.expect('state:update');
    const feed = alice.expect('activity', (a) => /^Sent 3 changes/.test(a.label));
    const sent = bob.expect('draft:sent');
    const closed = bob.expect('draft:state', (d) => !d.active);
    bob.emit('draft:send', {});

    const state = await live;
    assert.equal(state.revision, before + 1, 'one new revision for the whole draft');
    assert.equal(state.trainerA.prizes.count, 5);
    assert.equal(state.trainerB.prizes.count, 5);
    assert.equal(state.trainerA.name, 'Drafted');
    assert.equal((await sent).applied, 3);
    assert.equal((await feed).by.name, 'Bob');
    await closed;

    // one undo takes the whole draft back
    await inSync();
    const undone = await alice.act('action:undo', {});
    assert.equal(undone.ok, true);
    assert.equal(undone.state.trainerA.prizes.count, 6);
    assert.equal(undone.state.trainerB.prizes.count, 6);
    assert.equal(undone.state.trainerA.name, 'Trainer A');
  });

  it('can be thrown away', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });

    const before = alice.revision;
    const closed = bob.expect('draft:state', (d) => !d.active);
    const idle = alice.expect('presence', (p) => p.producers.every((x) => !x.drafting));
    bob.emit('draft:discard');
    await closed;
    await idle;
    await wait(100);
    assert.equal(alice.revision, before);
    assert.equal(alice.state.trainerA.prizes.count, 6);
  });

  it('keeps the preview up to date with what happens live', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });

    const refreshed = bob.expect('draft:state', (d) => d.preview.trainerB.name === 'Live change');
    await alice.act('action:trainerB', { action: 'setName', name: 'Live change' });
    const draft = await refreshed;
    assert.equal(draft.preview.trainerA.prizes.count, 5, 'Bob\'s own draft change is still in the preview');
    assert.equal(draft.changes[0].conflict, null);
  });

  it('warns when the live game changed the same thing, and lets Bob choose what to do', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerB', { action: 'prizeMinus' });

    // Alice takes a prize on trainer A while Bob is still drafting
    const flagged = bob.expect('draft:state', (d) => d.changes[0] && d.changes[0].conflict);
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    const draft = await flagged;
    assert.equal(draft.changes[0].conflict.by, 'Alice');
    assert.equal(draft.changes[1].conflict, null);

    // the careful default stops and explains
    const conflicts = bob.expect('draft:conflicts');
    bob.emit('draft:send', {});
    assert.equal((await conflicts).conflicts.length, 1);
    assert.equal(alice.state.trainerB.prizes.count, 6, 'nothing was applied');

    // "skip" sends only what does not clash
    const sent = bob.expect('draft:sent');
    const updated = bob.expect('state:update', (s) => s.trainerB.prizes.count === 5);
    bob.emit('draft:send', { mode: 'skip' });
    const result = await sent;
    assert.equal(result.applied, 1);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /Alice/);
    await updated;
    assert.equal(bob.state.trainerA.prizes.count, 5, 'only Alice\'s prize was taken, not both');
  });

  it('can send everything anyway', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const flagged = bob.expect('draft:state', (d) => d.changes[0] && d.changes[0].conflict);
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    await flagged;

    const sent = bob.expect('draft:sent');
    const updated = bob.expect('state:update', (s) => s.trainerA.prizes.count === 4);
    bob.emit('draft:send', { mode: 'force' });
    assert.equal((await sent).applied, 1);
    await updated;
  });

  it('drops a draft when its owner goes away', async () => {
    const carol = server.client({ clientId: 'carol-client-01', name: 'Carol' });
    await carol.ready();
    const drafting = alice.expect('presence', (p) => p.producers.some((x) => x.name === 'Carol' && x.drafting));
    await startDraft(carol);
    await drafting;

    const gone = alice.expect('presence', (p) => !p.producers.some((x) => x.name === 'Carol'));
    carol.close();
    await gone;

    // the same person coming back starts clean
    const back = server.client({ clientId: 'carol-client-01', name: 'Carol' });
    await back.ready();
    await wait(100);
    assert.equal((back.events['draft:state'] || []).length, 0);
  });

  it('reports a draft change that is not valid without breaking the draft', async () => {
    await startDraft(bob);
    const bad = await bob.draftAct('action:trainerA', { action: 'prizeSet', count: 99 });
    assert.equal(bad.ok, false);
    assert.equal(bad.rejected.reason, 'invalid');

    const good = await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    assert.equal(good.draft.changes.length, 1);
  });

  it('refuses draft changes when no draft was started', async () => {
    const result = await alice.draftAct('action:trainerA', { action: 'prizeMinus' });
    assert.equal(result.ok, false);
    assert.equal(result.rejected.reason, 'no-draft');
  });
});
