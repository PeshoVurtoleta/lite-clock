// 13-config-law.test.mjs
// Fail-closed config validation (C-07) and the reachable growth ceiling (C-05).
//
// FAIL-BEFORE evidence (pre-K3 Clock.js, captured via a temp-dir copy probe):
//   C-07a  createClock({capacty:4}).capacity = 1024   (silent -- no throw)
//   C-07b  lane({onComplte:fn}) fired = false, donePeek = true  (silent no-fire)
//   C-07c  createClock({growable:1}) exhaustion -> LiteClockCapacityError, cap 1024
//          (i.e. `1` was silently treated as false)
//   C-05   createClock({growable:true}) ceiling = capacity 32768  (docs claim 65534)
// PASS-AFTER: each of these now throws a TypeError with a did-you-mean hint, a
// non-boolean growable throws, and growth reaches exactly 65534.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, LiteClockCapacityError } from "../Clock.js";

// ---- C-07a: unknown createClock key with a near match -------------------------
test("config-law C-07a: createClock unknown 'capacty' throws did-you-mean", () => {
    assert.throws(
        () => createClock({ capacty: 4 }),
        (e) => e instanceof TypeError
            && e.message === "createClock: unknown option 'capacty' -- did you mean 'capacity'?"
    );
});

// ---- C-07b: unknown lane key with a near match -------------------------------
test("config-law C-07b: lane unknown 'onComplte' throws did-you-mean", () => {
    const c = createClock();
    assert.throws(
        () => c.lane({ duration: 10, onComplte: () => {} }),
        (e) => e instanceof TypeError
            && e.message === "clock.lane: unknown option 'onComplte' -- did you mean 'onComplete'?"
    );
});

// ---- C-07c: non-boolean growable throws (no longer silently false) -----------
test("config-law C-07c: createClock growable:1 throws (not silently false)", () => {
    assert.throws(
        () => createClock({ growable: 1 }),
        (e) => e instanceof TypeError && e.message === "createClock: growable must be a boolean (got number)"
    );
});

// ---- no-near-match junk lists the known keys --------------------------------
test("config-law: junk createClock key lists known keys", () => {
    assert.throws(
        () => createClock({ frobnicate: true }),
        (e) => e instanceof TypeError
            && e.message === "createClock: unknown option 'frobnicate' (known keys: capacity, growable)"
    );
});

test("config-law: junk lane key lists known keys", () => {
    const c = createClock();
    assert.throws(
        () => c.lane({ duration: 10, frobnicate: true }),
        (e) => e instanceof TypeError
            && e.message === "clock.lane: unknown option 'frobnicate' (known keys: duration, onComplete)"
    );
});

// ---- growable non-boolean cross ---------------------------------------------
test("config-law: non-boolean growable cross all throw TypeError naming the type", () => {
    assert.throws(() => createClock({ growable: 1 }),
        (e) => e instanceof TypeError && /got number/.test(e.message));
    assert.throws(() => createClock({ growable: 0 }),
        (e) => e instanceof TypeError && /got number/.test(e.message));
    assert.throws(() => createClock({ growable: "true" }),
        (e) => e instanceof TypeError && /got string/.test(e.message));
    assert.throws(() => createClock({ growable: null }),
        (e) => e instanceof TypeError && /got null/.test(e.message));
    assert.throws(() => createClock({ growable: {} }),
        (e) => e instanceof TypeError && /got object/.test(e.message));
});

// ---- boolean growable stays legal both ways ---------------------------------
test("config-law: growable true/false are legal", () => {
    assert.equal(createClock({ growable: false }).capacity, 1024);
    assert.equal(createClock({ capacity: 2, growable: true }).capacity, 2);
});

// ---- undefined keys are treated as absent (legal) ---------------------------
test("config-law: growable:undefined is absent (legal, defaults to false)", () => {
    const c = createClock({ growable: undefined });
    assert.equal(c.capacity, 1024);
    // Absent growable == hard cap: exhaustion throws.
    const d = createClock({ capacity: 1, growable: undefined });
    d.lane({ duration: 10 });
    assert.throws(() => d.lane({ duration: 10 }), LiteClockCapacityError);
});

test("config-law: capacity:undefined is absent (legal, defaults to 1024)", () => {
    assert.equal(createClock({ capacity: undefined }).capacity, 1024);
});

// ---- C-05: the documented ceiling of 65534 is reachable ---------------------
// Single full-trajectory allocation (a 65534-slot pool is ~2.5 MB). The same
// clock proves (1) the exact doubling-then-clamp capacity trajectory,
// (2) the 65535th lane throws LiteClockCapacityError(65534), and (3) a
// pre-growth lane's peeks survive the whole growth bit-identically.
test("config-law C-05: growable ceiling reaches exactly 65534, 65535th throws", () => {
    const c = createClock({ growable: true });

    // A pre-growth marker lane with a captured position/t/done baseline.
    const marker = c.lane({ duration: 100 });
    marker.start();
    c.advance(30);
    const posBefore = marker.positionPeek();
    const tBefore = marker.tPeek();
    const doneBefore = marker.donePeek();
    assert.equal(posBefore, 30);
    assert.equal(tBefore, 0.3);
    assert.equal(doneBefore, false);

    // Allocate until exhaustion, recording every distinct capacity.
    const trajectory = [c.capacity];
    let err = null;
    let n = 1;                                   // marker already allocated
    try {
        for (;;) {
            c.lane({ duration: 1e9 });
            n = (n + 1) | 0;
            if (c.capacity !== trajectory[trajectory.length - 1]) {
                trajectory.push(c.capacity);
            }
        }
    } catch (e) {
        err = e;
    }

    assert.deepEqual(trajectory, [1024, 2048, 4096, 8192, 16384, 32768, 65534]);
    assert.equal(c.capacity, 65534);
    assert.equal(n, 65534);                      // exactly 65534 lanes allocated
    assert.ok(err instanceof LiteClockCapacityError, "65535th lane throws CapacityError");
    assert.equal(err.capacity, 65534);

    // The marker survived six relocations bit-identically (no advance between).
    assert.equal(marker.positionPeek(), posBefore);
    assert.equal(marker.tPeek(), tBefore);
    assert.equal(marker.donePeek(), doneBefore);

    // Conservation holds after the clamped final growth.
    assert.equal(c._invariant(), null);
});
