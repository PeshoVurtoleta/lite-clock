// 19-attach-fixed.test.mjs
// attachFixed(stepMs, opts?) -- the fixed-timestep accumulator driver (D5).
// Guard ladders pinned by class + message fragment. Time is fully controlled
// via a requestAnimationFrame shim (precedent: 07-attach.test.mjs:57-75) and a
// performance.now shim, with a DYADIC stepMs (16) so droppedMs is bit-exact.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, LiteClockDisposedError } from "../Clock.js";

// A controllable rAF + performance.now harness. `fns` holds pending callbacks;
// `setNow` sets the clock read by attachFixed's nowMs()/frame timestamps.
function withFakeTime(body) {
    const origRAF = globalThis.requestAnimationFrame;
    const origPerf = globalThis.performance;
    const fns = [];
    let fakeNow = 0;
    globalThis.requestAnimationFrame = (fn) => { fns.push(fn); return fns.length; };
    globalThis.performance = { now: () => fakeNow };
    const api = {
        setNow: (t) => { fakeNow = t; },
        // Fire the most recently scheduled frame at time `now`.
        frame: (now) => { fakeNow = now; const fn = fns.pop(); fns.length = 0; fn(now); }
    };
    try { body(api); } finally {
        globalThis.requestAnimationFrame = origRAF;
        globalThis.performance = origPerf;
    }
}

// ---- guard ladder -----------------------------------------------------------
test("attachFixed: disposed clock throws LiteClockDisposedError", () => {
    withFakeTime(() => {
        const c = createClock();
        c.dispose();
        assert.throws(() => c.attachFixed(16), LiteClockDisposedError);
    });
});

test("attachFixed: non-finite / non-positive stepMs throws RangeError", () => {
    withFakeTime(() => {
        const c = createClock();
        for (const bad of [0, -16, Infinity, NaN]) {
            assert.throws(() => c.attachFixed(bad),
                (e) => e instanceof RangeError && /stepMs must be a finite number > 0/.test(e.message));
        }
        assert.throws(() => c.attachFixed("16"),
            (e) => e instanceof RangeError && /stepMs must be a finite number > 0/.test(e.message));
    });
});

test("attachFixed: unknown opts key throws did-you-mean TypeError", () => {
    withFakeTime(() => {
        const c = createClock();
        assert.throws(() => c.attachFixed(16, { maxSubStep: 4 }),
            (e) => e instanceof TypeError
                && e.message === "clock.attachFixed: unknown option 'maxSubStep' -- did you mean 'maxSubSteps'?");
    });
});

test("attachFixed: non-object opts throws TypeError", () => {
    withFakeTime(() => {
        const c = createClock();
        assert.throws(() => c.attachFixed(16, 5),
            (e) => e instanceof TypeError && /opts must be an object/.test(e.message));
    });
});

test("attachFixed: non-number maxSubSteps throws TypeError naming the type", () => {
    withFakeTime(() => {
        const c = createClock();
        assert.throws(() => c.attachFixed(16, { maxSubSteps: null }),
            (e) => e instanceof TypeError && /maxSubSteps must be a number \(got null\)/.test(e.message));
        assert.throws(() => c.attachFixed(16, { maxSubSteps: "4" }),
            (e) => e instanceof TypeError && /maxSubSteps must be a number \(got string\)/.test(e.message));
    });
});

test("attachFixed: bad-value maxSubSteps throws RangeError", () => {
    withFakeTime(() => {
        const c = createClock();
        assert.throws(() => c.attachFixed(16, { maxSubSteps: 0 }),
            (e) => e instanceof RangeError && /maxSubSteps must be an integer >= 1/.test(e.message));
        assert.throws(() => c.attachFixed(16, { maxSubSteps: 2.5 }),
            (e) => e instanceof RangeError && /maxSubSteps must be an integer >= 1/.test(e.message));
    });
});

// ---- accumulator behavior ---------------------------------------------------
test("attachFixed: exact-quantum frame feeds one advance", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(16);
        assert.equal(c.ticks, 1);
        assert.equal(c.simTime, 16);
        assert.equal(c.stats().droppedMs, 0);
    });
});

test("attachFixed: multi-quantum frame feeds floor(acc/stepMs) advances", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(48);                               // 48ms -> 3 quanta
        assert.equal(c.ticks, 3);
        assert.equal(c.simTime, 48);
        assert.equal(c.stats().droppedMs, 0);
    });
});

test("attachFixed: sub-quantum remainder always carries", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(24);                               // 1 quantum, 8ms carries
        assert.equal(c.ticks, 1);
        assert.equal(c.simTime, 16);
        frame(32);                               // +8ms = 16 acc -> 1 more quantum
        assert.equal(c.ticks, 2);
        assert.equal(c.simTime, 32);
        assert.equal(c.stats().droppedMs, 0);
    });
});

test("attachFixed: maxSubSteps caps the drain and drops whole quanta (default 8)", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(1000);                             // floor(1000/16)=62, capped at 8
        assert.equal(c.ticks, 8);
        assert.equal(c.simTime, 128);            // 8 * 16
        // acc = 1000 - 8*16 = 872; drop = 872 - (872 % 16) = 864; remainder 8 carries.
        assert.equal(c.stats().droppedMs, 864);
        frame(1008);                             // +8ms = 16 acc -> exactly one quantum
        assert.equal(c.ticks, 9);
        assert.equal(c.simTime, 144);
        assert.equal(c.stats().droppedMs, 864);  // no new drop
    });
});

test("attachFixed: explicit maxSubSteps caps at the given value", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16, { maxSubSteps: 4 });
        frame(1000);
        assert.equal(c.ticks, 4);
        assert.equal(c.simTime, 64);
        // acc = 1000 - 64 = 936; drop = 936 - (936 % 16) = 928.
        assert.equal(c.stats().droppedMs, 928);
    });
});

test("attachFixed: sim quantum scales with timeScale", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.timeScale = 2;
        c.attachFixed(16);
        frame(48);                               // 3 quanta, each advance(16)*timeScale
        assert.equal(c.ticks, 3);
        assert.equal(c.simTime, 96);             // 3 * 16 * 2
    });
});

// ---- lifecycle --------------------------------------------------------------
test("attachFixed: attach replaces any prior attach", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        c.attachFixed(16);                       // replaces the first
        frame(16);
        // A stacked driver would double-advance; one source gives exactly 1 tick.
        assert.equal(c.ticks, 1);
    });
});

test("attachFixed: detach cancels the driver", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(16);
        assert.equal(c.ticks, 1);
        c.detach();
        frame(32);                               // dead callback must not advance
        assert.equal(c.ticks, 1);
    });
});

test("attachFixed: droppedMs is frozen at dispose and absent from the snapshot", () => {
    withFakeTime(({ setNow, frame }) => {
        setNow(0);
        const c = createClock();
        c.attachFixed(16);
        frame(1000);
        const dropped = c.stats().droppedMs;
        assert.ok(dropped > 0);
        c.detach();
        // Hydrating the state onto a virgin clock does not carry droppedMs: it
        // is driver observability, not sim state.
        const buf = new Uint8Array(c.snapshotSize());
        c.snapshot(buf);
        const other = createClock();
        other.hydrate(buf);
        assert.equal(other.stats().droppedMs, 0, "droppedMs is not carried by the snapshot");
        assert.equal(other.simTime, 128, "sim state IS carried");
        // The source's counter freezes at dispose, never resets.
        c.dispose();
        assert.equal(c.stats().droppedMs, dropped, "droppedMs frozen at dispose");
    });
});
