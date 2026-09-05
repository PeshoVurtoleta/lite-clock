// 11-dispose-leak.test.mjs
// Regression: createClock()/clock.dispose() cycles must NOT leak nodes from
// the @zakkster/lite-signal default registry. Pre-fix this would hit
// `CapacityError: nodes capacity (1024) exceeded` at the 1024th cycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createClock, LiteClockDisposedError } from "../Clock.js";

test("dispose: 4K create/dispose cycles do not leak lite-signal nodes", () => {
    // 4x the default registry capacity. If the frameSig leaks, this throws.
    for (let i = 0; i < 4096; i = (i + 1) | 0) {
        const c = createClock();
        c.dispose();
    }
});

test("dispose: create + use + dispose still releases the node", () => {
    // Cover the path where the signal has actually been tracked & propagated
    // before disposal (the GC-tested hot path).
    for (let i = 0; i < 2048; i = (i + 1) | 0) {
        const c = createClock();
        const l = c.lane({ duration: 10 });
        l.start();
        c.advance(5);
        c.dispose();
    }
});

test("dispose: registered effect tracking the frame keeps working after the clock is gone", () => {
    // The effect should fire once on creation (initial pull); after the clock
    // disposes its signal, the effect should no longer be invoked by frame
    // updates (there are none) but the effect handle remains disposable.
    const c = createClock();
    let runs = 0;
    const stop = effect(() => { c.frame(); runs++; });
    assert.equal(runs, 1);
    c.advance(10);
    assert.equal(runs, 2);
    c.dispose();
    // Frame signal is dead; further effect re-runs would only come from new
    // tracked reads, of which there are none.
    stop();
});

test("dispose: idempotent", () => {
    const c = createClock();
    c.dispose();
    c.dispose();
    c.dispose();
});

test("dispose: C-06 -- a dead clock fails closed; frame() stays a number", () => {
    // Fail-before (pre-K2 1.0.2): lane()/advance() "worked" on a disposed clock
    // (zombie) and fired callbacks, while frame() returned undefined against a
    // d.ts that says number. Pass-after: the mutation surface throws
    // LiteClockDisposedError and frame()/frame.peek() return the frozen simTime.
    const c = createClock();
    c.advance(10);
    c.dispose();
    assert.throws(() => c.lane({ duration: 5 }), LiteClockDisposedError);
    assert.throws(() => c.advance(1), LiteClockDisposedError);
    assert.throws(() => c.advanceTo(20), LiteClockDisposedError);
    assert.throws(() => c.attachInterval(100), LiteClockDisposedError);
    assert.throws(() => c.frame.subscribe(() => {}), LiteClockDisposedError);
    assert.equal(typeof c.frame(), "number");
    assert.equal(c.frame(), 10);                  // frozen simTime, never undefined
    assert.equal(typeof c.frame.peek(), "number");
    assert.equal(c.frame.peek(), 10);
});

test("dispose: C-08 -- terminal; simTime/ticks freeze, not reset", () => {
    // Fail-before (pre-K2 1.0.2): the d.ts claimed dispose() reset the counters;
    // the code always froze them. The d.ts is corrected to terminal semantics.
    const c = createClock();
    c.advance(5);
    c.advance(3);
    c.dispose();
    assert.equal(c.simTime, 8);                   // frozen at last value
    assert.equal(c.ticks, 2);
});
