// test/torture/t7-soak.mjs -- lite-leak soak + conservation (GATING).
// Phase 1: 4096 create/use/dispose clock cycles tracked by lite-leak; the
// tracker's size() must return to 0 (retention census). Phase 2: 4096 lane
// churn cycles on one clock; the section-2 conservation invariant holds and
// activeCount returns to 0.
//
// Held-value contract: neither the cleanup closure nor the tag may close over
// the tracked clock. `sharedNoopCleanup` and the string tag capture nothing.

import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createTimerOrphanKernel,
    createListenerOrphanKernel,
    createObserverOrphanKernel,
    createAsyncRetentionKernel
} from "@zakkster/lite-leak";
import { createRoot, effect } from "@zakkster/lite-signal";
import { createClock } from "../../Clock.js";
import { assert, assertEq, settle } from "./harness.mjs";

const CYCLES = 4096;

// The leak control retains UNdisposed clocks, so each keeps its lite-signal
// frame node checked out of the default registry (node-pool ceiling 1024).
// Stay safely below that ceiling: the loop must run to completion so the
// tracker.size() census actually executes -- the point of the control -- rather
// than dying on a CapacityError from an exhausted signal pool before the gate.
const CONTROL_LEAK_CYCLES = 512;

// Detached cleanup -- captures no target. Reused for every track() call.
function sharedNoopCleanup() {}

// Module-level sink so the leak control's clocks survive collection.
const RETAINED = [];

function registerKernels(tracker) {
    tracker.registerKernel(createOwnerCascadeOrphanKernel());
    tracker.registerKernel(createTimerOrphanKernel());
    tracker.registerKernel(createListenerOrphanKernel());
    tracker.registerKernel(createObserverOrphanKernel());
    tracker.registerKernel(createAsyncRetentionKernel());
}

async function drainToZero(tracker, tries) {
    for (let i = 0; i < tries; i = (i + 1) | 0) {
        globalThis.gc();
        await settle(50);
        if (tracker.size() === 0) return true;
    }
    return tracker.size() === 0;
}

