// test/torture/t3-adversarial.mjs -- adversarial drain/compaction sequences.
// GATING (K1): 10K same-tick completions with a pinned callback-order log; a
// re-arm chain (each callback disposes itself and arms a successor) for 10K
// ticks with the conservation invariant checked every 1K; a no-drop detector
// after each sequence (every done lane with a registered callback fired exactly
// once -- tracked in a preallocated Uint32Array side channel). Also gates the
// C-05 growth ceiling: a default-start growable clock reaches exactly 65534.

import { createClock, LiteClockCapacityError } from "../../Clock.js";
import { assert, assertEq, assertThrows, makeRng, SEED } from "./harness.mjs";

// ---- preallocated side channels (allocated once, outside every loop) -------
const N = 10000;
const fireCounts = new Uint32Array(N);   // fireCounts[i] = times lane i fired
const orderBuf = new Uint32Array(N);     // drain order log
let orderPos = 0;
const cbs = new Array(N);
for (let i = 0; i < N; i = (i + 1) | 0) {
    const idx = i;
    cbs[i] = function () {
        fireCounts[idx] = (fireCounts[idx] + 1) | 0;
        orderBuf[orderPos] = idx;
        orderPos = (orderPos + 1) | 0;
    };
}

// No-drop detector: every one of the first `count` lanes fired exactly once.
function assertNoDrop(count, label) {
    for (let i = 0; i < count; i = (i + 1) | 0) {
        assert(fireCounts[i] === 1, function () {
            return label + " -- lane " + i + " fired " + fireCounts[i] + " times (expected 1)";
        });
    }
}

