// 08-capacity.test.mjs
// Capacity exhaustion policies: hard cap (throw) vs growable (double).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock, LiteClockCapacityError } from "../Clock.js";

test("capacity: default throws on exhaust with actionable message", () => {
    const c = createClock({ capacity: 3 });
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });
    try {
        c.lane({ duration: 10 });
        assert.fail("expected throw");
    } catch (e) {
        assert.ok(e instanceof LiteClockCapacityError);
        assert.ok(/capacity 3/.test(e.message));
        assert.ok(/growable: true/.test(e.message), "message should suggest growable");
        assert.equal(e.capacity, 3);
    }
});

test("capacity: growable doubles the pool", () => {
    const c = createClock({ capacity: 4, growable: true });
    for (let i = 0; i < 5; i++) c.lane({ duration: 10 });
    assert.equal(c.capacity, 8);
});

test("capacity: growable doubles repeatedly", () => {
    const c = createClock({ capacity: 4, growable: true });
    for (let i = 0; i < 20; i++) c.lane({ duration: 10 });
    assert.ok(c.capacity >= 32);
});

test("capacity: growable preserves existing lane state across grow", () => {
    const c = createClock({ capacity: 2, growable: true });
    const a = c.lane({ duration: 100 });
    a.start();
    c.advance(30);
    assert.equal(a.positionPeek(), 30);

    // Force a grow.
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });

    // Original lane still tracks correctly through the SOA-array relocation.
    c.advance(20);
    assert.equal(a.positionPeek(), 50);
    assert.ok(c.capacity > 2);
});

test("capacity: dispose returns slot so allocate works again under throw", () => {
    const c = createClock({ capacity: 2 });
    const a = c.lane({ duration: 10 });
    const b = c.lane({ duration: 10 });
    assert.throws(() => c.lane({ duration: 10 }), LiteClockCapacityError);
    a.dispose();
    const fresh = c.lane({ duration: 10 });
    assert.ok(fresh);
});

test("capacity: rejects capacity over MAX_LANES even with growable", () => {
    // We can construct up to 65534. Growable cannot push beyond that.
    const c = createClock({ capacity: 0xFFFE - 2, growable: true });
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });
    // Allocations within initial capacity are fine; growth would try to double
    // beyond MAX_LANES and must throw.
    for (let i = 0; i < (0xFFFE - 4); i++) c.lane({ duration: 10 });
    // Now the pool is full at 65534 and growth to 131068 would exceed MAX_LANES.
    assert.throws(() => c.lane({ duration: 10 }), LiteClockCapacityError);
});
