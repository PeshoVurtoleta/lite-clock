// 17-stats.test.mjs
// stats(out?) -- a read surface. Fills a caller sink (zero-alloc) or allocates
// the documented convenience. Seven fields in a fixed order. peakActive is a
// high-water mark; totalCompletions counts cycles including callback-less lanes.
// Stays readable (frozen counters) after dispose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

const FIELDS = ["capacity", "peakActive", "poolFree", "poolUsed", "timeScale", "totalCompletions", "totalTicks"];

test("stats: fresh object has exactly the 7 fields with correct values", () => {
    const c = createClock({ capacity: 8 });
    const a = c.lane({ duration: 10 });
    const b = c.lane({ duration: 20 });
    a.start(); b.start();
    c.advance(10);                               // a completes, b survives
    const s = c.stats();
    assert.deepEqual(Object.keys(s).sort(), FIELDS);
    assert.equal(s.poolUsed, 2);
    assert.equal(s.poolFree, 6);
    assert.equal(s.peakActive, 2);
    assert.equal(s.totalTicks, 1);
    assert.equal(s.totalCompletions, 1);
    assert.equal(s.capacity, 8);
    assert.equal(s.timeScale, 1);
});

test("stats(out): fills and returns the SAME reference, overwriting stale fields", () => {
    const c = createClock({ capacity: 4 });
    const l = c.lane({ duration: 10 });
    l.start();
    const out = { poolUsed: 999, poolFree: 999, foreign: "keep" };
    const ret = c.stats(out);
    assert.equal(ret, out);                      // same reference
    assert.equal(out.poolUsed, 1);              // stale value overwritten
    assert.equal(out.poolFree, 3);
    assert.equal(out.foreign, "keep");          // untouched foreign key
});

test("stats: non-object out throws TypeError", () => {
    const c = createClock();
    assert.throws(() => c.stats(null), TypeError);
    assert.throws(() => c.stats(5), TypeError);
    assert.throws(() => c.stats("x"), TypeError);
});

test("stats: peakActive is a monotone high-water mark", () => {
    const c = createClock();
    const l1 = c.lane({ duration: 100 }); l1.start();
    const l2 = c.lane({ duration: 100 }); l2.start();
    const l3 = c.lane({ duration: 100 }); l3.start();
    assert.equal(c.stats().peakActive, 3);
    l2.dispose();
    l3.dispose();
    assert.equal(c.activeCount, 1);
    assert.equal(c.stats().peakActive, 3);      // high-water, not current
});

test("stats: totalCompletions counts cycles including callback-less lanes", () => {
    const c = createClock();
    const l = c.lane({ duration: 10, loop: true });   // NO onComplete
    l.start();
    c.advance(30);                              // 3 completed cycles
    assert.equal(c.stats().totalCompletions, 3);
});

test("stats: readable after dispose with frozen counters", () => {
    const c = createClock();
    c.timeScale = 2;
    const l = c.lane({ duration: 10 });
    l.start();
    c.advance(10);                              // 1 tick, 1 completion, peak 1
    const before = c.stats();
    c.dispose();
    const after = c.stats();
    assert.equal(after.totalTicks, before.totalTicks);
    assert.equal(after.totalCompletions, before.totalCompletions);
    assert.equal(after.peakActive, before.peakActive);
    assert.equal(after.timeScale, before.timeScale);
});