export async function run() {
    // ---- 10K lanes completing in one tick; drain order == insertion order --
    {
        fireCounts.fill(0);
        orderPos = 0;
        const c = createClock({ capacity: 16384 });
        for (let i = 0; i < N; i = (i + 1) | 0) {
            const l = c.lane({ duration: 50, onComplete: cbs[i] });
            l.start();
        }
        c.advance(60);   // all N complete in one tick
        assertEq(orderPos, N, "t3 10k same-tick: all fired");
        for (let i = 0; i < N; i = (i + 1) | 0) {
            assert(orderBuf[i] === i, function () {
                return "t3 10k same-tick order at " + i + ": got " + orderBuf[i];
            });
        }
        assertNoDrop(N, "t3 10k same-tick no-drop");
        assert(c._invariant() === null, function () { return "t3 10k same-tick invariant: " + c._invariant(); });
        assertEq(c.activeCount, 0, "t3 10k same-tick activeCount");
        c.dispose();
    }

    // ---- re-arm chain: each callback disposes itself and arms a successor ---
    {
        const c = createClock({ capacity: 16 });
        const D = 10;
        const TICKS = 10000;
        let chainFires = 0;
        let handle;
        const chainCb = function () {
            chainFires = (chainFires + 1) | 0;
            handle.dispose();                                  // dispose self (already off active)
            handle = c.lane({ duration: D, onComplete: chainCb });
            handle.start();                                    // arm successor (reuses the LIFO slot)
        };
        handle = c.lane({ duration: D, onComplete: chainCb });
        handle.start();
        for (let t = 0; t < TICKS; t = (t + 1) | 0) {
            c.advance(D);
            if (((t + 1) % 1000) === 0) {
                assert(c._invariant() === null, function () { return "t3 re-arm invariant at tick " + (t + 1) + ": " + c._invariant(); });
            }
        }
        assertEq(chainFires, TICKS, "t3 re-arm chain: one completion per tick, none dropped or doubled");
        assertEq(c.activeCount, 1, "t3 re-arm chain: exactly one successor left armed");
        assert(c._invariant() === null, function () { return "t3 re-arm final invariant: " + c._invariant(); });
        c.dispose();
    }

    // ---- C-05 (GATING, K3): the growable ceiling is exactly 65534 ----------
    // Docs/d.ts/llms.txt say "doubles up to 65534". The final step is a clamp,
    // not a double: 1024 -> 2048 -> ... -> 32768 -> 65534. The 65535th lane
    // throws LiteClockCapacityError(65534). Pre-growth lanes survive every
    // relocation (including the clamped 32768 -> 65534 step) bit-identically.
    {
        const c = createClock({ growable: true });

        // Pre-growth marker lanes at a spread of ids, started with distinct
        // positions captured BEFORE any growth. No advance runs during the
        // allocation loop below, so positionPeek reads stay frozen.
        const MARKERS = 8;
        const markers = new Array(MARKERS);
        const posBefore = new Array(MARKERS);
        const tBefore = new Array(MARKERS);
        for (let i = 0; i < MARKERS; i = (i + 1) | 0) {
            const m = c.lane({ duration: 100 });
            m.start();
            markers[i] = m;
        }
        c.advance(40);
        for (let i = 0; i < MARKERS; i = (i + 1) | 0) {
            posBefore[i] = markers[i].positionPeek();
            tBefore[i] = markers[i].tPeek();
            assertEq(posBefore[i], 40, "t3 C-05 marker " + i + " pre-growth position");
            assertEq(markers[i].donePeek(), false, "t3 C-05 marker " + i + " pre-growth done");
        }
        assertEq(c.capacity, 1024, "t3 C-05 default start capacity");

        // Allocate to exhaustion, recording each distinct capacity. capBefore32k
        // snapshots the markers again right at capacity 32768 so the clamped
        // 32768 -> 65534 step is proven non-destructive on its own.
        const trajectory = [c.capacity];
        let sampledAt32768 = false;
        let n = MARKERS;
        let err = null;
        try {
            for (;;) {
                c.lane({ duration: 1e9 });
                n = (n + 1) | 0;
                if (c.capacity !== trajectory[trajectory.length - 1]) {
                    trajectory.push(c.capacity);
                    if (c.capacity === 32768) {
                        for (let i = 0; i < MARKERS; i = (i + 1) | 0) {
                            assertEq(markers[i].positionPeek(), posBefore[i], "t3 C-05 marker " + i + " at 32768");
                        }
                        sampledAt32768 = true;
                    }
                }
            }
        } catch (e) {
            err = e;
        }

        assert(sampledAt32768, function () { return "t3 C-05: never observed capacity 32768"; });
        assertEq(trajectory.length, 7, "t3 C-05 trajectory step count");
        assertEq(trajectory[0], 1024, "t3 C-05 trajectory[0]");
        assertEq(trajectory[5], 32768, "t3 C-05 trajectory[5]");
        assertEq(trajectory[6], 65534, "t3 C-05 trajectory[6] (clamp, not double)");
        assertEq(c.capacity, 65534, "t3 C-05 final capacity exactly 65534");
        assertEq(n, 65534, "t3 C-05 allocated exactly 65534 lanes");
        assert(err instanceof LiteClockCapacityError, function () { return "t3 C-05: 65535th lane must throw CapacityError, got " + (err && err.name); });
        assertEq(err.capacity, 65534, "t3 C-05 CapacityError.capacity");
        assert(c._invariant() === null, function () { return "t3 C-05 invariant after clamp: " + c._invariant(); });

        // Every pre-growth marker survived the whole growth (incl. the clamp)
        // bit-identically in position, t, and done.
        for (let i = 0; i < MARKERS; i = (i + 1) | 0) {
            assertEq(markers[i].positionPeek(), posBefore[i], "t3 C-05 marker " + i + " position bit-identical post-clamp");
            assertEq(markers[i].tPeek(), tBefore[i], "t3 C-05 marker " + i + " t bit-identical post-clamp");
            assertEq(markers[i].donePeek(), false, "t3 C-05 marker " + i + " done bit-identical post-clamp");
        }
        c.dispose();
    }

    // ---- 10K loop cycles in ONE tick: exact fire count, exact final state --
    // dur 1, one loop lane with a counting callback, advance(10000.5): exactly
    // 10000 completed cycles fire once each, position lands at 0.5, and the
    // whole ride finishes well under a second (no per-cycle allocation hang).
    {
        const c = createClock();
        let fires = 0;
        const l = c.lane({ duration: 1, loop: true, onComplete: function () { fires = (fires + 1) | 0; } });
        l.start();
        const t0 = Date.now();
        c.advance(10000.5);
        const elapsedMs = Date.now() - t0;
        assertEq(fires, 10000, "t3 10k-cycle single tick fire count");
        assertEq(l.positionPeek(), 0.5, "t3 10k-cycle single tick position");
        assertEq(l.donePeek(), false, "t3 10k-cycle loop never done");
        assert(elapsedMs < 1000, function () { return "t3 10k-cycle single tick too slow: " + elapsedMs + "ms"; });
        c.dispose();
    }

    // ---- k-fold boundary: cross the Uint32 fold at 2^30 in one call --------
    // dur 1, NO callback, advance(2^30 + 3.5) folds the cycle counter at 2^30
    // (recompute-shaped, so path-independent). Position must land at 0.5, and a
    // follow-up advance(0.25) must match a fresh-lane oracle at 0.75 bit-for-bit.
    {
        const c = createClock();
        const l = c.lane({ duration: 1, loop: true });
        l.start();
        c.advance((2 ** 30) + 3.5);
        assertEq(l.positionPeek(), 0.5, "t3 k-fold position after fold");
        assertEq(l.donePeek(), false, "t3 k-fold loop never done");
        c.advance(0.25);
        const oc = createClock();
        const ol = oc.lane({ duration: 1, loop: true });
        ol.start();
        oc.advance(0.75);
        assertEq(l.positionPeek(), ol.positionPeek(), "t3 k-fold follow-up matches fresh-lane oracle");
        c.dispose(); oc.dispose();
    }

    // ---- seek fails closed on non-finite (live handle) --------------------
    {
        const c = createClock();
        const l = c.lane({ duration: 10 });
        l.start();
        assertThrows(function () { l.seek(NaN); }, RangeError, "seek", "t3 seek NaN throws");
        assertThrows(function () { l.seek(Infinity); }, RangeError, "seek", "t3 seek Infinity throws");
        c.dispose();
    }

    // ---- advance overflow guard at an extreme timeScale -------------------
    // A finite dt times a finite timeScale can overflow to Infinity: fail closed.
    {
        const c = createClock();
        c.timeScale = 1e10;
        assertThrows(function () { c.advance(1e308); }, RangeError, "timeScale", "t3 advance overflow guard");
        c.dispose();
    }

    // ---- timeScale=0 freeze under 1000 fuzzed dts -------------------------
    // simTime stays bit-frozen at its pre-freeze value; ticks increments once
    // per advance; no lane completes.
    {
        const c = createClock();
        const l = c.lane({ duration: 5 });
        l.start();
        c.advance(2);                              // simTime now 2, position 2
        c.timeScale = 0;
        const frozen = c.simTime;
        const ticksBefore = c.ticks;
        const rng = makeRng(SEED);
        for (let i = 0; i < 1000; i = (i + 1) | 0) {
            const dt = (rng() % 10000) + (((rng() % 2) === 0) ? 0 : 0.5);
            c.advance(dt);
        }
        assertEq(c.simTime, frozen, "t3 timeScale=0 simTime bit-frozen");
        assertEq(c.ticks, ticksBefore + 1000, "t3 timeScale=0 ticks +1000");
        assertEq(l.donePeek(), false, "t3 timeScale=0 completes nothing");
        assertEq(l.positionPeek(), 2, "t3 timeScale=0 position frozen");
        c.dispose();
    }

    console.log("t3 adversarial: pass (10k same-tick order + re-arm chain 10k ticks; C-05 ceiling 65534 bit-exact; 10k-cycle single tick; k-fold; seek/overflow/freeze guards)");
}
