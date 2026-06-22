// 09-determinism.test.mjs
// The same sequence of advance(dt) calls produces identical state across
// two clocks. This is the property lite-rollback will eventually depend on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

function snapshotState(c, lanes) {
    return {
        simTime: c.simTime,
        ticks: c.ticks,
        activeCount: c.activeCount,
        positions: lanes.map((l) => l.positionPeek()),
        ts: lanes.map((l) => l.tPeek()),
        dones: lanes.map((l) => l.donePeek())
    };
}

test("determinism: identical dt sequence yields identical state", () => {
    function buildAndRun(dts, startBeforeSecondAdvance) {
        const c = createClock();
        const a = c.lane({ duration: 200 });
        const b = c.lane({ duration: 150 });
        const x = c.lane({ duration: 50 });
        a.start(); b.start(); x.start();

        const beforeSnap = snapshotState(c, [a, b, x]);

        for (let i = 0; i < dts.length; i++) c.advance(dts[i]);
        return [beforeSnap, snapshotState(c, [a, b, x])];
    }

    const dts = [16.67, 33.33, 16.67, 100, 50, 25];
    const r1 = buildAndRun(dts);
    const r2 = buildAndRun(dts);
    assert.deepEqual(r1, r2);
});

test("determinism: pause/start/reverse sequence reproduces", () => {
    function trial() {
        const c = createClock();
        const l = c.lane({ duration: 100 });
        l.start();
        c.advance(20);
        l.pause();
        c.advance(50);  // sim time advances, lane untouched
        l.start();
        c.advance(15);
        l.reverse();
        c.advance(10);
        return {
            simTime: c.simTime,
            position: l.positionPeek(),
            t: l.tPeek(),
            done: l.donePeek()
        };
    }
    assert.deepEqual(trial(), trial());
});

test("determinism: completion fires at the same simTime across runs", () => {
    function trial() {
        const c = createClock();
        let firedAt = null;
        const l = c.lane({
            duration: 75,
            onComplete: () => { firedAt = c.simTime; }
        });
        l.start();
        c.advance(20);
        c.advance(20);
        c.advance(20);
        c.advance(20);  // crosses 75 here
        return firedAt;
    }
    const t1 = trial();
    const t2 = trial();
    assert.equal(t1, t2);
    assert.equal(t1, 80);  // exact: sum of dts that crossed duration
});

test("determinism: advanceTo equivalent to advance with the same delta", () => {
    const c1 = createClock();
    const c2 = createClock();
    const l1 = c1.lane({ duration: 100 });
    const l2 = c2.lane({ duration: 100 });
    l1.start(); l2.start();

    c1.advance(33.33);
    c2.advanceTo(33.33);

    assert.equal(c1.simTime, c2.simTime);
    assert.equal(l1.positionPeek(), l2.positionPeek());
    assert.equal(l1.tPeek(), l2.tPeek());
});
