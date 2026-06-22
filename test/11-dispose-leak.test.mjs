// 11-dispose-leak.test.mjs
// Regression: createClock()/clock.dispose() cycles must NOT leak nodes from
// the @zakkster/lite-signal default registry. Pre-fix this would hit
// `CapacityError: nodes capacity (1024) exceeded` at the 1024th cycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createClock } from "../Clock.js";

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