export async function run() {
    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: "t7-soak",
        onLeak: function (r) { leaks.push(r.kind + ":" + String(r.tag)); },
        onWarning: function (w) { warns.push({ kind: w.kind, reason: w.reason }); }
    });
    registerKernels(tracker);

    // ---- phase 1: retention census over create/dispose cycles -------------
    // track() inside an effect auto-registers onCleanup(untrack); disposing the
    // root untracks cleanly (size drains via untrack, the FR never fires), which
    // is the template's shape. The cleanup and tag close over nothing.
    for (let i = 0; i < CYCLES; i = (i + 1) | 0) {
        const dispose = createRoot(function () {
            // effect() returns its own disposer; createRoot returns it upward.
            return effect(function () {
                const c = createClock({ capacity: 64 });
                const a = c.lane({ duration: 100 });
                a.start();
                c.advance(10);
                const b = c.lane({ duration: 50, onComplete: sharedNoopCleanup });
                b.start();
                c.advance(20);
                c.dispose();
                tracker.track(c, sharedNoopCleanup, "clock", { audit: true });
            });
        });
        dispose();
    }

    const drained = await drainToZero(tracker, 10);
    const live = tracker.size();
    const findings = tracker.audit();
    assert(drained && live === 0, function () { return "t7 phase1 tracker.size()=" + live; });
    assertEq(findings.length, 0, function () {
        return "t7 phase1 findings=" + findings.map(function (f) { return f.kind; }).join(",");
    });
    assertEq(leaks.length, 0, function () { return "t7 phase1 leaks=" + leaks.join(","); });

    // The harness's own settle() setTimeout is flagged timer-orphan:no-owner-set
    // by the timer kernel (it is set outside any owner) -- the one known,
    // expected warning. Fail closed on any OTHER warning.
    const unexpectedWarns = warns.filter(function (w) {
        return !(w.kind === "timer-orphan" && w.reason === "no-owner-set");
    });
    assertEq(unexpectedWarns.length, 0, function () {
        return "t7 unexpected warnings=" + unexpectedWarns.map(function (w) { return w.kind + ":" + w.reason; }).join(",");
    });

    // ---- phase 2: lane churn conservation on one clock --------------------
    const c2 = createClock({ capacity: 64 });
    for (let i = 0; i < CYCLES; i = (i + 1) | 0) {
        const l = c2.lane({ duration: 100 });
        l.start();
        c2.advance(10);
        l.dispose();
    }
    assert(c2._invariant() === null, function () { return "t7 phase2 invariant: " + c2._invariant(); });
    assertEq(c2.activeCount, 0, "t7 phase2 activeCount");

    // ---- phase 3: single-slot generation monotonicity (K2) ----------------
    // Churn ONE slot 100K times on a capacity-1 clock: each lane/start/dispose
    // reuses slot 0 and bumps its Uint32 generation. The handle captured on
    // cycle 0 must stay inert (reads 0/0/false, methods no-op) for the whole
    // churn -- it can never observe or drive a later tenant. The conservation
    // invariant is sampled every 10000 cycles and at the end.
    const c3 = createClock({ capacity: 1 });
    const first = c3.lane({ duration: 100 });          // cycle-0 handle
    first.start();
    c3.advance(10);
    first.dispose();                                    // stale forever after here
    const SLOT_CYCLES = 100000;
    for (let i = 0; i < SLOT_CYCLES; i = (i + 1) | 0) {
        const l = c3.lane({ duration: 100 });          // reuses slot 0
        l.start();
        c3.advance(10);
        assert(first.positionPeek() === 0 && first.tPeek() === 0 && first.donePeek() === false,
            function () { return "t7 phase3 cycle-0 handle observed a later tenant at i=" + i; });
        first.start();                                  // no-op on the live tenant
        first.pause();
        first.reverse();
        assertEq(l.positionPeek(), 10, "t7 phase3 tenant untouched by stale calls");
        l.dispose();
        if ((i % 10000) === 0) {
            assert(c3._invariant() === null, function () { return "t7 phase3 invariant at i=" + i + ": " + c3._invariant(); });
        }
    }
    assert(c3._invariant() === null, function () { return "t7 phase3 final invariant: " + c3._invariant(); });
    assert(first.positionPeek() === 0 && first.tPeek() === 0 && first.donePeek() === false,
        "t7 phase3 cycle-0 handle inert at end");
    assertEq(c3.activeCount, 0, "t7 phase3 activeCount");

    console.log("t7 soak: pass (size=" + live + "/0 findings=" + findings.length
        + " warnings=" + warns.length + "(" + unexpectedWarns.length + " unexpected)"
        + " leaks=" + leaks.length + ")");

    return { leakSize: live, findings: findings.length, warnings: unexpectedWarns.length, leaks: leaks.length };
}

// ---- control: retained undisposed clocks MUST keep tracker.size() > 0 ------
export async function runControlLeak() {
    const tracker = createLeakTracker({ name: "t7-control" });
    registerKernels(tracker);
    // CONTROL_LEAK_CYCLES stays below the 1024 lite-signal node-pool ceiling so
    // the loop completes and the census below actually runs.
    for (let i = 0; i < CONTROL_LEAK_CYCLES; i = (i + 1) | 0) {
        const c = createClock({ capacity: 64 });
        RETAINED.push(c);                                 // never disposed, retained
        tracker.track(c, sharedNoopCleanup, "leaked-clock", { audit: true });
    }
    globalThis.gc();
    await settle(50);
    const live = tracker.size();
    if (live !== 0) {
        console.error("[control leak] tracker.size()=" + live + " (retention detected as expected)");
        process.exit(1);
    }
    console.error("[control leak] tracker.size()=0 (gate blind to retained clocks) -- decorative");
    process.exit(0);
}
