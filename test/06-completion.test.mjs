// 06-completion.test.mjs
// onComplete callback semantics: end-of-tick drain, throw isolation,
// firing order relative to frame signal propagation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createClock, LiteClockReentrancyError } from "../Clock.js";

test("onComplete: fires exactly once when lane reaches duration", () => {
    const c = createClock();
    let fires = 0;
    const l = c.lane({ duration: 100, onComplete: () => { fires++; } });
    l.start();
    c.advance(50);
    assert.equal(fires, 0);
    c.advance(60);
    assert.equal(fires, 1);
    c.advance(100);                    // already done; should not re-fire
    assert.equal(fires, 1);
});

test("onComplete: fires AFTER frame signal propagates", () => {
    // Effect tracking the frame signal must observe the completion-frame
    // state BEFORE the onComplete callback runs.
    const c = createClock();
    const order = [];
    const l = c.lane({
        duration: 100,
        onComplete: () => order.push("onComplete")
    });
    l.start();
    const dispose = effect(() => {
        if (l.done()) order.push("effect-saw-done");
    });
    c.advance(100);
    assert.deepEqual(order, ["effect-saw-done", "onComplete"]);
    dispose();
});

test("onComplete: throwing callback does not block subsequent callbacks", () => {
    const c = createClock();
    const fires = [];
    const a = c.lane({ duration: 50, onComplete: () => { fires.push("a"); throw new Error("boom-a"); } });
    const b = c.lane({ duration: 50, onComplete: () => { fires.push("b"); } });
    const x = c.lane({ duration: 50, onComplete: () => { fires.push("x"); throw new Error("boom-x"); } });
    a.start(); b.start(); x.start();

    // Capture console.error to suppress noise during the test.
    const origErr = console.error;
    console.error = () => {};
    try {
        c.advance(60);
    } finally {
        console.error = origErr;
    }

    assert.deepEqual(fires.sort(), ["a", "b", "x"]);
});

test("onComplete: not called if the lane is disposed before completion", () => {
    const c = createClock();
    let fired = false;
    const l = c.lane({ duration: 100, onComplete: () => { fired = true; } });
    l.start();
    c.advance(50);
    l.dispose();
    c.advance(100);
    assert.equal(fired, false);
});

test("onComplete: not called when no callback was registered", () => {
    // Pure regression: lanes without onComplete just complete silently.
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(110);
    assert.equal(l.donePeek(), true);
});

test("onComplete: callback can dispose its own lane safely", () => {
    const c = createClock();
    let l;
    let observedActiveCount = -1;
    l = c.lane({
        duration: 50,
        onComplete: () => {
            observedActiveCount = c.activeCount;
            l.dispose();
        }
    });
    l.start();
    c.advance(100);
    assert.equal(observedActiveCount, 0); // lane already removed from active
    // Lane slot is now free; we can allocate it again.
    const next = c.lane({ duration: 10 });
    assert.ok(next);
});

test("onComplete: callback can start another lane mid-drain", () => {
    const c = createClock();
    let secondStarted = false;
    let second;
    const first = c.lane({
        duration: 50,
        onComplete: () => {
            second = c.lane({ duration: 100 });
            second.start();
            secondStarted = true;
        }
    });
    first.start();
    c.advance(60);
    assert.equal(secondStarted, true);
    assert.equal(second.donePeek(), false);
    c.advance(100);
    assert.equal(second.donePeek(), true);
});

test("onComplete: multiple lanes completing the same tick fire in their active-list order", () => {
    const c = createClock();
    const fires = [];
    const a = c.lane({ duration: 50, onComplete: () => fires.push("a") });
    const b = c.lane({ duration: 50, onComplete: () => fires.push("b") });
    const x = c.lane({ duration: 50, onComplete: () => fires.push("x") });
    a.start(); b.start(); x.start();
    c.advance(60);
    // All complete this tick; order matches activeList traversal order (which
    // is insertion order for lanes started before any completion).
    assert.deepEqual(fires, ["a", "b", "x"]);
});

// ---------------------------------------------------------------------------
// K1 drain-integrity regressions (C-01/C-02/C-03). Each PROVEN against the
// pre-K1 (1.0.1) build to fail before the fix and pass after:
//   C-01 before: fired=["A"] (B dropped forever, no throw).
//   C-02 before: fired=["A","A"] (A twice, B never -- growth swapped the queue).
//   C-03 before: fired=["A","C"] with C fired at t=0 on its CREATION tick.
// After K1: nested advance throws LiteClockReentrancyError; growth-from-callback
// fires the correct siblings; a reused slot never misfires the new tenant.
// ---------------------------------------------------------------------------

test("onComplete: re-entrant advance() throws inside the callback; the sibling still fires (C-01)", () => {
    const c = createClock();
    const fired = [];
    let caught = null;
    const a = c.lane({
        duration: 50,
        onComplete: () => { fired.push("A"); try { c.advance(1); } catch (e) { caught = e; } }
    });
    const b = c.lane({ duration: 50, onComplete: () => { fired.push("B"); } });
    a.start(); b.start();
    c.advance(60);
    assert.ok(caught instanceof LiteClockReentrancyError, "nested advance threw LiteClockReentrancyError");
    assert.deepEqual(fired, ["A", "B"]);   // B not dropped -- the drain continued
});

test("onComplete: growth triggered from a callback fires the correct sibling callbacks (C-02)", () => {
    const c = createClock({ capacity: 2, growable: true });
    const fired = [];
    const a = c.lane({
        duration: 50,
        onComplete: () => { fired.push("A"); const x = c.lane({ duration: 100 }); x.start(); }
    });
    const b = c.lane({ duration: 50, onComplete: () => { fired.push("B"); } });
    a.start(); b.start();
    c.advance(60);
    assert.deepEqual(fired, ["A", "B"]);   // captured drain buffer, not the swapped one
});

test("onComplete: disposing a queued sibling and reusing its slot never misfires the new tenant (C-03)", () => {
    const c = createClock();
    const fired = [];
    let bHandle;
    let cHandle = null;
    const a = c.lane({
        duration: 50,
        onComplete: () => {
            fired.push("A");
            bHandle.dispose();                                   // dispose queued sibling
            cHandle = c.lane({ duration: 100, onComplete: () => fired.push("C") });
            cHandle.start();                                     // reuses B's LIFO slot
        }
    });
    bHandle = c.lane({ duration: 50, onComplete: () => fired.push("B") });
    a.start(); bHandle.start();
    c.advance(60);
    assert.deepEqual(fired, ["A"]);        // C did NOT misfire at t=0; B skipped (disposed)
    assert.equal(cHandle.donePeek(), false);
    c.advance(200);
    assert.deepEqual(fired, ["A", "C"]);   // C fires exactly once, on its real completion
});

test("frame.subscribe: re-entrant advance() on the second fire throws; queued completions still fire", () => {
    // lite-signal fires subscribe callbacks immediately at subscribe time, so
    // the completion tick is the SECOND fire -- re-entry must trigger there.
    const c = createClock();
    const fired = [];
    c.lane({ duration: 50, onComplete: () => fired.push("A") }).start();
    let calls = 0;
    const unsub = c.frame.subscribe(() => { calls = (calls + 1) | 0; if (calls === 2) c.advance(1); });
    assert.throws(() => c.advance(60), LiteClockReentrancyError);
    unsub();
    assert.deepEqual(fired, ["A"]);        // finally-drain fired the queued completion despite rethrow
});
