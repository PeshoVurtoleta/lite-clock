// test/torture/t0-laws.mjs -- metamorphic determinism laws (GATING).
// Manual advance() only. Float reads compared with === (exact by construction:
// positions derive from simTime - startTimes and dt-splits add no float error
// when the sum is taken left-to-right in the same order).

import { createClock } from "../../Clock.js";
import { assert, assertEq } from "./harness.mjs";

// Preallocated scratch (allocated once, outside every loop).
const N = 6;
const DURS = [10, 25, 40, 55, 5e5, 1e9];
const fcA = new Int32Array(N);
const fcB = new Int32Array(N);

function armLanes(c, fireCounts) {
    const lanes = new Array(N);
    for (let i = 0; i < N; i = (i + 1) | 0) {
        const idx = i;
        const l = c.lane({ duration: DURS[idx], onComplete: function () { fireCounts[idx] = (fireCounts[idx] + 1) | 0; } });
        l.start();
        lanes[i] = l;
    }
    return lanes;
}

function compareLanes(la, lb, label) {
    for (let i = 0; i < N; i = (i + 1) | 0) {
        assertEq(la[i].positionPeek(), lb[i].positionPeek(), function () { return label + " position lane " + i; });
        assertEq(la[i].tPeek(), lb[i].tPeek(), function () { return label + " t lane " + i; });
        assertEq(la[i].donePeek(), lb[i].donePeek(), function () { return label + " done lane " + i; });
    }
}

function compareFireCounts(fa, fb, label) {
    for (let i = 0; i < N; i = (i + 1) | 0) {
        assertEq(fa[i], fb[i], function () { return label + " fireCount lane " + i; });
    }
}

export async function run() {
    // ---- dt-split invariance: advance(a);advance(b) == advance(a+b) --------
    {
        const a = 16.67, b = 33.33;
        fcA.fill(0); fcB.fill(0);
        const c1 = createClock(); const l1 = armLanes(c1, fcA);
        c1.advance(a); c1.advance(b);
        const c2 = createClock(); const l2 = armLanes(c2, fcB);
        c2.advance(a + b);
        assertEq(c1.simTime, c2.simTime, "dt-split simTime");
        compareLanes(l1, l2, "dt-split 2way");
        compareFireCounts(fcA, fcB, "dt-split 2way");
        assert(c1._invariant() === null, function () { return "dt-split c1 invariant: " + c1._invariant(); });
        assert(c2._invariant() === null, function () { return "dt-split c2 invariant: " + c2._invariant(); });
    }

    // ---- 3-way split vs ((a+b)+c) -----------------------------------------
    {
        const a = 16.67, b = 33.33, c = 8.33;
        fcA.fill(0); fcB.fill(0);
        const cx = createClock(); const lx = armLanes(cx, fcA);
        cx.advance(a); cx.advance(b); cx.advance(c);
        const cy = createClock(); const ly = armLanes(cy, fcB);
        cy.advance((a + b) + c);
        assertEq(cx.simTime, cy.simTime, "dt-split 3way simTime");
        compareLanes(lx, ly, "dt-split 3way");
        compareFireCounts(fcA, fcB, "dt-split 3way");
    }

    // ---- advanceTo(t) == advance(t - simTime) -----------------------------
    {
        fcA.fill(0); fcB.fill(0);
        const c1 = createClock(); const l1 = armLanes(c1, fcA);
        c1.advanceTo(50);
        const c2 = createClock(); const l2 = armLanes(c2, fcB);
        c2.advance(50);
        assertEq(c1.simTime, c2.simTime, "advanceTo simTime");
        compareLanes(l1, l2, "advanceTo");
        compareFireCounts(fcA, fcB, "advanceTo");
    }

    // ---- replay determinism: same op script -> identical logs -------------
    {
        const log1 = [];
        const log2 = [];
        runScript(createClock(), log1);
        runScript(createClock(), log2);
        assertEq(log1.length, log2.length, "replay log length");
        for (let i = 0; i < log1.length; i = (i + 1) | 0) {
            assertEq(log1[i], log2[i], function () { return "replay log[" + i + "]"; });
        }
    }

    // ---- pause(); start() at same simTime is a position identity ----------
    {
        const c = createClock();
        const l = c.lane({ duration: 100 });
        l.start();
        c.advance(37.5);
        const pBefore = l.positionPeek();
        const tBefore = l.tPeek();
        l.pause();
        l.start();
        assertEq(l.positionPeek(), pBefore, "pause/start position identity");
        assertEq(l.tPeek(), tBefore, "pause/start t identity");
    }

    // ---- reverse(); reverse() identity ------------------------------------
    {
        const c = createClock();
        const l = c.lane({ duration: 100 });
        l.start();
        c.advance(42);
        const p = l.positionPeek();
        const t = l.tPeek();
        const d = l.donePeek();
        l.reverse();
        l.reverse();
        assertEq(l.positionPeek(), p, "reverse2 position identity");
        assertEq(l.tPeek(), t, "reverse2 t identity");
        assertEq(l.donePeek(), d, "reverse2 done identity");
    }

    // ---- conservation: churn, fresh, mass completion ----------------------
    {
        const fresh = createClock();
        assert(fresh._invariant() === null, "fresh invariant");

        const c = createClock({ capacity: 64 });
        const held = [];
        for (let i = 0; i < 40; i = (i + 1) | 0) {
            const l = c.lane({ duration: 100 });
            l.start();
            held.push(l);
        }
        for (let i = 0; i < 40; i = (i + 1) | 0) {
            if ((i & 1) === 0) held[i].dispose();
        }
        c.advance(10);
        assert(c._invariant() === null, function () { return "churn invariant: " + c._invariant(); });

        // Mass completion.
        c.advance(1e6);
        assert(c._invariant() === null, function () { return "mass-completion invariant: " + c._invariant(); });
        assertEq(c.activeCount, 0, "mass-completion activeCount");
    }

    // ---- exact boundary: advance(d) completes exactly at d ----------------
    {
        const c = createClock();
        let fires = 0;
        const d = 250;
        const l = c.lane({ duration: d, onComplete: function () { fires = (fires + 1) | 0; } });
        l.start();
        c.advance(d);
        assertEq(l.positionPeek(), d, "boundary position");
        assertEq(l.tPeek(), 1, "boundary t");
        assertEq(l.donePeek(), true, "boundary done");
        assertEq(fires, 1, "boundary fire count");
    }
}

// A fixed scripted op sequence. Callbacks log a label into `log`; reads and
// simTime are appended so two runs produce byte-identical logs.
function runScript(c, log) {
    const a = c.lane({ duration: 30, onComplete: function () { log.push("cb:a"); } });
    const b = c.lane({ duration: 45, onComplete: function () { log.push("cb:b"); } });
    const e = c.lane({ duration: 100 });
    a.start(); b.start(); e.start();
    c.advance(10);
    log.push("s:" + c.simTime + " a:" + a.tPeek() + " b:" + b.tPeek());
    e.pause();
    c.advance(25);
    log.push("s:" + c.simTime + " a:" + a.donePeek());
    e.start();
    b.reverse();
    c.advance(20);
    log.push("s:" + c.simTime + " b:" + b.donePeek() + " e:" + e.tPeek());
    a.dispose();
    c.advance(1000);
    log.push("s:" + c.simTime + " e:" + e.donePeek() + " active:" + c.activeCount);
}
