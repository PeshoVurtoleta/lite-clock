// 04-progression.test.mjs
// position/t/done progression and reactive integration with lite-signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect, computed } from "@zakkster/lite-signal";
import { createClock } from "../Clock.js";

test("progression: position() advances linearly with simTime", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    assert.equal(l.positionPeek(), 0);
    c.advance(25);
    assert.equal(l.positionPeek(), 25);
    c.advance(25);
    assert.equal(l.positionPeek(), 50);
    c.advance(25);
    assert.equal(l.positionPeek(), 75);
    c.advance(25);
    assert.equal(l.positionPeek(), 100);
    assert.equal(l.donePeek(), true);
});

test("progression: t() is position/duration", () => {
    const c = createClock();
    const l = c.lane({ duration: 200 });
    l.start();
    c.advance(50);
    assert.equal(l.tPeek(), 0.25);
    c.advance(50);
    assert.equal(l.tPeek(), 0.5);
});

test("progression: t() clamps to 1 on completion", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(200);                // overrun
    assert.equal(l.tPeek(), 1);
    assert.equal(l.positionPeek(), 100);
});

test("progression: done() flips false -> true at exact duration", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(99);
    assert.equal(l.donePeek(), false);
    c.advance(1);                  // simTime hits 100; lane completes
    assert.equal(l.donePeek(), true);
});

test("progression: position/t/done track the frame signal", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    let pos = -1, t = -1, done = null;
    const dispose = effect(() => {
        pos  = l.position();
        t    = l.t();
        done = l.done();
    });
    assert.equal(pos, 0);
    assert.equal(t, 0);
    assert.equal(done, false);

    c.advance(30);
    assert.equal(pos, 30);
    assert.equal(t, 0.3);
    assert.equal(done, false);

    c.advance(80);
    assert.equal(pos, 100);
    assert.equal(t, 1);
    assert.equal(done, true);

    dispose();
});

test("progression: peek variants do not establish dependency", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    let runs = 0;
    const dispose = effect(() => {
        runs++;
        l.positionPeek();
        l.tPeek();
        l.donePeek();
    });
    assert.equal(runs, 1);
    c.advance(50);
    assert.equal(runs, 1);          // peeks did not subscribe
    dispose();
});

test("progression: computed over t() composes naturally", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    const eased = computed(() => {
        const t = l.t();
        return t * t * (3 - 2 * t);  // smoothstep
    });
    assert.equal(eased(), 0);
    c.advance(50);
    assert.equal(eased(), 0.5);
    c.advance(50);
    assert.equal(eased(), 1);
});

test("progression: a paused lane reports a stable position", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(40);
    l.pause();
    let snapshot = -1;
    const dispose = effect(() => { snapshot = l.position(); });
    assert.equal(snapshot, 40);
    c.advance(1000);
    // Effect still re-ran (frame signal force-propagates), but lane.position()
    // returns the snapshotted value because the lane is paused.
    assert.equal(snapshot, 40);
    dispose();
});
