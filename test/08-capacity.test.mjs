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

test("capacity: growth clamps to MAX_LANES, then throws AT the ceiling", () => {
    // C-05: near-ceiling growth is a clamp, not a double. Start full at 65532,
    // where 1.1.0 threw because 65532*2 overshoots MAX_LANES. 1.2.0 clamps the
    // final step to 65534 (the documented ceiling), so growth succeeds here.
    const c = createClock({ capacity: 0xFFFE - 2, growable: true });   // 65532
    for (let i = 0; i < (0xFFFE - 2); i++) c.lane({ duration: 10 });   // fill 65532
    c.lane({ duration: 10 });                                          // grows -> 65534
    assert.equal(c.capacity, 0xFFFE);
    // Fill the two clamped slots, then the pool is full AT the ceiling; the next
    // lane throws because capacity is already MAX_LANES, not because a double
    // would overshoot.
    c.lane({ duration: 10 });
    assert.throws(() => c.lane({ duration: 10 }), LiteClockCapacityError);
});
