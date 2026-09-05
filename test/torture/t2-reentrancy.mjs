// test/torture/t2-reentrancy.mjs -- the re-entrancy matrix (GATING, K1).
// Every cell of the ROADMAP section 3 t2 matrix is a named assert under the
// decided policy (decisions/0001-reentrancy.md):
//   advance/advanceTo re-entry from ANY surface (onComplete drain, effect
//   tracking frame(), frame.subscribe fire) throws LiteClockReentrancyError;
//   lane()/dispose()/pause()/start()/reverse()/attachInterval()/detach() stay
//   LEGAL during the tick. The queue is captured before frameSig.set and each
//   drain entry re-checks FLAG_DONE, so growth (C-02) and slot reuse (C-03)
//   cannot corrupt the drain, and a rethrowing effect/subscriber cannot drop a
//   queued completion (the finally drain).
//
// C-01/C-02/C-03 fail-before evidence (pre-K1 / 1.0.1):
//   C-01 onComplete: fired=["A"] (B dropped forever, no throw).
//   C-01 subscriber: bFired=false (completion callback lost).
//   C-02: fired=["A","A"] (A twice, B never -- growth swapped the queue).
//   C-03: fired=["A","C"] with C fired at t=0 on its CREATION tick.
// After K1 (this tier), all of the above become the assertions below.

import { effect } from "@zakkster/lite-signal";
import { createClock, LiteClockReentrancyError } from "../../Clock.js";
import { assert, assertEq } from "./harness.mjs";

// Array equality with a failure-only message.
function assertArr(actual, expected, label) {
    let same = actual.length === expected.length;
    if (same) {
        for (let i = 0; i < actual.length; i = (i + 1) | 0) {
            if (actual[i] !== expected[i]) { same = false; break; }
        }
    }
    assert(same, function () {
        return label + " -- expected [" + expected.join(",") + "] got [" + actual.join(",") + "]";
    });
}

