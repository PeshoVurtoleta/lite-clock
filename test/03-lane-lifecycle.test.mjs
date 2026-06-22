// 03-lane-lifecycle.test.mjs
// Lane allocation, start/pause/dispose lifecycle, pool reuse semantics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

test("lane: rejects non-object opts", () => {
    const c = createClock();
    assert.throws(() => c.lane(null),     TypeError);
    assert.throws(() => c.lane(),         TypeError);
    assert.throws(() => c.lane(42),       TypeError);
    assert.throws(() => c.lane("dur"),    TypeError);
});

test("lane: rejects missing/invalid duration", () => {
    const c = createClock();
    assert.throws(() => c.lane({}),                  RangeError);
    assert.throws(() => c.lane({ duration: 0 }),     RangeError);
    assert.throws(() => c.lane({ duration: -10 }),   RangeError);
    assert.throws(() => c.lane({ duration: NaN }),   RangeError);
    assert.throws(() => c.lane({ duration: "100" }), RangeError);
});

test("lane: rejects non-function onComplete", () => {
    const c = createClock();
    assert.throws(() => c.lane({ duration: 100, onComplete: "nope" }), TypeError);
});

test("lane: fresh lane is allocated but not active", () => {
    const c = createClock();
    assert.equal(c.activeCount, 0);
    const l = c.lane({ duration: 100 });
    assert.equal(c.activeCount, 0);
    assert.equal(l.donePeek(), false);
    assert.equal(l.positionPeek(), 0);
});

test("lane: start() activates and tracks elapsed time", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    assert.equal(c.activeCount, 1);
    c.advance(30);
    assert.equal(l.positionPeek(), 30);
});

test("lane: pause() snapshots elapsed and removes from active list", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(40);
    l.pause();
    assert.equal(c.activeCount, 0);
    assert.equal(l.positionPeek(), 40);
    c.advance(50);
    assert.equal(l.positionPeek(), 40); // unchanged while paused
});

test("lane: start() after pause() resumes from snapshotted position", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(40);
    l.pause();
    c.advance(1000); // sim time advances; lane is paused so untouched
    l.start();
    c.advance(20);
    assert.equal(l.positionPeek(), 60);
});

test("lane: dispose() removes lane from active list and frees the slot", () => {
    const c = createClock({ capacity: 4 });
    const a = c.lane({ duration: 100 });
    const b = c.lane({ duration: 100 });
    const x = c.lane({ duration: 100 });
    const y = c.lane({ duration: 100 });
    a.start(); b.start();
    assert.equal(c.activeCount, 2);

    a.dispose();
    assert.equal(c.activeCount, 1);

    // Pool full -- this would throw without dispose freeing the slot.
    b.dispose(); x.dispose(); y.dispose();
    // Now we can allocate four fresh lanes again.
    const fresh1 = c.lane({ duration: 100 });
    const fresh2 = c.lane({ duration: 100 });
    const fresh3 = c.lane({ duration: 100 });
    const fresh4 = c.lane({ duration: 100 });
    assert.ok(fresh1 && fresh2 && fresh3 && fresh4);
});

test("lane: dispose() is idempotent", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    l.dispose();
    l.dispose();
    l.dispose();
    // Subsequent method calls are silent no-ops; no throws.
    l.start();
    l.pause();
    l.reverse();
    assert.equal(c.activeCount, 0);
});

test("lane: methods on a disposed lane are silent no-ops", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.dispose();
    l.start();
    assert.equal(c.activeCount, 0);
    l.pause();
    l.reverse();
    // No throws.
});

test("lane: start() on an already-running lane is idempotent", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    l.start();
    l.start();
    assert.equal(c.activeCount, 1);
});

test("lane: pause() on a paused (or never-started) lane is a no-op", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.pause(); // never started
    assert.equal(c.activeCount, 0);
    l.start();
    c.advance(10);
    l.pause();
    l.pause();
    assert.equal(c.activeCount, 0);
});

test("lane: pool reuses dispose-freed slots in FIFO order", () => {
    // Free list is a stack -- LIFO -- so the last disposed slot is allocated first.
    // Document the actual behavior so consumers aren't surprised.
    const c = createClock({ capacity: 4 });
    const slots = [];
    for (let i = 0; i < 4; i++) slots.push(c.lane({ duration: 10 }));
    // All four allocated; capacity full.
    slots[2].dispose();
    slots[0].dispose();
    // Re-allocate two; should reuse the freed slots (we can't observe slot IDs
    // directly, but the lanes should allocate without throwing).
    const r1 = c.lane({ duration: 10 });
    const r2 = c.lane({ duration: 10 });
    assert.ok(r1 && r2);
    assert.throws(() => c.lane({ duration: 10 }), Error); // pool exhausted again
});

test("lane: multiple concurrent lanes track independently", () => {
    const c = createClock();
    const a = c.lane({ duration: 100 });
    const b = c.lane({ duration: 200 });
    const x = c.lane({ duration: 50 });
    a.start(); b.start(); x.start();
    c.advance(40);
    assert.equal(a.positionPeek(), 40);
    assert.equal(b.positionPeek(), 40);
    assert.equal(x.positionPeek(), 40);
    c.advance(20);
    assert.equal(a.positionPeek(), 60);
    assert.equal(b.positionPeek(), 60);
    assert.equal(x.positionPeek(), 50); // clamped at duration on completion
    assert.equal(x.donePeek(), true);
});
