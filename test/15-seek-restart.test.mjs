// 15-seek-restart.test.mjs
// seek(p) is an authored edit, not time: clamp to [0, duration], re-base the
// carry, clear DONE iff p < duration, never fire/tick/start. restart() = seek(0)
// + start(). Stale handles no-op even on garbage input.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

test("seek: reads equal a fresh lane advanced to p", () => {
    const seeked = createClock();
    const ls = seeked.lane({ duration: 10 });
    ls.start();
    ls.seek(5);

    const fresh = createClock();
    const lf = fresh.lane({ duration: 10 });
    lf.start();
    fresh.advance(5);

    assert.equal(ls.positionPeek(), lf.positionPeek());
    assert.equal(ls.tPeek(), lf.tPeek());
});

test("seek: fires no onComplete and does not tick the frame signal", () => {
    const c = createClock();
    let fires = 0;
    const l = c.lane({ duration: 10, onComplete: () => { fires = (fires + 1) | 0; } });
    l.start();
    let ticks = 0;
    const stop = c.frame.subscribe(() => { ticks = (ticks + 1) | 0; });
    const ticksBaseline = ticks;                 // subscribe fired once immediately
    l.seek(10);                                  // even a full seek must not fire/tick
    assert.equal(fires, 0);
    assert.equal(ticks, ticksBaseline);
    stop();
});

test("seek: throws RangeError on non-finite / non-number (live handle)", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    assert.throws(() => l.seek(NaN), RangeError);
    assert.throws(() => l.seek(Infinity), RangeError);
    assert.throws(() => l.seek(-Infinity), RangeError);
    assert.throws(() => l.seek("5"), RangeError);
    assert.throws(() => l.seek(null), RangeError);
});

test("seek: clamps below 0 to 0 and above duration to duration", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    l.seek(-5);
    assert.equal(l.positionPeek(), 0);
    l.seek(15);
    assert.equal(l.positionPeek(), 10);
});

test("seek: a DONE lane seeked to mid becomes paused, start() resumes from there", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    c.advance(10);
    assert.equal(l.donePeek(), true);
    const activeAfterDone = c.activeCount;       // completed lane left active list
    l.seek(4);
    assert.equal(l.donePeek(), false);           // DONE cleared (p < duration)
    assert.equal(c.activeCount, activeAfterDone); // seek does not start
    l.start();
    assert.equal(c.activeCount, activeAfterDone + 1);
    c.advance(2);
    assert.equal(l.positionPeek(), 6);           // resumed from 4
});

test("seek(duration) then advance(0) does NOT complete", () => {
    const c = createClock();
    let fires = 0;
    const l = c.lane({ duration: 10, onComplete: () => { fires = (fires + 1) | 0; } });
    l.start();
    l.seek(10);
    c.advance(0);
    assert.equal(fires, 0);
    assert.equal(l.donePeek(), false);
});

test("seek(duration) then advance(0.001) completes exactly once", () => {
    const c = createClock();
    let fires = 0;
    const l = c.lane({ duration: 10, onComplete: () => { fires = (fires + 1) | 0; } });
    l.start();
    l.seek(10);
    c.advance(0.001);
    assert.equal(fires, 1);
    assert.equal(l.donePeek(), true);
});

test("restart: ACTIVE lane re-bases to 0 and stays active", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    c.advance(7);
    const activeBefore = c.activeCount;
    l.restart();
    assert.equal(l.positionPeek(), 0);
    assert.equal(c.activeCount, activeBefore);
    assert.equal(l.donePeek(), false);
});

test("restart: DONE lane clears DONE and runs", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    c.advance(10);
    assert.equal(l.donePeek(), true);
    l.restart();
    assert.equal(l.donePeek(), false);
    assert.equal(l.positionPeek(), 0);
    c.advance(3);
    assert.equal(l.positionPeek(), 3);           // running again
});

test("seek/restart on a stale handle are silent no-ops even with garbage input", () => {
    const c = createClock();
    const l = c.lane({ duration: 10 });
    l.start();
    l.dispose();                                 // handle is now stale
    assert.doesNotThrow(() => l.seek(NaN));      // stale check beats validation
    assert.doesNotThrow(() => l.seek(Infinity));
    assert.doesNotThrow(() => l.restart());
});
