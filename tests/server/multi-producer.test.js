/**
 * Several producers driving the same match: syncing, double-click protection, shared undo and redo,
 * presence, and the private "draft then send" mode.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, wait } = require('../support/harness');

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

  // Both pages must have caught up with the last test before the reset: a reset from a view that has not seen
  // Bob's last click is a clash and is refused (it was, now and then, on a busy machine)
  beforeEach(async () => {
    await inSync();
    const result = await reset(alice);
    assert.equal(result.ok, true, 'the game was reset');
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

describe('the draft the producers share', () => {
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

  // starts the draft from one producer, and waits until the other one is told as well
  async function startDraft(client, other = client === bob ? alice : bob) {
    const told = other.expect('draft:state', (d) => d.active);
    const started = client.expect('draft:state', (d) => d.active);
    client.emit('draft:start');
    await told;
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

  it('is one draft for all the producers: they see the same preview and who made each change, and it is not live until it is sent', async () => {
    const drafting = alice.expect('presence', (p) => p.producers.every((x) => x.drafting));
    const draft = await startDraft(bob);
    assert.deepEqual(draft.changes, []);
    assert.equal(draft.startedBy.name, 'Bob');
    await drafting;

    const before = alice.revision;
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const seenByAlice = alice.expect('draft:state', (d) => d.changes.length === 2);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const own = await seenByAlice;
    assert.equal(own.preview.trainerA.prizes.count, 4, 'Alice sees what Bob drafted');
    assert.equal(own.ack, undefined, 'and is not handed an answer to an action of Bob\'s');

    // Alice adds to the same draft
    const { draft: preview } = await alice.draftAct('action:trainerA', { action: 'setName', name: 'Drafted' });
    assert.equal(preview.preview.trainerA.prizes.count, 4);
    assert.equal(preview.preview.trainerA.name, 'Drafted');
    assert.deepEqual(preview.changes.map((c) => [c.by, c.label]), [
      ['Bob', 'Trainer A prizes −1 (5 left)'],
      ['Bob', 'Trainer A prizes −1 (4 left)'],
      ['Alice', 'Trainer A name → Drafted']
    ]);
    const bobSees = bob.last('draft:state');
    assert.equal(bobSees.changes.length, 3, 'and Bob sees it');

    // nothing is live
    await wait(150);
    assert.equal(alice.revision, before);
    assert.equal(alice.state.trainerA.prizes.count, 6);
    assert.equal(bob.state.trainerA.name, 'Trainer A');
  });

  it('tells a producer who arrives while there is a draft, and drops it when the last producer goes', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const late = server.client({ clientId: 'late-draft-001', name: 'Late' });
    await late.ready();
    const told = late.last('draft:state') || await late.expect('draft:state');
    assert.equal(told.active, true);
    assert.equal(told.changes.length, 1);
    assert.equal(told.preview.trainerA.prizes.count, 5);
    late.close();

    // nobody here to send it: the draft goes with the producers (a new server, since the others are in use)
    const alone = await startServer({ label: 'drafts-alone' });
    try {
      const one = alone.client({ clientId: 'alone-client-01', name: 'One' });
      await one.ready();
      one.emit('draft:start');
      await one.expect('draft:state', (d) => d.active);
      one.close();
      await wait(200);
      const back = alone.client({ clientId: 'alone-client-01', name: 'One' });
      await back.ready();
      await wait(150);
      assert.equal((back.events['draft:state'] || []).length, 0, 'the same person coming back starts clean');
      back.close();
    } finally {
      await alone.stop();
    }
  });

  it('keeps the draft when the producer who started it goes away, for the others', async () => {
    const carol = server.client({ clientId: 'carol-client-01', name: 'Carol' });
    await carol.ready();
    await startDraft(carol, alice);
    await carol.draftAct('action:trainerA', { action: 'prizeMinus' });
    const gone = alice.expect('presence', (p) => !p.producers.some((x) => x.name === 'Carol'));
    carol.close();
    await gone;
    const added = await alice.draftAct('action:trainerB', { action: 'prizeMinus' });
    assert.equal(added.draft.changes.length, 2, 'Carol\'s change is still in it');
    assert.equal(added.draft.startedBy.name, 'Carol');
  });

  it('is applied in one step by any of them, with one history entry and one undo, and everybody is told who sent it', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    await alice.draftAct('action:trainerB', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerA', { action: 'setName', name: 'Drafted' });

    const before = alice.revision;
    const live = bob.expect('state:update');
    const feed = bob.expect('activity', (a) => /^Sent 3 changes/.test(a.label));
    const sentToBob = bob.expect('draft:sent');
    const sentToAlice = alice.expect('draft:sent');
    const emptied = bob.expect('draft:state', (d) => d.active && d.changes.length === 0);
    alice.emit('draft:send', {});

    const state = await live;
    assert.equal(state.revision, before + 1, 'one new revision for the whole draft');
    assert.equal(state.trainerA.prizes.count, 5);
    assert.equal(state.trainerB.prizes.count, 5);
    assert.equal(state.trainerA.name, 'Drafted');
    const told = await sentToBob;
    assert.deepEqual([told.applied, told.by], [3, 'Alice']);
    assert.deepEqual([(await sentToAlice).applied, (await feed).by.name], [3, 'Alice']);
    // draft mode goes on: the draft is open again, empty, for everybody, and the next change goes into it
    const open = await emptied;
    assert.equal(open.preview.trainerA.name, 'Drafted', 'it starts from the game as it is now');
    assert.equal(open.startedBy.name, 'Bob');
    const next = await alice.draftAct('action:trainerA', { action: 'prizeMinus' });
    assert.equal(next.draft.changes.length, 1);
    assert.equal(alice.revision, state.revision, 'not live: it is the next draft');
    await alice.expect('presence', (p) => p.producers.every((x) => x.drafting), 500).catch(() => null);
    assert.ok(alice.last('presence').producers.every((x) => x.drafting), 'and everybody is still editing it');
    alice.emit('draft:clear');
    await alice.expect('draft:state', (d) => d.active && d.changes.length === 0);

    // one undo takes the whole draft back
    await inSync();
    const undone = await bob.act('action:undo', {});
    assert.equal(undone.ok, true);
    assert.equal(undone.state.trainerA.prizes.count, 6);
    assert.equal(undone.state.trainerB.prizes.count, 6);
    assert.equal(undone.state.trainerA.name, 'Trainer A');
  });

  it('wins the game by itself, as a step of the system, when the draft that was sent takes the last prize card, and the undo takes it back on its own', async () => {
    await startDraft(bob);
    for (let i = 0; i < 6; i++) await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    const sentEntry = alice.expect('activity', (a) => /^Sent 6 changes/.test(a.label));
    const autoEntry = alice.expect('activity', (a) => a.kind === 'auto');
    const won = alice.expect('announce', (a) => a.type === 'win');
    alice.emit('draft:send', {});
    const sent = await sentEntry;
    const automatic = await autoEntry;
    assert.equal(sent.label.includes('won the game'), false, 'the sent changes are what the producer did');
    assert.deepEqual([sent.by.name, sent.kind], ['Alice', 'draft']);
    assert.deepEqual([automatic.by.name, automatic.by.clientId, automatic.kind], ['OTO (automatic)', 'system', 'auto']);
    assert.match(automatic.label, /Trainer A won the game by itself \(took the last prize card\): score 1–0/);
    assert.equal((await won).side, 'trainerA');
    await inSync();
    let state = await fetch(`${server.base}/api/state`).then((r) => r.json());
    assert.deepEqual([state.trainerA.prizes.count, state.matchScore.trainerAWins], [0, 1]);

    // the first undo takes back the game that was won, the second the whole draft that was sent
    state = (await bob.act('action:undo', {})).state;
    assert.match(bob.last('activity').label, /^Undid: Trainer A won the game \(automatic\)/);
    assert.deepEqual([state.trainerA.prizes.count, state.matchScore.trainerAWins], [0, 0], 'the game is not won, the prize cards are still taken');
    state = (await bob.act('action:undo', {})).state;
    assert.deepEqual([state.trainerA.prizes.count, state.matchScore.trainerAWins], [6, 0], 'the sent draft goes back');
  });

  describe('redoing the send of a draft', () => {
    // a draft of two changes by two producers, sent and then undone
    async function sentAndUndone() {
      await startDraft(bob);
      await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
      await alice.draftAct('action:trainerB', { action: 'setName', name: 'Gary' });
      const emptied = bob.expect('draft:state', (d) => d.active && d.changes.length === 0);
      bob.emit('draft:send', {});
      await emptied;
      await inSync();
      const undone = await alice.act('action:undo', {});
      assert.equal(undone.state.trainerA.prizes.count, 6);
      await inSync();
    }

    it('opens the draft again with the changes that were sent, for everybody, and leaves the game as the undo left it', async () => {
      await sentAndUndone();
      const before = alice.revision;
      const opened = bob.expect('draft:state', (d) => d.active && d.changes.length === 2);
      const result = await alice.act('action:redo', {});
      assert.equal(result.ok, true);
      assert.equal(result.applied.draft, true, 'the answer says it was a draft that opened');
      assert.equal(result.applied.changes, 2);

      const draft = await opened;
      assert.deepEqual(draft.changes.map((c) => [c.by, c.label]), [['Bob', 'Trainer A prizes −1 (5 left)'], ['Alice', 'Trainer B name → Gary']], 'with who made each of them');
      assert.equal(draft.preview.trainerA.prizes.count, 5);
      assert.equal(draft.preview.trainerB.name, 'Gary');
      assert.ok(draft.changes.every((change) => change.conflict === null));
      await wait(150);
      assert.equal(alice.revision, before, 'nothing went to the overlay');
      assert.equal(alice.state.trainerA.prizes.count, 6);
      assert.equal(alice.state.trainerB.name, 'Trainer B');
      const feed = (alice.events.activity || []).filter((entry) => /opened again as a draft/.test(entry.label));
      assert.match(feed[feed.length - 1].label, /^Redid: 2 sent changes, opened again as a draft/);
    });

    it('can be changed before it is sent again, by any producer, and then goes live in one step', async () => {
      await sentAndUndone();
      const opened = bob.expect('draft:state', (d) => d.active && d.changes.length === 2);
      await alice.act('action:redo', {});
      await opened;
      const { draft } = await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
      assert.equal(draft.changes.length, 3);
      assert.equal(draft.preview.trainerA.prizes.count, 4);

      const before = alice.revision;
      const sent = alice.expect('draft:sent');
      const live = alice.expect('state:update', (s) => s.revision === before + 1);
      alice.emit('draft:send', {});
      assert.equal((await sent).applied, 3);
      await live;
      assert.equal(alice.state.trainerA.prizes.count, 4);
      assert.equal(alice.state.trainerB.name, 'Gary');

      // and that send is one step too
      await inSync();
      const undone = await bob.act('action:undo', {});
      assert.equal(undone.state.trainerA.prizes.count, 6);
    });

    it('can be thrown away like any draft, and then the game is as the undo left it', async () => {
      await sentAndUndone();
      await alice.act('action:redo', {});
      const closed = bob.expect('draft:state', (d) => !d.active);
      alice.emit('draft:discard');
      await closed;
      await wait(100);
      assert.equal(alice.state.trainerA.prizes.count, 6);
      const again = await alice.act('action:redo', {});
      assert.equal(again.ok, false, 'the redo was used up');
      assert.equal(again.rejected.reason, 'nothing-to-redo');
    });

    it('adds the changes to the draft that is open already', async () => {
      await sentAndUndone();
      await startDraft(bob);
      await bob.draftAct('action:match', { action: 'setBestOf', bestOf: 5 });
      const merged = bob.expect('draft:state', (d) => d.changes.length === 3);
      await alice.act('action:redo', {});
      const draft = await merged;
      assert.equal(draft.changes[0].label, 'Best of 5', 'what was in the draft stays first');
    });

    it('opens nothing for an ordinary redo, which is applied as before', async () => {
      await bob.act('action:trainerA', { action: 'prizeMinus' });
      await inSync();
      await alice.act('action:undo', {});
      await inSync();
      const redone = await alice.act('action:redo', {});
      assert.equal(redone.ok, true);
      assert.equal(redone.applied.draft, undefined);
      assert.equal(redone.state.trainerA.prizes.count, 5, 'applied to the game');
      await wait(100);
      assert.equal((bob.last('draft:state') || { active: false }).active, false);
    });

    it('marks a change that no longer applies, instead of failing', async () => {
      await startDraft(bob);
      await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
      const emptied = bob.expect('draft:state', (d) => d.active && d.changes.length === 0);
      bob.emit('draft:send', {});
      await emptied;
      await inSync();
      await alice.act('action:undo', {});
      await inSync();
      const opened = bob.expect('draft:state', (d) => d.active && d.changes.length === 1);
      await alice.act('action:redo', {});
      const draft = await opened;
      assert.equal(draft.changes.length, 1);
      assert.equal(draft.changes[0].conflict, null);
    });
  });

  it('can be thrown away by any of them, and the others are told who did', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });

    const before = alice.revision;
    const closed = bob.expect('draft:state', (d) => !d.active);
    const toldBob = bob.expect('draft:closed');
    const idle = bob.expect('presence', (p) => p.producers.every((x) => !x.drafting));
    alice.emit('draft:discard');
    await closed;
    const gone = await toldBob;
    assert.deepEqual([gone.how, gone.by], ['discarded', 'Alice']);
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
    assert.equal(draft.preview.trainerA.prizes.count, 5, 'the draft change is still in the preview');
    assert.equal(draft.changes[0].conflict, null);
  });

  it('warns when the live game changed the same thing since the draft began, and lets the sender choose what to do', async () => {
    await startDraft(bob);
    await bob.draftAct('action:trainerA', { action: 'prizeMinus' });
    await bob.draftAct('action:trainerB', { action: 'prizeMinus' });

    // a change that is not part of the draft (a producer's page that is not drafting does that, and so does the API) takes a prize on trainer A
    const flagged = bob.expect('draft:state', (d) => d.changes[0] && d.changes[0].conflict);
    await alice.act('action:trainerA', { action: 'prizeMinus' });
    const draft = await flagged;
    assert.equal(draft.changes[0].conflict.by, 'Alice');
    assert.equal(draft.changes[1].conflict, null);

    // the careful default stops and explains (to the one who sent)
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
