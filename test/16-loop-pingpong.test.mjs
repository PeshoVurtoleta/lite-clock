// 16-loop-pingpong.test.mjs
// loop/pingPong lanes: never DONE, once-per-cycle onComplete (incl. multi-cycle
// dts), t() cycles in [0,1). Type-strict boolean options, mutually exclusive,
// pinned validation order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

test("loop: never done() across many cycles", () => {
    const c = createClock();
    const l = c.lane({ duration: 10, loop: true });
    l.start();
    for (let i = 0; i < 50; i = (i + 1) | 0) {
        c.advance(3);
        assert.equal(l.donePeek(), false);
        assert.equal(l.done(), false);
    }
});

test("loop: t() stays in [0,1) -- duration 10, dt 3 over 50 advances", () => {
    const c = createClock();
    const l = c.lane({ duration: 10, loop: true });
    l.start();
    for (let i = 0; i < 50; i = (i + 1) | 0) {
        c.advance(3);
        const t = l.tPeek();
        assert.equal(t >= 0 && t < 1, true, "t out of [0,1): " + t);
    }
});

test("loop: onComplete fires once per completed cycle across a multi-cycle dt", () => {
    const c = createClock();
    let fires = 0;
    const l = c.lane({ duration: 10, loop: true, onComplete: () => { fires = (fires + 1) | 0; } });
    l.start();
    c.advance(35);                               // 3 cycles + 5 into the 4th
    assert.equal(fires, 3);
    assert.equal(l.positionPeek(), 5);
});

test("loop: activeCount stable across 1000 cycles", () => {
    const c = createClock();
    const l = c.lane({ duration: 10, loop: true });
    l.start();
    const active = c.activeCount;
    for (let i = 0; i < 1000; i = (i + 1) | 0) c.advance(10);
    assert.equal(c.activeCount, active);
    assert.equal(l.donePeek(), false);
});

test("pingPong: reported tPeek runs 0->1 then 1->0 (triangle)", () => {
    const c = createClock();
    const l = c.lane({ duration: 10, pingPong: true });
    l.start();
    c.advance(4); const t1 = l.tPeek();          // ascending
    c.advance(4); const t2 = l.tPeek();          // ascending
    c.advance(4); const t3 = l.tPeek();          // past the peak: descending
    c.advance(4); const t4 = l.tPeek();          // descending
    assert.equal(t2 > t1, true, "ascending phase");
    assert.equal(t4 < t3, true, "descending phase");
    assert.equal(l.donePeek(), false);
});

test("loop+pingPong both true throws the mutual-exclusion TypeError", () => {
    const c = createClock();
    assert.throws(
        () => c.lane({ duration: 10, loop: true, pingPong: true }),
        (e) => e instanceof TypeError
            && e.message === "clock.lane: loop and pingPong are mutually exclusive"
    );
});

test("loop/pingPong non-boolean throws TypeError naming the received type", () => {
    const c = createClock();
    assert.throws(
        () => c.lane({ duration: 10, loop: "yes" }),
        (e) => e instanceof TypeError && /loop must be a boolean \(got string\)/.test(e.message)
    );
    assert.throws(
        () => c.lane({ duration: 10, pingPong: 1 }),
        (e) => e instanceof TypeError && /pingPong must be a boolean \(got number\)/.test(e.message)
    );
    assert.throws(
        () => c.lane({ duration: 10, loop: null }),
        (e) => e instanceof TypeError && /loop must be a boolean \(got null\)/.test(e.message)
    );
});

test("loop typo 'lop' throws did-you-mean", () => {
    const c = createClock();
    assert.throws(
        () => c.lane({ duration: 10, lop: true }),
        (e) => e instanceof TypeError && /did you mean 'loop'\?/.test(e.message)
    );
});

test("validation order: bad duration beats bad loop", () => {
    const c = createClock();
    // duration NaN and loop non-boolean both invalid: duration (RangeError) wins.
    assert.throws(
        () => c.lane({ duration: NaN, loop: "yes" }),
        (e) => e instanceof RangeError
    );
});

test("validation order: bad loop beats mutual-exclusion", () => {
    const c = createClock();
    // loop non-boolean AND pingPong true: the loop boolean check fires first.
    assert.throws(
        () => c.lane({ duration: 10, loop: "yes", pingPong: true }),
        (e) => e instanceof TypeError && /loop must be a boolean/.test(e.message)
    );
});

test("loop carry survives pool growth (lazy carry arrays copy-grow)", () => {
    // The carry arrays materialize on the first cycling lane and copy-grow with
    // the pool. A loop lane mid-cycle before growth must keep its exact
    // trajectory after growth relocates every SOA array.
    const c = createClock({ capacity: 2, growable: true });
    const l = c.lane({ duration: 10, loop: true });
    l.start();
    c.advance(23);                       // k=2, in-cycle position 3
    assert.equal(l.positionPeek(), 3);

    // Exhaust and grow: 2 -> 4 (the third lane triggers ensureCapacity).
    const a = c.lane({ duration: 1e9 });
    const b = c.lane({ duration: 1e9 });
    assert.equal(c.capacity, 4);

    // Post-growth the carry is intact: same lane, same cycle math, bit-exact
    // against a fresh single-advance oracle clock.
    c.advance(14);                       // total 37: k=3, in-cycle position 7
    assert.equal(l.positionPeek(), 7);
    const oc = createClock();
    const ol = oc.lane({ duration: 10, loop: true });
    ol.start();
    oc.advance(37);
    assert.equal(l.positionPeek(), ol.positionPeek());
    assert.equal(l.donePeek(), false);
    a.dispose(); b.dispose(); l.dispose(); c.dispose(); oc.dispose();
});

test("growth before any cycling lane leaves carry arrays lazy, then materializes at grown capacity", () => {
    const c = createClock({ capacity: 2, growable: true });
    const p1 = c.lane({ duration: 1e9 });
    const p2 = c.lane({ duration: 1e9 });
    const p3 = c.lane({ duration: 1e9 });   // grows 2 -> 4 with carry arrays still null
    assert.equal(c.capacity, 4);
    // First cycling lane AFTER growth materializes at the grown capacity and
    // behaves identically to a loop lane on a fresh clock.
    const l = c.lane({ duration: 5, loop: true });
    l.start();
    c.advance(12);                       // k=2, in-cycle position 2
    assert.equal(l.positionPeek(), 2);
    assert.equal(l.donePeek(), false);
    p1.dispose(); p2.dispose(); p3.dispose(); l.dispose(); c.dispose();
});
