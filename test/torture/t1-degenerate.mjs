// test/torture/t1-degenerate.mjs -- degenerate scalar inputs (GATING).
// Pins behavior pinned by error class AND message fragment (the message names
// the contract). Includes the C-07 config-law cells: unknown option keys on
// both doors throw with a did-you-mean hint, and a non-boolean growable throws.

import { createClock, LiteClockCapacityError } from "../../Clock.js";
import { assert, assertEq, assertThrows, assertNoThrow } from "./harness.mjs";

export async function run() {
    // ---- advance ----------------------------------------------------------
    {
        const c = createClock();
        assertThrows(function () { c.advance(NaN); }, RangeError, "advance", "advance(NaN)");
        assertThrows(function () { c.advance(-1); }, RangeError, "advance", "advance(-1)");
        assertThrows(function () { c.advance(Infinity); }, RangeError, "advance", "advance(Infinity)");
        assertThrows(function () { c.advance(-Infinity); }, RangeError, "advance", "advance(-Infinity)");

        // advance(-0) is the dt=0 path: ticks increments, simTime unchanged.
        const ticksBefore = c.ticks;
        const simBefore = c.simTime;
        c.advance(-0);
        assertEq(c.ticks, ticksBefore + 1, "advance(-0) ticks");
        assertEq(c.simTime, simBefore, "advance(-0) simTime");

        assertNoThrow(function () { c.advance(Number.EPSILON); }, "advance(EPSILON)");
        assertNoThrow(function () { c.advance(Number.MAX_VALUE); }, "advance(MAX_VALUE)");
    }

    // ---- advanceTo --------------------------------------------------------
    {
        const c = createClock();
        assertThrows(function () { c.advanceTo(NaN); }, RangeError, "advanceTo", "advanceTo(NaN)");
        assertThrows(function () { c.advanceTo(Infinity); }, RangeError, "advanceTo", "advanceTo(Infinity)");
        c.advance(10);
        assertThrows(function () { c.advanceTo(5); }, RangeError, "advanceTo", "advanceTo(t < simTime)");

        // t === simTime is the dt=0 path.
        const ticksBefore = c.ticks;
        c.advanceTo(10);
        assertEq(c.ticks, ticksBefore + 1, "advanceTo(==simTime) ticks");
        assertEq(c.simTime, 10, "advanceTo(==simTime) simTime");
    }

    // ---- lane -------------------------------------------------------------
    {
        const c = createClock();
        assertThrows(function () { c.lane({ duration: NaN }); }, RangeError, "duration", "lane duration NaN");
        assertThrows(function () { c.lane({ duration: 0 }); }, RangeError, "duration", "lane duration 0");
        assertThrows(function () { c.lane({ duration: -1 }); }, RangeError, "duration", "lane duration -1");
        assertThrows(function () { c.lane({ duration: Infinity }); }, RangeError, "duration", "lane duration Infinity");
        assertThrows(function () { c.lane({ duration: 10, onComplete: 5 }); }, TypeError, "onComplete", "lane onComplete non-fn");
        assertThrows(function () { c.lane(null); }, TypeError, "opts", "lane opts null");
        assertThrows(function () { c.lane(5); }, TypeError, "opts", "lane opts non-object");

        // Subnormal and MAX_VALUE durations are legal.
        assertNoThrow(function () { c.lane({ duration: 5e-324 }); }, "lane duration subnormal");
        assertNoThrow(function () { c.lane({ duration: Number.MAX_VALUE }); }, "lane duration MAX_VALUE");
    }

    // ---- createClock ------------------------------------------------------
    {
        assertThrows(function () { createClock({ capacity: 0 }); }, RangeError, "capacity", "capacity 0");
        assertThrows(function () { createClock({ capacity: -1 }); }, RangeError, "capacity", "capacity -1");
        assertThrows(function () { createClock({ capacity: 1.5 }); }, RangeError, "capacity", "capacity 1.5");
        assertThrows(function () { createClock({ capacity: NaN }); }, RangeError, "capacity", "capacity NaN");
        assertThrows(function () { createClock({ capacity: 65535 }); }, RangeError, "maximum", "capacity 65535");

        assertThrows(function () { createClock(5); }, TypeError, "config", "config 5");
        assertThrows(function () { createClock("x"); }, TypeError, "config", "config string");

        assertNoThrow(function () { createClock({ capacity: 1 }); }, "capacity 1");
        assertNoThrow(function () { createClock({ capacity: 2 }); }, "capacity 2");
        assertNoThrow(function () { createClock({ capacity: 65534 }); }, "capacity 65534");
    }

    // ---- C-07: config-law -- unknown keys on both doors, non-boolean growable
    {
        // createClock door: near-miss typo -> did-you-mean; junk -> known-keys.
        assertThrows(function () { createClock({ capacty: 4 }); }, TypeError, "did you mean 'capacity'?", "createClock typo capacty");
        assertThrows(function () { createClock({ growble: true }); }, TypeError, "did you mean 'growable'?", "createClock typo growble");
        assertThrows(function () { createClock({ frobnicate: 1 }); }, TypeError, "known keys: capacity, growable", "createClock junk key");

        // lane door: near-miss typo -> did-you-mean; junk -> known-keys.
        const c = createClock();
        assertThrows(function () { c.lane({ duration: 10, onComplte: function () {} }); }, TypeError, "did you mean 'onComplete'?", "lane typo onComplte");
        assertThrows(function () { c.lane({ duratoin: 10 }); }, TypeError, "did you mean 'duration'?", "lane typo duratoin");
        assertThrows(function () { c.lane({ duration: 10, frobnicate: 1 }); }, TypeError, "known keys: duration, onComplete", "lane junk key");

        // growable non-boolean cross -- each throws naming the received type.
        assertThrows(function () { createClock({ growable: 1 }); }, TypeError, "growable must be a boolean (got number)", "growable 1");
        assertThrows(function () { createClock({ growable: 0 }); }, TypeError, "growable must be a boolean (got number)", "growable 0");
        assertThrows(function () { createClock({ growable: "true" }); }, TypeError, "growable must be a boolean (got string)", "growable string");
        assertThrows(function () { createClock({ growable: null }); }, TypeError, "growable must be a boolean (got null)", "growable null");
        assertThrows(function () { createClock({ growable: {} }); }, TypeError, "growable must be a boolean (got object)", "growable object");

        // Legal shapes stay legal: undefined keys are absent, booleans pass.
        assertNoThrow(function () { createClock({ growable: undefined }); }, "growable undefined");
        assertNoThrow(function () { createClock({ capacity: undefined }); }, "capacity undefined");
        assertNoThrow(function () { createClock({ capacity: 2, growable: true }); }, "growable true");
    }

    // ---- C-12: dur <= 0 is unreachable for any readable handle ------------
    // lane() rejects duration <= 0 and non-finite / non-number up front, so
    // durations[id] is always > 0 for an allocated slot. The deleted `dur <= 0`
    // branch inside t()/tPeek() was therefore unreachable for any readable
    // handle. Pin the rejection so the deletion stays safe forever.
    {
        const c = createClock();
        assertThrows(function () { c.lane({ duration: 0 }); }, RangeError, "duration", "C-12 lane duration 0");
        assertThrows(function () { c.lane({ duration: -1 }); }, RangeError, "duration", "C-12 lane duration negative");
        assertThrows(function () { c.lane({ duration: -1e9 }); }, RangeError, "duration", "C-12 lane duration large-negative");
        assertThrows(function () { c.lane({ duration: NaN }); }, RangeError, "duration", "C-12 lane duration NaN");
        assertThrows(function () { c.lane({ duration: "50" }); }, RangeError, "duration", "C-12 lane duration non-number");
        // A readable handle therefore always has duration > 0: t() is a finite
        // ratio and the deleted guard could never fire.
        const l = c.lane({ duration: 4 });
        l.start();
        c.advance(2);
        assertEq(l.tPeek(), 0.5, "C-12 readable handle has dur > 0 (t defined)");
    }

    // ---- capacity-1 clock: lane -> dispose -> lane again ------------------
    {
        const c = createClock({ capacity: 1 });
        const l = c.lane({ duration: 10 });
        l.start();
        l.dispose();
        assertNoThrow(function () { c.lane({ duration: 10 }); }, "capacity-1 realloc");
    }

    // ---- full-capacity alloc at 65534 then one more throws ----------------
    {
        const c = createClock({ capacity: 65534 });
        for (let i = 0; i < 65534; i = (i + 1) | 0) {
            c.lane({ duration: 1e9 });
        }
        assertThrows(function () { c.lane({ duration: 1e9 }); }, LiteClockCapacityError, "capacity", "full-pool exhaustion");
    }
}

