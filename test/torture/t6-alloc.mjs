// test/torture/t6-alloc.mjs -- the zero-alloc gc gate (GATING).
// Four measured loops, run SEQUENTIALLY (one GcProfiler in flight at a time).
// Each: fresh profiler, warmup, periodic heap sampling, awaited settle,
// summary, checkNoGc. verdict !== pass (including inconclusive) is a failure.
//
// NOTE on ArrayBuffers: settling the ArrayBuffers channel requires
// forceSettle() (two global.gc() calls -- majors), which cannot coexist with
// maxMajor: 0 in one window. The two budgets are therefore gated in two
// sequential measurements over the same workload.

import { assertOps } from "@zakkster/lite-gc-profiler";
import { createClock } from "../../Clock.js";
import { measure, heapSample, assertPass, assert, assertEq, checkNoGc } from "./harness.mjs";

const HOT = 200000;
const WARM = 2000;

// ---- advance-1k: 1024 long-duration active lanes, 200000 advance calls -----
async function gateAdvance1k() {
    const CAP = 1024;
    const c = createClock({ capacity: CAP });
    for (let i = 0; i < CAP; i = (i + 1) | 0) {
        const l = c.lane({ duration: 1e12 });         // never completes in-window
        l.start();
    }
    for (let i = 0; i < WARM; i = (i + 1) | 0) c.advance(0.001);

    const sGc = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            c.advance(0.001);
            if ((i & 8191) === 0) heapSample(gc, false);
        }
    });
    assertPass(sGc, { maxMajor: 0, maxPauseMs: 4 }, "t6 advance-1k gc");

    const sAb = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            c.advance(0.001);
            if ((i & 8191) === 0) heapSample(gc, true);
        }
    });
    assertPass(sAb, { maxArrayBuffersGrowth: 0 }, "t6 advance-1k arrayBuffers");

    assertEq(c.capacity, 1024, "t6 advance-1k capacity stable");
    console.log("t6 advance-1k: pass (major=" + sGc.gc.major
        + " maxMs=" + sGc.gc.maxMs.toFixed(2)
        + " abGrowth=" + sAb.arrayBuffers.growthBytes + ")");
}

// ---- tracked-reads: one effect reading position()+t()+done() ---------------
async function gateTrackedReads() {
    const { effect } = await import("@zakkster/lite-signal");
    const c = createClock();
    const l = c.lane({ duration: 1e12 });
    l.start();
    let sink = 0;
    const stop = effect(function () { sink = sink + l.position() + l.t() + (l.done() ? 1 : 0); });

    for (let i = 0; i < WARM; i = (i + 1) | 0) c.advance(0.001);

    const sGc = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            c.advance(0.001);
            if ((i & 8191) === 0) heapSample(gc, false);
        }
    });
    assertPass(sGc, { maxMajor: 0, maxPauseMs: 4 }, "t6 tracked-reads gc");

    const sAb = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            c.advance(0.001);
            if ((i & 8191) === 0) heapSample(gc, true);
        }
    });
    assertPass(sAb, { maxArrayBuffersGrowth: 0 }, "t6 tracked-reads arrayBuffers");

    // Catastrophic-regression tripwire ONLY: floor the tracked-read throughput
    // far below the observed ~10.8M ops/s. The tight within-noise proof lives in
    // the CHANGELOG bench tables; this trips only on a catastrophic read-path
    // regression. checkOps has no ops/s rule key (unknown keys throw), so gate
    // the maxBytesPerOp lane generously (allowInconclusive absorbs stabilize
    // bracket noise) and assert the returned opsPerSec against the 3M floor.
    const opsReport = assertOps(
        function () { c.advance(0.001); },
        { maxBytesPerOp: 4096 },
        { ops: HOT, warmup: WARM, allowInconclusive: true }
    );
    assert(opsReport.opsPerSec >= 3e6, function () {
        return "t6 tracked-reads ops/s below catastrophic floor: "
            + Math.round(opsReport.opsPerSec) + " < 3000000";
    });

    stop();
    if (sink < 0) console.log("unreachable " + sink);   // keep sink live
    console.log("t6 tracked-reads: pass (major=" + sGc.gc.major
        + " maxMs=" + sGc.gc.maxMs.toFixed(2)
        + " abGrowth=" + sAb.arrayBuffers.growthBytes
        + " opsPerSec=" + (opsReport.opsPerSec / 1e6).toFixed(2) + "M)");
}