export async function run() {
    // ---- advance-from-onComplete throws; sibling still fires (C-01) --------
    {
        const c = createClock();
        const fired = [];
        let caught = null;
        c.lane({ duration: 50, onComplete: function () {
            fired.push("A");
            try { c.advance(1); } catch (e) { caught = e; }
        } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        c.advance(60);
        assert(caught instanceof LiteClockReentrancyError, function () {
            return "t2 advance-from-onComplete: expected LiteClockReentrancyError, got " + (caught && caught.name);
        });
        assertArr(fired, ["A", "B"], "t2 advance-from-onComplete sibling drain");
        assert(c._invariant() === null, function () { return "t2 advance-from-onComplete invariant: " + c._invariant(); });
    }

    // ---- advanceTo-from-onComplete throws; sibling still fires -------------
    {
        const c = createClock();
        const fired = [];
        let caught = null;
        c.lane({ duration: 50, onComplete: function () {
            fired.push("A");
            try { c.advanceTo(c.simTime + 1); } catch (e) { caught = e; }
        } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        c.advance(60);
        assert(caught instanceof LiteClockReentrancyError, function () {
            return "t2 advanceTo-from-onComplete: expected LiteClockReentrancyError, got " + (caught && caught.name);
        });
        assertArr(fired, ["A", "B"], "t2 advanceTo-from-onComplete sibling drain");
    }

    // ---- advanceTo-from-effect throws; queued completion still fires; not bricked
    {
        const c = createClock();
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let runs = 0;
        const stop = effect(function () { c.frame(); runs = (runs + 1) | 0; if (runs === 2) c.advanceTo(c.simTime + 1); });
        assertEq(runs, 1, "t2 advanceTo-from-effect initial run (no re-entry)");
        let threw = null;
        try { c.advance(60); } catch (e) { threw = e; }
        assert(threw instanceof LiteClockReentrancyError, function () {
            return "t2 advanceTo-from-effect: expected rethrown LiteClockReentrancyError, got " + (threw && threw.name);
        });
        assertArr(fired, ["A"], "t2 advanceTo-from-effect: queued completion fired via finally drain");
        stop();
        // Not bricked: the guard cleared in the finally, so a fresh tick works.
        let fired2 = false;
        c.lane({ duration: 10, onComplete: function () { fired2 = true; } }).start();
        c.advance(20);
        assert(fired2 === true, "t2 advanceTo-from-effect: clock not bricked after rethrow");
    }

    // ---- advanceTo-from-subscriber (SECOND fire) throws; not bricked -------
    {
        const c = createClock();
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let calls = 0;
        const unsub = c.frame.subscribe(function () { calls = (calls + 1) | 0; if (calls === 2) c.advanceTo(c.simTime + 1); });
        assertEq(calls, 1, "t2 advanceTo-from-subscriber immediate fire (not the completion tick)");
        let threw = null;
        try { c.advance(60); } catch (e) { threw = e; }
        assert(threw instanceof LiteClockReentrancyError, function () {
            return "t2 advanceTo-from-subscriber: expected rethrown LiteClockReentrancyError, got " + (threw && threw.name);
        });
        assertArr(fired, ["A"], "t2 advanceTo-from-subscriber: queued completion fired via finally drain");
        unsub();
        let fired2 = false;
        c.lane({ duration: 10, onComplete: function () { fired2 = true; } }).start();
        c.advance(20);
        assert(fired2 === true, "t2 advanceTo-from-subscriber: clock not bricked after rethrow");
    }

    // ---- advance-from-effect throws; queued completion still fires; not bricked
    {
        const c = createClock();
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let runs = 0;
        const stop = effect(function () { c.frame(); runs = (runs + 1) | 0; if (runs === 2) c.advance(1); });
        assertEq(runs, 1, "t2 effect initial run (no re-entry)");
        let threw = null;
        try { c.advance(60); } catch (e) { threw = e; }
        assert(threw instanceof LiteClockReentrancyError, function () {
            return "t2 advance-from-effect: expected rethrown LiteClockReentrancyError, got " + (threw && threw.name);
        });
        assertArr(fired, ["A"], "t2 advance-from-effect: queued completion fired via finally drain");
        stop();
        // Not bricked: the guard cleared in the finally, so a fresh tick works.
        let fired2 = false;
        c.lane({ duration: 10, onComplete: function () { fired2 = true; } }).start();
        c.advance(20);
        assert(fired2 === true, "t2 advance-from-effect: clock not bricked after rethrow");
    }

    // ---- advance-from-subscriber (SECOND fire) throws; not bricked ---------
    {
        const c = createClock();
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let calls = 0;
        const unsub = c.frame.subscribe(function () { calls = (calls + 1) | 0; if (calls === 2) c.advance(1); });
        assertEq(calls, 1, "t2 subscribe immediate fire (not the completion tick)");
        let threw = null;
        try { c.advance(60); } catch (e) { threw = e; }
        assert(threw instanceof LiteClockReentrancyError, function () {
            return "t2 advance-from-subscriber: expected rethrown LiteClockReentrancyError, got " + (threw && threw.name);
        });
        assertArr(fired, ["A"], "t2 advance-from-subscriber: queued completion fired via finally drain");
        unsub();
        let fired2 = false;
        c.lane({ duration: 10, onComplete: function () { fired2 = true; } }).start();
        c.advance(20);
        assert(fired2 === true, "t2 advance-from-subscriber: clock not bricked after rethrow");
    }

    // ---- lane() no-growth from onComplete -> correct callbacks -------------
    {
        const c = createClock({ capacity: 16 });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () {
            fired.push("A");
            const x = c.lane({ duration: 100, onComplete: function () { fired.push("X"); } });
            x.start();
        } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        c.advance(60);
        assertArr(fired, ["A", "B"], "t2 lane-nogrowth-onComplete this tick");
        c.advance(200);
        assertArr(fired, ["A", "B", "X"], "t2 lane-nogrowth-onComplete X later");
    }

    // ---- lane() no-growth from effect -> correct callbacks ----------------
    {
        const c = createClock({ capacity: 16 });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let runs = 0;
        let made = false;
        const stop = effect(function () {
            c.frame();
            runs = (runs + 1) | 0;
            if (runs === 2 && !made) {
                made = true;
                const x = c.lane({ duration: 100, onComplete: function () { fired.push("X"); } });
                x.start();
            }
        });
        c.advance(60);
        assertArr(fired, ["A"], "t2 lane-nogrowth-effect this tick");
        stop();
        c.advance(200);
        assertArr(fired, ["A", "X"], "t2 lane-nogrowth-effect X later");
    }

    // ---- lane() no-growth from subscriber (SECOND fire) -> correct --------
    {
        const c = createClock({ capacity: 16 });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        let calls = 0;
        let made = false;
        const unsub = c.frame.subscribe(function () {
            calls = (calls + 1) | 0;
            if (calls === 2 && !made) {
                made = true;
                const x = c.lane({ duration: 100, onComplete: function () { fired.push("X"); } });
                x.start();
            }
        });
        c.advance(60);
        assertArr(fired, ["A"], "t2 lane-nogrowth-subscriber this tick");
        unsub();
        c.advance(200);
        assertArr(fired, ["A", "X"], "t2 lane-nogrowth-subscriber X later");
    }

    // ---- lane() WITH growth from onComplete -> ["A","B"] exactly (C-02) ----
    {
        const c = createClock({ capacity: 2, growable: true });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () {
            fired.push("A");
            const x = c.lane({ duration: 100 });   // triggers growth (swaps completedIds)
            x.start();
        } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        c.advance(60);
        assertArr(fired, ["A", "B"], "t2 lane-growth-onComplete (C-02)");
        assert(c._invariant() === null, function () { return "t2 growth invariant: " + c._invariant(); });
    }

    // ---- lane() WITH growth from an EFFECT during propagation (C-02 surface)
    {
        const c = createClock({ capacity: 2, growable: true });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        let runs = 0;
        let grew = false;
        const stop = effect(function () {
            c.frame();
            runs = (runs + 1) | 0;
            if (runs === 2 && !grew) {
                grew = true;
                const x = c.lane({ duration: 100 });   // triggers growth (swaps completedIds)
                x.start();
            }
        });
        c.advance(60);
        assertArr(fired, ["A", "B"], "t2 lane-growth-effect (C-02 surface)");
        assert(c._invariant() === null, function () { return "t2 lane-growth-effect invariant: " + c._invariant(); });
        stop();
    }

    // ---- lane() WITH growth from a SUBSCRIBER (second fire) (C-02 surface) -
    {
        const c = createClock({ capacity: 2, growable: true });
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        let calls = 0;
        let grew = false;
        const unsub = c.frame.subscribe(function () {
            calls = (calls + 1) | 0;
            if (calls === 2 && !grew) {
                grew = true;
                const x = c.lane({ duration: 100 });   // triggers growth (swaps completedIds)
                x.start();
            }
        });
        c.advance(60);
        assertArr(fired, ["A", "B"], "t2 lane-growth-subscriber (C-02 surface)");
        assert(c._invariant() === null, function () { return "t2 lane-growth-subscriber invariant: " + c._invariant(); });
        unsub();
    }

    // ---- dispose(own lane) from its own callback -> legal -----------------
    {
        const c = createClock();
        let observed = -1;
        let l;
        l = c.lane({ duration: 50, onComplete: function () { observed = c.activeCount; l.dispose(); } });
        l.start();
        c.advance(60);
        assertEq(observed, 0, "t2 dispose-own: lane already off active list at callback time");
        const n = c.lane({ duration: 10 });   // slot reusable
        assert(n !== undefined && n !== null, "t2 dispose-own: slot reusable after self-dispose");
        assert(c._invariant() === null, function () { return "t2 dispose-own invariant: " + c._invariant(); });
    }

    // ---- dispose(queued sibling) -> sibling callback skipped (pinned) -----
    {
        const c = createClock();
        const fired = [];
        let b;
        const a = c.lane({ duration: 50, onComplete: function () { fired.push("A"); b.dispose(); } });
        b = c.lane({ duration: 50, onComplete: function () { fired.push("B"); } });
        a.start(); b.start();
        c.advance(60);
        assertArr(fired, ["A"], "t2 dispose-queued-sibling: B skipped via DONE re-check");
        assert(c._invariant() === null, function () { return "t2 dispose-queued-sibling invariant: " + c._invariant(); });
    }

    // ---- dispose(sibling)+realloc same id -> no misfire this tick (C-03) ---
    {
        const c = createClock();
        const fired = [];
        let bHandle;
        let cHandle = null;
        let reusedId = -2;
        const a = c.lane({ duration: 50, onComplete: function () {
            fired.push("A");
            const bId = bHandle._id;
            bHandle.dispose();
            cHandle = c.lane({ duration: 100, onComplete: function () { fired.push("C"); } });
            reusedId = cHandle._id;
            void bId;
            cHandle.start();
        } });
        bHandle = c.lane({ duration: 50, onComplete: function () { fired.push("B"); } });
        const bIdBefore = bHandle._id;
        a.start(); bHandle.start();
        c.advance(60);
        assertEq(reusedId, bIdBefore, "t2 realloc: C reused B's LIFO slot id");
        assertArr(fired, ["A"], "t2 realloc: C did NOT misfire on its creation tick (C-03)");
        assertEq(cHandle.donePeek(), false, "t2 realloc: C not done at creation");
        c.advance(200);
        assertArr(fired, ["A", "C"], "t2 realloc: C fires exactly once on its real completion");
        assert(c._invariant() === null, function () { return "t2 realloc invariant: " + c._invariant(); });
    }

    // ---- pause/start/reverse from a callback -> legal, pinned -------------
    {
        const c = createClock();
        const fired = [];
        let other;
        c.lane({ duration: 50, onComplete: function () {
            other.pause();
            other.reverse();
            other.start();
            fired.push("A");
        } }).start();
        other = c.lane({ duration: 1000 });
        other.start();
        c.advance(60);
        assertArr(fired, ["A"], "t2 pause/start/reverse from callback: callback ran");
        assertEq(other.donePeek(), false, "t2 pause/start/reverse: other still running");
        assert(c._invariant() === null, function () { return "t2 pause/start/reverse invariant: " + c._invariant(); });
        // Subsequent tick still advances the lane -- it is genuinely active.
        const pBefore = other.positionPeek();
        c.advance(10);
        assert(other.positionPeek() !== pBefore, "t2 pause/start/reverse: lane advances after callback edits");
    }

    // ---- attachInterval + detach from a callback -> legal -----------------
    {
        const c = createClock();
        let ok = false;
        c.lane({ duration: 50, onComplete: function () {
            c.attachInterval(1000000);   // long cadence; never fires
            c.detach();                  // removed immediately; unref'd anyway
            ok = true;
        } }).start();
        c.advance(60);
        assert(ok === true, "t2 attachInterval+detach from callback: legal");
        assert(c._invariant() === null, function () { return "t2 attach/detach invariant: " + c._invariant(); });
        c.dispose();
    }

    // ---- clock.dispose() from onComplete -> legal, remaining drain skipped --
    // Full dead-clock semantics (throw-closed mutation surface) land in K2;
    // here we only pin that a dispose mid-drain clears flags so the DONE
    // re-check drops the remaining queued callbacks instead of misfiring them.
    {
        const c = createClock();
        const fired = [];
        c.lane({ duration: 50, onComplete: function () { fired.push("A"); c.dispose(); } }).start();
        c.lane({ duration: 50, onComplete: function () { fired.push("B"); } }).start();
        let threw = null;
        try { c.advance(60); } catch (e) { threw = e; }
        assertEq(threw, null, "t2 clock.dispose from onComplete: no throw out of advance");
        assertArr(fired, ["A"], "t2 clock.dispose from onComplete: B skipped via DONE re-check");
        assert(c._invariant() === null, function () { return "t2 clock.dispose invariant: " + c._invariant(); });
    }

    console.log("t2 reentrancy: pass (advance/advanceTo re-entry throws; lane/dispose/pause/start/reverse/attach legal; C-01/02/03 fixed)");
}
