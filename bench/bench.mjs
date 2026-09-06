// @zakkster/lite-clock -- benchmark harness
//
// Run with:    node --expose-gc bench/bench.mjs
//
// Eight scenarios spanning the hot paths a real consumer hits:
//   1. idle-advance         no active lanes; pure framing overhead per tick
//   2. active-lanes-1k      1000 active lanes; SOA compaction at scale
//   3. lane-reads           position/t/done reads inside an effect (reactive path)
//   4. alloc-dispose-churn  pool reuse via lane()/dispose() cycles
//   5. completion-fanout    many lanes completing in the same tick + onComplete
//   6. attach-interval-once  one-time cost (sanity for the attach helpers)
//   7. loop-cycle-100       100 loop lanes each completing a cycle per tick
//                            (isolates the 1.3.0 completion-arm carry branch)
//   8. snapshot-1024        per-frame state capture into a caller buffer
//                            (isolates the 1.4.0 rollback-consumer hot call)
//
// Methodology:
//   - Warm-up phase runs the hot path long enough for V8 to optimize.
//   - Measured phase runs a fixed iteration count, sandwiched in gc()+memoryUsage()
//     to compute per-op retention.
//   - Negative retention is normal (V8 reclaims warm-up working set during the
//     measured window).

import { readFileSync } from "node:fs";
import { createClock } from "../Clock.js";
import { effect } from "@zakkster/lite-signal";

if (typeof globalThis.gc !== "function") {
    console.error("ERROR: run with --expose-gc, e.g. `node --expose-gc bench/bench.mjs`");
    process.exit(1);
}

const NS_PER_S = 1e9;

function measure(name, opsPerIter, iter, fn) {
    // Warm-up
    for (let i = 0; i < Math.min(iter, 1000); i++) fn();
    globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iter; i++) fn();
    const t1 = process.hrtime.bigint();
    globalThis.gc();
    const after = process.memoryUsage().heapUsed;

    const ns = Number(t1 - t0);
    const totalOps = opsPerIter * iter;
    const opsPerSec = (totalOps * NS_PER_S) / ns;
    const retained = after - before;
    const perOp = retained / totalOps;

    const fmtOps =
        opsPerSec >= 1e6 ? (opsPerSec / 1e6).toFixed(2) + "M ops/s"
        : opsPerSec >= 1e3 ? (opsPerSec / 1e3).toFixed(2) + "K ops/s"
        : opsPerSec.toFixed(0) + " ops/s";

    const fmtBytes =
        Math.abs(retained) < 1024 ? retained + " B"
        : Math.abs(retained) < 1024 * 1024 ? (retained / 1024).toFixed(2) + " KB"
        : (retained / 1024 / 1024).toFixed(2) + " MB";

    console.log(
        "  " + name.padEnd(40) + " " + fmtOps.padStart(18) +
        "   retained: " + fmtBytes.padStart(10) +
        "   (" + perOp.toFixed(4) + " B/op)"
    );
}

const PKG_VERSION = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url))
).version;
console.log(
    "\n@zakkster/lite-clock " + PKG_VERSION +
    " | node " + process.version +
    " | " + process.platform + "-" + process.arch +
    " | bench (--expose-gc)\n"
);

// ---------------------------------------------------------------------------
// 1. idle-advance: clock with no active lanes
// ---------------------------------------------------------------------------
{
    const c = createClock();
    measure("idle-advance", 1, 1_000_000, () => { c.advance(0.001); });
    c.dispose();
}

// ---------------------------------------------------------------------------
// 2. active-lanes-1k: 1000 active lanes; one advance call processes all
// ---------------------------------------------------------------------------
{
    const c = createClock({ capacity: 1024 });
    for (let i = 0; i < 1000; i++) {
        const l = c.lane({ duration: 1e9 });
        l.start();
    }
    measure("active-lanes-1k", 1000, 10_000, () => { c.advance(0.001); });
    c.dispose();
}

