// 02-advance.test.mjs
// advance(dt) semantics: validation, simTime accumulation, tick counter,
// dt=0 still ticks, frame signal force-propagation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";
import { createClock } from "../Clock.js";

test("advance: simTime accumulates monotonically", () => {
    const c = createClock();
    c.advance(10);
    assert.equal(c.simTime, 10);
    c.advance(15);
    assert.equal(c.simTime, 25);
    c.advance(0.5);
    assert.equal(c.simTime, 25.5);
});

test("advance: tick counter increments per call", () => {
    const c = createClock();
    c.advance(1);
    c.advance(1);
    c.advance(1);
    assert.equal(c.ticks, 3);
});

test("advance: dt=0 still increments tick counter and propagates frame", () => {
    const c = createClock();
    let fires = 0;
    c.frame.subscribe(() => fires++); // fires once immediately + per advance
    const initial = fires;
    c.advance(0);
    assert.equal(c.ticks, 1);
    assert.equal(c.simTime, 0);
    assert.equal(fires, initial + 1);
});

test("advance: rejects non-finite dt", () => {
    const c = createClock();
    assert.throws(() => c.advance(NaN),       RangeError);
    assert.throws(() => c.advance(Infinity),  RangeError);
    assert.throws(() => c.advance(-Infinity), RangeError);
});

test("advance: rejects negative dt", () => {
    const c = createClock();
    assert.throws(() => c.advance(-1), RangeError);
    assert.throws(() => c.advance(-0.001), RangeError);
});

test("advance: rejects non-number dt", () => {
    const c = createClock();
    assert.throws(() => c.advance("16.67"), RangeError);
    assert.throws(() => c.advance(null),    RangeError);
});

test("advanceTo: advances to absolute simTime", () => {
    const c = createClock();
    c.advance(10);
    c.advanceTo(50);
    assert.equal(c.simTime, 50);
});

test("advanceTo: rejects t < simTime", () => {
    const c = createClock();
    c.advance(100);
    assert.throws(() => c.advanceTo(50), RangeError);
});

test("advanceTo: rejects non-finite t", () => {
    const c = createClock();
    assert.throws(() => c.advanceTo(NaN), RangeError);
    assert.throws(() => c.advanceTo(Infinity), RangeError);
});

test("advanceTo: t === simTime is a no-op (dt=0)", () => {
    const c = createClock();
    c.advance(50);
    c.advanceTo(50);
    assert.equal(c.simTime, 50);
    assert.equal(c.ticks, 2); // 1 from advance, 1 from advanceTo(50) -> advance(0)
});

test("advance: frame signal carries simTime", () => {
    const c = createClock();
    let observed = -1;
    const dispose = effect(() => { observed = c.frame(); });
    assert.equal(observed, 0);
    c.advance(16.67);
    assert.equal(observed, 16.67);
    c.advance(33.33);
    assert.equal(observed, 50);
    dispose();
});

test("advance: frame.peek does not establish dependency", () => {
    const c = createClock();
    let runs = 0;
    const dispose = effect(() => {
        runs++;
        c.frame.peek();
    });
    assert.equal(runs, 1);
    c.advance(1);
    assert.equal(runs, 1); // peek did not subscribe
    dispose();
});

test("advance: frame signal force-propagates even when simTime repeats", () => {
    // After dt=0 calls, simTime is unchanged, but subscribers must still fire.
    // (Force-propagate via equals: () => false.)
    const c = createClock();
    let fires = 0;
    const unsub = c.frame.subscribe(() => { fires++; });
    const baseline = fires;
    c.advance(0);
    c.advance(0);
    c.advance(0);
    assert.equal(fires, baseline + 3);
    unsub();
});
