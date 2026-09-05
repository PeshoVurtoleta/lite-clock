// 14-timescale.test.mjs
// Clock-wide timeScale accessor: scales advance() dts once at entry, leaves
// advanceTo() absolute/unscaled, 0 is a true freeze. Getter is a read surface
// (never throws, frozen after dispose); the setter fails closed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, LiteClockDisposedError } from "../Clock.js";

test("timescale: default is 1", () => {
    const c = createClock();
    assert.equal(c.timeScale, 1);
});

// timeScale 0.5 over doubled dts is bit-exact vs 1.0 over the plain dts. The
// doubling and halving are exact (powers of two), so sdt matches to the bit.
test("timescale: 0.5 over doubled dts == 1.0 over plain dts (bit-exact)", () => {
    const dts = [0.5, 2, 10, 0.25, 1];
    const a = createClock();
    a.timeScale = 0.5;
    const la = a.lane({ duration: 10 });
    la.start();
    const b = createClock();
    const lb = b.lane({ duration: 10 });
    lb.start();
    for (let i = 0; i < dts.length; i = (i + 1) | 0) {
        a.advance(dts[i] * 2);
        b.advance(dts[i]);
    }
    assert.equal(a.simTime === b.simTime, true);
    assert.equal(la.positionPeek() === lb.positionPeek(), true);
});

// timeScale 0: advance ticks + propagates the frame signal + completes nothing.
test("timescale: 0 freezes -- ticks, fires subscribers, completes nothing", () => {
    const c = createClock();
    c.timeScale = 0;
    const l = c.lane({ duration: 4 });
    l.start();
    let fires = 0;
    const stop = c.frame.subscribe(() => { fires = (fires + 1) | 0; });
    const fireBaseline = fires;                 // subscribe fires immediately
    const ticksBefore = c.ticks;
    c.advance(5);
    assert.equal(c.ticks, ticksBefore + 1);
    assert.equal(fires, fireBaseline + 1);      // subscriber observed the frozen tick
    assert.equal(c.simTime, 0);                 // no time advanced
    assert.equal(l.donePeek(), false);          // mid-flight, not completed
    assert.equal(l.positionPeek(), 0);
    stop();
});

test("timescale: advanceTo reaches its exact target at timeScale 0", () => {
    const c = createClock();
    c.timeScale = 0;
    c.advanceTo(42);
    assert.equal(c.simTime, 42);
});

test("timescale: advanceTo reaches its exact target at timeScale 2", () => {
    const c = createClock();
    c.timeScale = 2;
    c.advanceTo(42);
    assert.equal(c.simTime, 42);
});

test("timescale: getter never throws after dispose (returns last value)", () => {
    const c = createClock();
    c.timeScale = 3;
    c.dispose();
    assert.equal(c.timeScale, 3);
});

test("timescale: setter on a disposed clock throws LiteClockDisposedError", () => {
    const c = createClock();
    c.dispose();
    assert.throws(() => { c.timeScale = 2; }, LiteClockDisposedError);
});

test("timescale: setter rejects non-finite / negative / non-number with RangeError", () => {
    const c = createClock();
    assert.throws(() => { c.timeScale = NaN; }, RangeError);
    assert.throws(() => { c.timeScale = -1; }, RangeError);
    assert.throws(() => { c.timeScale = Infinity; }, RangeError);
    assert.throws(() => { c.timeScale = "1"; }, RangeError);
    assert.throws(() => { c.timeScale = null; }, RangeError);
});

// A finite dt times a finite timeScale can still overflow to Infinity: the
// overflow guard fails closed and names both operands.
test("timescale: advance(1e308) at timeScale 1e10 throws RangeError naming dt and timeScale", () => {
    const c = createClock();
    c.timeScale = 1e10;
    assert.throws(
        () => c.advance(1e308),
        (e) => e instanceof RangeError
            && /dt/.test(e.message) && /timeScale/.test(e.message)
    );
});
