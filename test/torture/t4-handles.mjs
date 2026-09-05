// test/torture/t4-handles.mjs -- stale-handle / dead-clock matrix (GATING, K2).
// Every cell is a named assert under the decided policy (decisions/0002):
//   stale-handle methods are TRUE no-ops; stale tracked/peek reads return the
//   inert terminal (0/0/false) WITHOUT reading the frame signal (no live
//   dependency); a dead clock's mutation surface throws LiteClockDisposedError
//   (BEFORE the re-entrancy check) while frame()/frame.peek() return the frozen
//   simTime as a number; dispose is terminal and idempotent; a dispose during
//   propagation is legal. The old C-04/C-06/C-08 todo recipes are converted to
//   fail-before/pass-after regressions here (same setups, inverted assertions).

import { effect } from "@zakkster/lite-signal";
import {
    createClock,
    LiteClockDisposedError,
    LiteClockReentrancyError
} from "../../Clock.js";
import { assert, assertEq, assertThrows, assertNoThrow } from "./harness.mjs";

export async function run() {
    // ---- (a) stale x all 10 handle surfaces WITH slot reuse ---------------
    // Dispose A, allocate tenant B into A's slot (LIFO), advance so B carries an
    // asymmetric position. Every stale-A method must be a no-op (B untouched)
    // and every stale-A read must return the inert terminal.
    {
        const c = createClock({ capacity: 4 });
        const a = c.lane({ duration: 100 });          // slot 0
        a.dispose();
        const b = c.lane({ duration: 100 });          // reuses slot 0 (LIFO)
        b.start();
        c.advance(30);                                 // B: position 30, t 0.3
        assertEq(c.activeCount, 1, "t4a precondition: B active");
        assertEq(b.positionPeek(), 30, "t4a precondition: B position");

        // Stale methods -- true no-ops (B unaffected).
        a.start();
        assertEq(c.activeCount, 1, "t4a stale start no-op: activeCount");
        a.pause();
        assertEq(c.activeCount, 1, "t4a stale pause no-op: B still active");
        a.reverse();
        assertEq(b.tPeek(), 0.3, "t4a stale reverse no-op: B t not flipped to 0.7");
        a.dispose();
        assertEq(c.activeCount, 1, "t4a stale dispose no-op: B still active");
        assertEq(b.positionPeek(), 30, "t4a stale calls left B position");
        assertEq(b.donePeek(), false, "t4a stale calls left B done");

        // Stale reads -- inert terminals (0/0/false), tracked and peek.
        assertEq(a.position(), 0, "t4a stale position() -> 0");
        assertEq(a.t(), 0, "t4a stale t() -> 0");
        assertEq(a.done(), false, "t4a stale done() -> false");
        assertEq(a.positionPeek(), 0, "t4a stale positionPeek() -> 0");
        assertEq(a.tPeek(), 0, "t4a stale tPeek() -> 0");
        assertEq(a.donePeek(), false, "t4a stale donePeek() -> false");
    }

    // ---- (b) stale tracked read creates NO reactive dependency ------------
    // An effect reading a stale handle's position() must run exactly once: the
    // generation guard returns BEFORE the tracked frameSig() read, so a later
    // advance() (which fires frameSig) cannot re-run the effect.
    {
        const c = createClock();
        const a = c.lane({ duration: 100 });
        a.start();
        a.dispose();                                   // a is now stale
        let reruns = 0;
        const stop = effect(function () { a.position(); reruns = (reruns + 1) | 0; });
        assertEq(reruns, 1, "t4b effect initial run");
        c.advance(10);
        assertEq(reruns, 1, "t4b stale read created no dependency: no rerun");
        stop();
    }

    // ---- (c) dead clock: mutation throws, reads inert-but-number ----------
    {
        const c = createClock();
        c.advance(5);                                  // simTime = 5
        c.dispose();
        assertThrows(function () { c.advance(1); }, LiteClockDisposedError, "dispose", "t4c advance on dead clock");
        assertThrows(function () { c.advanceTo(9); }, LiteClockDisposedError, "dispose", "t4c advanceTo on dead clock");
        assertThrows(function () { c.lane({ duration: 10 }); }, LiteClockDisposedError, "dispose", "t4c lane on dead clock");
        assertThrows(function () { c.attachRAF(); }, LiteClockDisposedError, "dispose", "t4c attachRAF on dead clock");
        assertThrows(function () { c.attachInterval(100); }, LiteClockDisposedError, "dispose", "t4c attachInterval on dead clock");
        assertThrows(function () { c.frame.subscribe(function () {}); }, LiteClockDisposedError, "dispose", "t4c frame.subscribe on dead clock");
        // Idempotent no-ops.
        assertNoThrow(function () { c.detach(); }, "t4c detach idempotent");
        assertNoThrow(function () { c.dispose(); }, "t4c dispose idempotent");
        // Reads: frozen simTime, always a number (never undefined).
        assertEq(typeof c.frame(), "number", "t4c frame() typeof number");
        assertEq(c.frame(), 5, "t4c frame() frozen simTime");
        assertEq(typeof c.frame.peek(), "number", "t4c frame.peek() typeof number");
        assertEq(c.frame.peek(), 5, "t4c frame.peek() frozen simTime");
    }

    // ---- (d) precedence: dead clock throws Disposed, never Reentrancy -----
    {
        const c = createClock();
        c.dispose();
        const threw = assertThrows(function () { c.advance(1); }, LiteClockDisposedError, "dispose", "t4d advance precedence");
        assert(!(threw instanceof LiteClockReentrancyError), function () {
            return "t4d precedence: disposed advance threw " + (threw && threw.name) + ", not DisposedError";
        });
    }

    // ---- (e) double-dispose does NOT bump the generation twice ------------
    // Dispose A once (bumps slot gen). Allocate tenant B into the slot. A stale
    // SECOND dispose on A must be inert: if it bumped the generation again, B's
    // stamped generation would go stale. B stays live -> the second dispose was
    // a true no-op.
    {
        const c = createClock({ capacity: 2 });
        const a = c.lane({ duration: 100 });          // slot 0
        a.dispose();                                   // gen[0] bumped once
        const b = c.lane({ duration: 100 });          // reuses slot 0, stamps new gen
        b.start();
        c.advance(20);
        assertEq(b.positionPeek(), 20, "t4e tenant B live before second stale dispose");
        a.dispose();                                   // stale second dispose -- must NOT bump gen
        assertEq(b.positionPeek(), 20, "t4e B still readable after stale double-dispose");
        assertEq(c.activeCount, 1, "t4e B still active after stale double-dispose");
        b.pause();
        assertEq(c.activeCount, 0, "t4e B handle still LIVE (pause worked)");
        // clock.dispose() twice is a no-op.
        assertNoThrow(function () { c.dispose(); c.dispose(); }, "t4e clock double-dispose no-op");
    }

    // ---- (f) growth-then-stale-read: relocation is transparent ------------
    // A stale pre-growth handle stays inert after the SOA arrays relocate; a
    // LIVE pre-growth handle still reads correctly through the clock's getters.
    {
        const c = createClock({ capacity: 2, growable: true });
        const aStale = c.lane({ duration: 100 });     // slot 0
        const aLive = c.lane({ duration: 100 });      // slot 1
        aLive.start();
        aStale.dispose();                              // slot 0 freed, aStale stale
        c.advance(10);                                 // aLive position 10
        assertEq(aLive.positionPeek(), 10, "t4f live handle before growth");
        // Force growth: refill slot 0, then one more allocation relocates arrays.
        c.lane({ duration: 100 });                     // reuses slot 0
        c.lane({ duration: 100 });                     // triggers growth to cap 4
        assert(c.capacity >= 4, function () { return "t4f growth happened: capacity=" + c.capacity; });
        // Stale handle stays inert post-relocation.
        assertEq(aStale.positionPeek(), 0, "t4f stale handle inert after growth (peek)");
        assertEq(aStale.position(), 0, "t4f stale handle inert after growth (tracked)");
        aStale.start();
        assertNoThrow(function () { aStale.reverse(); }, "t4f stale method no-op after growth");
        // Live pre-growth handle still tracks through the relocated arrays.
        assertEq(aLive.positionPeek(), 10, "t4f live handle reads post-growth");
        c.advance(5);
        assertEq(aLive.positionPeek(), 15, "t4f live handle advances post-growth");
    }

    // ---- (g) dispose-mid-propagation is LEGAL and PINNED ------------------
    // An effect on frame() calls clock.dispose() on its 2nd run during advance:
    // no throw, the tick completes, simTime freezes at the advanced value,
    // activeCount 0, and only a SUBSEQUENT advance throws. The in-effect
    // advance attempt right after the mid-tick dispose is the load-bearing
    // precedence probe: `advancing` is still true at that point, so a swapped
    // disposed/advancing guard order would surface as ReentrancyError.
    {
        const c = createClock();
        c.lane({ duration: 1000 }).start();
        let runs = 0;
        let midTickErr = null;
        const stop = effect(function () {
            c.frame();
            runs = (runs + 1) | 0;
            if (runs === 2) {
                c.dispose();
                // advancing === true AND disposed === true right here.
                try { c.advance(1); } catch (e) { midTickErr = e; }
            }
        });
        let threw = null;
        try { c.advance(10); } catch (e) { threw = e; }
        assertEq(threw, null, "t4g dispose-mid-propagation: no throw out of advance");
        assert(midTickErr !== null && midTickErr.name === "LiteClockDisposedError", function () {
            return "t4g precedence under advancing+disposed: got "
                + (midTickErr === null ? "no throw" : midTickErr.name)
                + " (a swapped guard order throws ReentrancyError here)";
        });
        assertEq(c.simTime, 10, "t4g simTime frozen at advanced value");
        assertEq(c.activeCount, 0, "t4g activeCount 0 after mid-tick dispose");
        assertThrows(function () { c.advance(1); }, LiteClockDisposedError, "dispose", "t4g subsequent advance throws");
        stop();
    }

    // ---- (h) C-04 regression: stale handle + reused slot inert ------------
    // Fail-before (pre-K2 1.0.2): staleT=0.5 activeCount 1->0 (the stale handle
    // read AND drove the reused tenant).
    // Pass-after: stale read is inert (staleT=0) and stale dispose is a no-op
    // (activeCount stays 1); the tenant is never touched.
    {
        const c = createClock();
        const a = c.lane({ duration: 100 });
        a.dispose();
        const b = c.lane({ duration: 100 });          // reuses slot (LIFO)
        b.start();
        c.advance(50);                                 // B at t=0.5
        const before = c.activeCount;                  // 1
        const staleT = a.tPeek();                      // pre-fix 0.5; post-fix 0
        a.dispose();                                   // pre-fix killed B; post-fix no-op
        const after = c.activeCount;                   // pre-fix 0; post-fix 1
        assertEq(staleT, 0, "t4h C-04: stale tPeek inert (was 0.5)");
        assertEq(before, 1, "t4h C-04: tenant active before stale dispose");
        assertEq(after, 1, "t4h C-04: stale dispose did NOT kill the tenant (was 0)");
        assertEq(b.tPeek(), 0.5, "t4h C-04: tenant B untouched");
    }

    // ---- (h) C-06 regression: dead clock throws; frame() is a number ------
    // Fail-before (pre-K2 1.0.2): fired=true simTime=10 effectReruns=1->1
    // frame()=undefined (zombie clock accepted lanes, fired callbacks, and
    // frame() returned undefined against a d.ts that says number).
    // Pass-after: lane()/advance() throw LiteClockDisposedError; frame() returns
    // the frozen simTime as a number; the effect never re-runs.
    {
        const c = createClock();
        c.advance(10);                                 // simTime = 10
        c.dispose();
        let reruns = 0;
        const stop = effect(function () { c.frame(); reruns = (reruns + 1) | 0; });
        assertEq(reruns, 1, "t4h C-06: effect initial run");
        assertThrows(function () { c.lane({ duration: 5 }); }, LiteClockDisposedError, "dispose", "t4h C-06: lane on dead clock throws");
        assertThrows(function () { c.advance(10); }, LiteClockDisposedError, "dispose", "t4h C-06: advance on dead clock throws");
        assertEq(typeof c.frame(), "number", "t4h C-06: frame() typeof number (was undefined)");
        assertEq(c.frame(), 10, "t4h C-06: frame() frozen simTime");
        assertEq(reruns, 1, "t4h C-06: dead-clock frame read created no dependency");
        stop();
    }

    // ---- (h) C-08 regression: dispose is terminal, counters freeze --------
    // Fail-before (pre-K2 1.0.2): after dispose simTime=8 ticks=2 while the d.ts
    // claimed dispose() resets the counters -- the code always froze them.
    // Pass-after: the d.ts is corrected to terminal semantics; the counters
    // freeze at 8/2 and nothing rewinds.
    {
        const c = createClock();
        c.advance(5);
        c.advance(3);
        c.dispose();
        assertEq(c.simTime, 8, "t4h C-08: simTime frozen (not reset)");
        assertEq(c.ticks, 2, "t4h C-08: ticks frozen (not reset)");
    }

    console.log("t4 handles: pass (stale no-ops + inert reads; dead-clock throws; dispose terminal; C-04/06/08 fixed)");
}

