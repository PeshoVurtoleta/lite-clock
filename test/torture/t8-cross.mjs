// test/torture/t8-cross.mjs -- cross-package conformance (GATING).
// Pins the lite-signal contract the suite depends on: subscribe fires
// immediately at subscribe time, and clock.dispose() returns the frame node to
// the lite-signal pool (no CapacityError over many create/dispose cycles).

import { createClock } from "../../Clock.js";
import { assert, assertEq, assertNoThrow } from "./harness.mjs";

export async function run() {
    // ---- subscribe fires immediately with current simTime -----------------
    {
        const c = createClock();
        c.advance(7);
        let calls = 0;
        let firstVal = null;
        const unsub = c.frame.subscribe(function (v) {
            calls = (calls + 1) | 0;
            if (calls === 1) firstVal = v;
        });
        assertEq(calls, 1, "subscribe fires immediately");
        assertEq(firstVal, c.frame.peek(), "subscribe immediate value == current simTime");
        c.advance(3);
        assertEq(calls, 2, "subscribe fires on advance");
        unsub();
    }

    // ---- lite-signal node-return smoke: 64 create/dispose cycles ----------
    // If clock.dispose() failed to return the frame node, the lite-signal
    // default registry would eventually throw CapacityError.
    {
        assertNoThrow(function () {
            for (let i = 0; i < 64; i = (i + 1) | 0) {
                const c = createClock();
                const l = c.lane({ duration: 10 });
                l.start();
                c.advance(5);
                c.dispose();
            }
        }, "64 create/dispose cycles without CapacityError");
    }

    // ---- tracked reads re-run an effect exactly once per advance ----------
    {
        const { effect } = await import("@zakkster/lite-signal");
        const c = createClock();
        const l = c.lane({ duration: 1000 });
        l.start();
        let runs = 0;
        const stop = effect(function () { l.position(); runs = (runs + 1) | 0; });
        assertEq(runs, 1, "effect initial run");
        c.advance(10);
        assertEq(runs, 2, "effect re-run after advance");
        c.advance(10);
        assertEq(runs, 3, "effect re-run after second advance");
        stop();
        assert(c._invariant() === null, function () { return "t8 invariant: " + c._invariant(); });
    }

    // ---- effect/subscriber throw semantics (pins decisions/0001 step-0c) ---
    // lite-clock's drain topology (drain-in-finally, guard-clear-in-finally)
    // depends on lite-signal 1.5.0 behavior: set() rethrows a throwing
    // effect/subscriber SYNCHRONOUSLY, but runs the OTHER trackers first, and
    // the signal stays usable afterward. If an upstream change alters this, it
    // must scream HERE, not silently corrupt the completion drain.
    {
        const { signal, effect } = await import("@zakkster/lite-signal");

        // effect throw: set() rethrows synchronously; sibling effects still run.
        const s = signal(0, { equals: function () { return false; } });
        let bRuns = 0;
        let siblingRan = false;
        effect(function () { s(); bRuns = (bRuns + 1) | 0; if (bRuns === 2) throw new Error("effB boom"); });
        effect(function () { s(); if (bRuns >= 1) siblingRan = true; });
        siblingRan = false;
        let threw = null;
        try { s.set(1); } catch (e) { threw = e; }
        assert(threw !== null, "t8 effect-throw: set() rethrows synchronously");
        assert(siblingRan === true, "t8 effect-throw: sibling effect still ran despite the throw");

        // signal still usable after a throwing set.
        let afterRuns = 0;
        effect(function () { s(); afterRuns = (afterRuns + 1) | 0; });
        const before = afterRuns;
        try { s.set(2); } catch (e) { /* the still-registered throwing effect rethrows */ }
        assert(afterRuns > before, "t8 effect-throw: signal keeps propagating after a throwing set");

        // subscriber throw: set() rethrows synchronously; other subscriber runs.
        const s2 = signal(0, { equals: function () { return false; } });
        let calls = 0;
        let otherSubRan = false;
        s2.subscribe(function () { calls = (calls + 1) | 0; if (calls === 2) throw new Error("sub boom"); });
        s2.subscribe(function () { otherSubRan = true; });
        otherSubRan = false;
        let threw2 = null;
        try { s2.set(1); } catch (e) { threw2 = e; }
        assert(threw2 !== null, "t8 subscriber-throw: set() rethrows synchronously");
        assert(otherSubRan === true, "t8 subscriber-throw: other subscriber still ran despite the throw");
    }

    console.log("t8 cross: pass (subscribe-immediate, node-return, tracked re-run, effect/subscriber throw pinned)");
}