// ---- completion-fanout: arm 100 lanes, one advance completes them all ------
async function gateCompletionFanout() {
    const FAN = 100;
    const ITERS = 2000;
    const c = createClock({ capacity: 128 });
    let fires = 0;
    const onDone = function () { fires = (fires + 1) | 0; };
    const handles = new Array(FAN);

    function iterate() {
        for (let k = 0; k < FAN; k = (k + 1) | 0) {
            const l = c.lane({ duration: 1, onComplete: onDone });
            l.start();
            handles[k] = l;
        }
        c.advance(2);                                   // completes + drains all 100
        for (let k = 0; k < FAN; k = (k + 1) | 0) handles[k].dispose();
    }

    for (let w = 0; w < 20; w = (w + 1) | 0) iterate();  // warmup

    const s = await measure(function (gc) {
        for (let i = 0; i < ITERS; i = (i + 1) | 0) {
            iterate();
            if ((i & 255) === 0) heapSample(gc, false);
        }
    });
    // Handle allocation is documented -- gate majors, not ArrayBuffers here.
    assertPass(s, { maxMajor: 0, maxPauseMs: 4 }, "t6 completion-fanout");
    if (fires < 0) console.log("unreachable " + fires);
    console.log("t6 completion-fanout: pass (major=" + s.gc.major
        + " minor=" + s.gc.minor + " maxMs=" + s.gc.maxMs.toFixed(2) + ")");
}

// ---- alloc-dispose-churn: 200000 lane()/dispose() cycles -------------------
async function gateAllocDisposeChurn() {
    const c = createClock();
    for (let i = 0; i < WARM; i = (i + 1) | 0) { const l = c.lane({ duration: 1000 }); l.dispose(); }

    // Preallocated stats sink: stats(out) must fill it with zero allocation.
    const out = {};
    const s = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            const l = c.lane({ duration: 1000 });
            l.seek(500);            // authored edit -- cold, zero-alloc
            l.restart();            // seek(0) + start -- cold, zero-alloc
            c.stats(out);           // fill the sink in place -- zero-alloc
            l.dispose();
            if ((i & 8191) === 0) heapSample(gc, false);
        }
    });
    assertPass(s, { maxMajor: 0, maxPauseMs: 4 }, "t6 alloc-dispose-churn");
    assertEq(c.activeCount, 0, "t6 alloc-dispose-churn activeCount");
    console.log("t6 alloc-dispose-churn: pass (major=" + s.gc.major
        + " minor=" + s.gc.minor + " maxMs=" + s.gc.maxMs.toFixed(2) + ")");
}

export async function run() {
    await gateAdvance1k();
    await gateTrackedReads();
    await gateCompletionFanout();
    await gateAllocDisposeChurn();
}

// ---- control: allocating advance-1k that MUST trip maxMajor: 0 -------------
export async function runControlAlloc() {
    const CAP = 1024;
    const c = createClock({ capacity: CAP });
    for (let i = 0; i < CAP; i = (i + 1) | 0) {
        const l = c.lane({ duration: 1e12 });
        l.start();
    }
    const retained = [];
    const s = await measure(function (gc) {
        for (let i = 0; i < HOT; i = (i + 1) | 0) {
            c.advance(0.001);
            // Retain ~2e6 objects to force major collections inside the window.
            for (let k = 0; k < 10; k = (k + 1) | 0) retained.push({ t: i, k: k });
            if ((i & 8191) === 0) heapSample(gc, false);
        }
    });
    if (retained.length < 0) console.log("unreachable " + retained.length);
    const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
    if (report.verdict !== "pass") {
        console.error("[control alloc] gate tripped as expected: verdict=" + report.verdict
            + " major=" + s.gc.major);
        process.exit(1);
    }
    console.error("[control alloc] gate did NOT trip (major=" + s.gc.major + ") -- decorative");
    process.exit(0);
}
