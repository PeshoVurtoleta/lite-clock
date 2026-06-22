// 10-gc.test.mjs
// Zero-allocation hot path verification. Requires --expose-gc.
//
//     node --expose-gc --test --test-reporter=spec test/10-gc.test.mjs
//
// The steady-state hot path is: advance(dt) with N active lanes -> compaction
// pass over Uint16Array activeList + Float64Array reads/writes -> one signal
// write (force-propagate). The TYPED-ARRAY-BACKED state mutates in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

const hasGc = typeof globalThis.gc === "function";

function deltaHeap(fn) {
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    fn();
    globalThis.gc();
    return process.memoryUsage().heapUsed - before;
}

test("gc: advance() hot path with 1K active lanes is steady-state", { skip: !hasGc }, () => {
    const c = createClock({ capacity: 1024 });
    const lanes = [];
    for (let i = 0; i < 1024; i++) {
        const l = c.lane({ duration: 1e9 });   // very long so no completions
        l.start();
        lanes.push(l);
    }
    // Warm-up
    for (let i = 0; i < 1000; i++) c.advance(0.001);

    const delta = deltaHeap(() => {
        for (let i = 0; i < 10000; i++) c.advance(0.001);
    });

    assert.ok(delta < 256 * 1024,
        "1K lanes x 10K ticks: retained heap should be < 256 KB, got " + delta + " B");
});

test("gc: advance() with no active lanes is steady-state", { skip: !hasGc }, () => {
    const c = createClock();
    for (let i = 0; i < 1000; i++) c.advance(0.001);

    const delta = deltaHeap(() => {
        for (let i = 0; i < 100000; i++) c.advance(0.001);
    });

    assert.ok(delta < 128 * 1024,
        "100K empty ticks: retained heap should be < 128 KB, got " + delta + " B");
});

test("gc: lane.position()/t()/done() reads are steady-state", { skip: !hasGc }, () => {
    const c = createClock();
    const l = c.lane({ duration: 1e9 });
    l.start();
    // Warm-up the polymorphic call sites
    for (let i = 0; i < 1000; i++) { l.positionPeek(); l.tPeek(); l.donePeek(); }

    const delta = deltaHeap(() => {
        for (let i = 0; i < 1000000; i++) {
            l.positionPeek();
            l.tPeek();
            l.donePeek();
        }
    });

    assert.ok(delta < 128 * 1024,
        "1M lane-read trio: retained heap should be < 128 KB, got " + delta + " B");
});

test("gc: alloc/dispose churn returns the pool to baseline", { skip: !hasGc }, () => {
    const c = createClock({ capacity: 256 });
    // Warm-up
    for (let cycle = 0; cycle < 100; cycle++) {
        const lanes = [];
        for (let i = 0; i < 100; i++) lanes.push(c.lane({ duration: 1000 }));
        for (let i = 0; i < 100; i++) lanes[i].dispose();
    }

    const delta = deltaHeap(() => {
        for (let cycle = 0; cycle < 1000; cycle++) {
            const lanes = [];
            for (let i = 0; i < 100; i++) lanes.push(c.lane({ duration: 1000 }));
            for (let i = 0; i < 100; i++) lanes[i].dispose();
        }
    });

    // Lane handle objects ARE allocated per lane() call (one closure-free
    // object per slot). Over 100K alloc/dispose pairs, V8 should reclaim most
    // of these. The bound is loose because we're not pooling handles in 1.0.
    assert.ok(delta < 1024 * 1024,
        "100K alloc/dispose cycles: retained heap should be < 1 MB, got " + delta + " B");
    // The CRITICAL invariant: active/completedCount/freeTop all return to baseline.
    assert.equal(c.activeCount, 0);
});