// ---------------------------------------------------------------------------
// 3. lane-reads: position/t/done inside an effect; one tick + 3 tracked reads
// ---------------------------------------------------------------------------
{
    const c = createClock();
    const l = c.lane({ duration: 1e9 });
    l.start();
    let _p = 0, _t = 0, _d = false;
    const stop = effect(() => {
        _p = l.position();
        _t = l.t();
        _d = l.done();
    });
    measure("lane-reads-tracked", 1, 1_000_000, () => { c.advance(0.001); });
    stop();
    c.dispose();
    // Reference the captured values so V8 cannot dead-store the effect body.
    if (_p === Infinity && _t === Infinity && _d === true) console.log("");
}

// ---------------------------------------------------------------------------
// 4. alloc-dispose-churn: pool reuse
// ---------------------------------------------------------------------------
{
    const c = createClock({ capacity: 256 });
    measure("alloc-dispose-churn", 1, 200_000, () => {
        const l = c.lane({ duration: 100 });
        l.start();
        l.dispose();
    });
    c.dispose();
}

// ---------------------------------------------------------------------------
// 5. completion-fanout: 100 lanes all completing the same tick + onComplete
// ---------------------------------------------------------------------------
{
    let completed = 0;
    const onDone = () => { completed = (completed + 1) | 0; };
    measure("completion-fanout-100", 100, 5_000, () => {
        // Rebuild the clock INSIDE the iteration: a dead clock now throws
        // LiteClockDisposedError, so a shared clock disposed each iter can no
        // longer be reused (it relied on the C-06 zombie bug). The scenario
        // always intended a fresh small clock per iter.
        const c = createClock({ capacity: 128 });
        for (let i = 0; i < 100; i++) {
            const l = c.lane({ duration: 50, onComplete: onDone });
            l.start();
        }
        c.advance(100);                  // all 100 complete in one tick
        // Pool returns to baseline: lanes are still allocated until disposed.
        // Capture all current activeIDs and dispose them.
        for (let i = 0; i < 128; i++) {
            // Best-effort: try-dispose pattern via re-allocation churn.
        }
        c.dispose();
        // Note: this scenario rebuilds a small clock per iter; that's intentional
        // -- we're measuring the "burst of completions" path.
    });
}

// ---------------------------------------------------------------------------
// 6. attach-interval-once: one-time cost
// ---------------------------------------------------------------------------
{
    measure("attach-interval-once", 1, 10_000, () => {
        const c = createClock();
        c.attachInterval(1000);          // long interval so it never actually fires
        c.detach();
        c.dispose();
    });
}

// ---------------------------------------------------------------------------
// 7. loop-cycle-100: the 1.3.0 completion-arm carry branch, isolated.
// 100 loop lanes with duration 1 advanced by exactly 1.0: every advance
// completes one cycle per lane (100 carry recomputes per iter). Ten lanes
// carry a counting onComplete so the queue + generation-guarded drain cost is
// in the number too. Lanes are armed once OUTSIDE the measured fn -- unlike
// completion-fanout this cell is not createClock-dominated.
// ---------------------------------------------------------------------------
{
    let cycles = 0;
    const onCycle = () => { cycles = (cycles + 1) | 0; };
    const c = createClock({ capacity: 128 });
    for (let i = 0; i < 100; i++) {
        const l = c.lane(i < 10
            ? { duration: 1, loop: true, onComplete: onCycle }
            : { duration: 1, loop: true });
        l.start();
    }
    measure("loop-cycle-100", 100, 10_000, () => { c.advance(1.0); });
    c.dispose();
    // Reference the counter so V8 cannot dead-store the callbacks.
    if (cycles === -1) console.log("");
}

// ---------------------------------------------------------------------------
// 8. snapshot-1024: the 1.4.0 rollback-consumer hot call, isolated.
// Default-capacity clock with mixed live lanes (150 one-shot + 50 loop, so
// both lazy slab pairs are materialized and all ten slabs are honestly
// copied). The buffer is preallocated OUTSIDE the measured fn -- the per-frame
// consumer pattern snapshot() is designed for. Zero allocation per call.
// ---------------------------------------------------------------------------
{
    const c = createClock({ capacity: 1024 });
    for (let i = 0; i < 200; i++) {
        const l = c.lane(i < 50
            ? { duration: 1, loop: true }
            : { duration: 1e9 });
        l.start();
    }
    c.advance(0.5);
    const buf = new Uint8Array(c.snapshotSize());
    measure("snapshot-1024", 1, 50_000, () => { c.snapshot(buf); });
    c.dispose();
}

console.log("");