// ---- control: the t4 gate must be able to FAIL without shipping broken code -
// Drive the C-04 tenant-untouched detector, but interfere with the tenant
// through its LIVE alias handle exactly where the detector demands no
// interference. The tenant-untouched comparator must trip -> non-zero exit.
// This proves the t4 stale-handle assertions are load-bearing, not decorative.
export async function runControlStale() {
    try {
        const c = createClock();
        const a = c.lane({ duration: 100 });          // slot 0
        a.dispose();
        const b = c.lane({ duration: 100 });          // reuses slot 0 (LIFO), live alias
        b.start();
        c.advance(30);                                 // tenant B at position 30
        const tenantBefore = b.positionPeek();         // detector's untouched baseline
        // Stale-A operations the detector treats as no-ops (they are).
        a.reverse();
        a.dispose();
        // DELIBERATE interference through B's OWN live handle -- the detector
        // asserts the tenant is untouched, so mutating B here must trip it.
        b.pause();
        c.advance(40);
        b.start();
        c.advance(10);                                 // tenant now moved off 30
        assertEq(b.positionPeek(), tenantBefore, "control-stale detector: tenant untouched");
    } catch (e) {
        console.error("[control stale] detector tripped as expected: " + (e && e.message));
        process.exit(1);
    }
    console.error("[control stale] detector did NOT trip -- gate decorative");
    process.exit(0);
}
