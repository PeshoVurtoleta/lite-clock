// test/torture/t3-adversarial.mjs -- adversarial drain/compaction sequences.
// GATING (K1): 10K same-tick completions with a pinned callback-order log; a
// re-arm chain (each callback disposes itself and arms a successor) for 10K
// ticks with the conservation invariant checked every 1K; a no-drop detector
// after each sequence (every done lane with a registered callback fired exactly
// once -- tracked in a preallocated Uint32Array side channel). Also keeps the
// C-05 growth-ceiling reproduction as a todo (fix lands in K3).

import { createClock, LiteClockCapacityError } from "../../Clock.js";
import { assert, assertEq, reportTodo } from "./harness.mjs";

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

    // ---- C-05 (todo, K3): the growable ceiling is unreachable --------------
    // Docs/d.ts/llms.txt say "doubles up to 65534". Growth throws when
    // oldCap * 2 > 65534, so a default clock stops at 32768.
    reportTodo("C-05", function () {
        const c = createClock({ growable: true });
        let n = 0;
        let err = null;
        try {
            for (;;) { c.lane({ duration: 1e9 }); n = (n + 1) | 0; }
        } catch (e) {
            err = e;
        }
        const cap = c.capacity;
        const repro = (err instanceof LiteClockCapacityError && cap === 32768);
        return {
            reproduces: repro,
            observed: "allocated n=" + n + " capacity=" + cap + " err=" + (err && err.name) + " (docs claim ceiling 65534)"
        };
    });

    console.log("t3 adversarial: pass (10k same-tick order + re-arm chain 10k ticks, no drops/doubles)");
}