// ---- control: the t1 config-law gate must be able to FAIL -------------------
// Drive the C-07 unknown-key detector against a deliberately fail-open shim that
// strips unknown keys and coerces growable with `=== true` (mimicking 1.1.0's
// silent ignore). The detector demands a typo'd key throw; the shim swallows it,
// so the detector must trip -> non-zero exit. This proves the t1 config cells
// are load-bearing, not decorative. A shim that somehow passes reaches exit 0
// so t9 catches a decorative gate.
export async function runControlConfig() {
    // Fail-open shim: silently drop any key not in the known list; growable via
    // `=== true` (the exact 1.1.0 behavior C-07 fixed).
    function shimClock(cfg) {
        const clean = {};
        if (cfg && cfg.capacity !== undefined) clean.capacity = cfg.capacity;
        clean.growable = (cfg && cfg.growable) === true;
        return createClock(clean);
    }
    try {
        // Detector: a typo'd config key MUST throw did-you-mean. The shim strips
        // it and returns a clock, so this assertThrows finds no throw and raises.
        assertThrows(function () { shimClock({ capacty: 4 }); }, TypeError, "did you mean", "control-config detector: typo must throw");
    } catch (e) {
        console.error("[control config] detector tripped as expected: " + (e && e.message));
        process.exit(1);
    }
    console.error("[control config] detector did NOT trip -- gate decorative");
    process.exit(0);
}
