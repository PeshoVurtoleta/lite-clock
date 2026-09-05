// 01-create.test.mjs
// createClock config validation, capacity bounds, frozen public surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, LiteClockCapacityError } from "../Clock.js";

test("create: defaults work with no config", () => {
    const c = createClock();
    assert.equal(c.simTime, 0);
    assert.equal(c.ticks, 0);
    assert.equal(c.capacity, 1024);
    assert.equal(c.activeCount, 0);
});

test("create: accepts undefined and null config", () => {
    const a = createClock(undefined);
    const b = createClock(null);
    assert.equal(a.capacity, 1024);
    assert.equal(b.capacity, 1024);
});

test("create: custom capacity", () => {
    const c = createClock({ capacity: 256 });
    assert.equal(c.capacity, 256);
});

test("create: rejects non-integer capacity", () => {
    assert.throws(() => createClock({ capacity: 1.5 }), RangeError);
    assert.throws(() => createClock({ capacity: "1024" }), RangeError);
    assert.throws(() => createClock({ capacity: NaN }), RangeError);
});

test("create: rejects zero or negative capacity", () => {
    assert.throws(() => createClock({ capacity: 0 }),  RangeError);
    assert.throws(() => createClock({ capacity: -1 }), RangeError);
});

test("create: rejects capacity > 65534", () => {
    assert.throws(() => createClock({ capacity: 65535 }), RangeError);
    assert.throws(() => createClock({ capacity: 1_000_000 }), RangeError);
});

test("create: accepts capacity at the boundary", () => {
    const c = createClock({ capacity: 65534 });
    assert.equal(c.capacity, 65534);
});

test("create: growable opt-in is honored", () => {
    const c = createClock({ capacity: 2, growable: true });
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });
    // Third allocation triggers grow.
    c.lane({ duration: 10 });
    assert.ok(c.capacity > 2);
});

test("create: non-boolean growable is a config error (fail closed)", () => {
    // Was permissive in 1.1.0 (=== true silently disabled grow). 1.2.0 fails
    // closed: a present non-boolean growable throws TypeError.
    assert.throws(
        () => createClock({ capacity: 2, growable: "yes" }),
        (e) => e instanceof TypeError && /growable must be a boolean/.test(e.message)
    );
});

test("create: public surface is frozen", () => {
    const c = createClock();
    assert.equal(Object.isFrozen(c), true);
});

test("create: LiteClockCapacityError carries capacity field", () => {
    const c = createClock({ capacity: 1 });
    c.lane({ duration: 10 });
    try {
        c.lane({ duration: 10 });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof LiteClockCapacityError);
        assert.equal(e.name, "LiteClockCapacityError");
        assert.equal(e.capacity, 1);
    }
});

test("create: rejects non-object config", () => {
    assert.throws(() => createClock(42), TypeError);
    assert.throws(() => createClock("config"), TypeError);
});
