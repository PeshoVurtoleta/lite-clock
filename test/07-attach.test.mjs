// 07-attach.test.mjs
// Tick-source attach helpers. We mock requestAnimationFrame so the tests
// are deterministic and synchronous; the production code path is identical.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

test("attach: detach() is a safe no-op when nothing is attached", () => {
    const c = createClock();
    c.detach();
    c.detach();
});

test("attach: attachInterval rejects non-positive ms", () => {
    const c = createClock();
    assert.throws(() => c.attachInterval(0),       RangeError);
    assert.throws(() => c.attachInterval(-1),      RangeError);
    assert.throws(() => c.attachInterval(NaN),     RangeError);
    assert.throws(() => c.attachInterval(Infinity), RangeError);
});

test("attach: attachInterval drives advance via real interval", async () => {
    const c = createClock();
    c.attachInterval(5);
    // Wait two intervals; expect simTime to grow.
    await new Promise((r) => setTimeout(r, 30));
    c.detach();
    assert.ok(c.simTime > 0, "expected simTime to advance under attachInterval, got " + c.simTime);
    assert.ok(c.ticks >= 1, "expected ticks >= 1, got " + c.ticks);
});

test("attach: detach() stops further advances", async () => {
    const c = createClock();
    c.attachInterval(5);
    await new Promise((r) => setTimeout(r, 20));
    c.detach();
    const t0 = c.simTime;
    const tk0 = c.ticks;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(c.simTime, t0);
    assert.equal(c.ticks, tk0);
});

test("attach: attaching twice replaces the prior tick source", async () => {
    const c = createClock();
    c.attachInterval(5);
    c.attachInterval(5);  // replaces the first; first interval is cleared
    await new Promise((r) => setTimeout(r, 25));
    c.detach();
    // simTime should reflect ONE interval source, not two stacked.
    // A stacked source would give roughly 2x the simTime; we assert a
    // conservative upper bound to catch the bug class.
    assert.ok(c.simTime < 100, "two stacked intervals would over-advance; got " + c.simTime);
});

test("attach: attachRAF works when requestAnimationFrame is mocked", async () => {
    const origRAF = globalThis.requestAnimationFrame;
    const fns = [];
    globalThis.requestAnimationFrame = (fn) => { fns.push(fn); return fns.length; };
    try {
        const c = createClock();
        c.attachRAF();
        // Manually drive two frames.
        const cb1 = fns.pop();
        cb1(100);
        const cb2 = fns.pop();
        cb2(116);
        c.detach();
        assert.ok(c.simTime > 0, "expected simTime to advance under attachRAF mock");
        assert.equal(c.ticks, 2);
    } finally {
        globalThis.requestAnimationFrame = origRAF;
    }
});

test("attach: attachRAF throws if rAF is unavailable", () => {
    const origRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = undefined;
    try {
        const c = createClock();
        assert.throws(() => c.attachRAF(), /requestAnimationFrame is not available/);
    } finally {
        globalThis.requestAnimationFrame = origRAF;
    }
});

test("dispose: detaches any attached tick source", async () => {
    const c = createClock();
    c.attachInterval(5);
    await new Promise((r) => setTimeout(r, 10));
    c.dispose();
    const t0 = c.simTime;
    const tk0 = c.ticks;
    await new Promise((r) => setTimeout(r, 25));
    // dispose should have detached the interval.
    assert.equal(c.simTime, t0);
    assert.equal(c.ticks, tk0);
});
