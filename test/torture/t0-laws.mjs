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

// ---- loop/pingPong arm helpers (dt-split invariance for cycling lanes) ------
// Mixed loop and pingPong lanes. Lane 2's duration is deliberately NON-DYADIC
// (0.3): k*dur then rounds differently per carry event, so the split-equality
// assertions are ulp-sensitive and FAIL if the engine regresses to a float-
// accumulating carry (reviewer blocker; see scratch failbefore-k4 evidence --
// the naive carry diverges at dur=0.3 while the recompute stays bit-equal).
// Integer dts keep simTime itself bit-identical across the splits.
const M = 4;
const LOOP_DURS = [10, 8, 0.3, 4];
const LOOP_MODES = ["loop", "pingPong", "loop", "pingPong"];
const lfcA = new Int32Array(M);
const lfcB = new Int32Array(M);

function armLoopLanes(c, fireCounts) {
    const lanes = new Array(M);
    for (let i = 0; i < M; i = (i + 1) | 0) {
        const idx = i;
        const opts = { duration: LOOP_DURS[idx], onComplete: function () { fireCounts[idx] = (fireCounts[idx] + 1) | 0; } };
        if (LOOP_MODES[idx] === "loop") opts.loop = true; else opts.pingPong = true;
        const l = c.lane(opts);
        l.start();
        lanes[i] = l;
    }
    return lanes;
}

function compareLoopLanes(la, lb, label) {
    for (let i = 0; i < M; i = (i + 1) | 0) {
        assertEq(la[i].positionPeek(), lb[i].positionPeek(), function () { return label + " position loop-lane " + i; });
        assertEq(la[i].tPeek(), lb[i].tPeek(), function () { return label + " t loop-lane " + i; });
        assertEq(la[i].donePeek(), lb[i].donePeek(), function () { return label + " done loop-lane " + i; });
    }
}

function compareLoopFireCounts(fa, fb, label) {
    for (let i = 0; i < M; i = (i + 1) | 0) {
        assertEq(fa[i], fb[i], function () { return label + " fireCount loop-lane " + i; });
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

    // ---- loop/pingPong dt-split invariance (2-way) ------------------------
    // Same total reached two ways yields bit-identical positions/t/done AND
    // identical per-lane onComplete fire counts for cycling lanes.
    {
        const a = 17, b = 13;                  // total 30 (exact; no float error)
        lfcA.fill(0); lfcB.fill(0);
        const c1 = createClock(); const l1 = armLoopLanes(c1, lfcA);
        c1.advance(a); c1.advance(b);
        const c2 = createClock(); const l2 = armLoopLanes(c2, lfcB);
        c2.advance(a + b);
        assertEq(c1.simTime, c2.simTime, "loop dt-split 2way simTime");
        compareLoopLanes(l1, l2, "loop dt-split 2way");
        compareLoopFireCounts(lfcA, lfcB, "loop dt-split 2way");
    }

    // ---- loop/pingPong dt-split invariance (3-way) ------------------------
    {
        const a = 12, b = 7, c = 11;           // total 30
        lfcA.fill(0); lfcB.fill(0);
        const cx = createClock(); const lx = armLoopLanes(cx, lfcA);
        cx.advance(a); cx.advance(b); cx.advance(c);
        const cy = createClock(); const ly = armLoopLanes(cy, lfcB);
        cy.advance((a + b) + c);
        assertEq(cx.simTime, cy.simTime, "loop dt-split 3way simTime");
        compareLoopLanes(lx, ly, "loop dt-split 3way");
        compareLoopFireCounts(lfcA, lfcB, "loop dt-split 3way");
    }

    // ---- loop/pingPong: one call spans >=3 cycles vs one-per-call crossing --
    // Left side is a single advance(30) (the dur-10 and dur-4 lanes each span
    // >=3 cycles in one call); right side crosses one cycle per call for the
    // dur-10 lane (advance(10) x3). State + fire counts must match bit-for-bit.
    {
        lfcA.fill(0); lfcB.fill(0);
        const cs = createClock(); const ls = armLoopLanes(cs, lfcA);
        cs.advance(30);
        const cm = createClock(); const lm = armLoopLanes(cm, lfcB);
        cm.advance(10); cm.advance(10); cm.advance(10);
        assertEq(cs.simTime, cm.simTime, "loop span-vs-step simTime");
        compareLoopLanes(ls, lm, "loop span-vs-step");
        compareLoopFireCounts(lfcA, lfcB, "loop span-vs-step");
    }

    // ---- loop carry ulp-sensitivity at scale (probe-pinned recipe) --------
    // dur=0.3, total 3000 (10000 cycles): the fail-before probe shows a
    // float-accumulating carry ends ~0.3 OFF between these two splits while
    // the recompute carry is bit-equal (scratch failbefore-k4: hex-divergent
    // at exactly this recipe). Span (one advance) vs unit steps (x3000).
    {
        let fa = 0, fb = 0;
        const ca = createClock();
        const la = ca.lane({ duration: 0.3, loop: true, onComplete: function () { fa = (fa + 1) | 0; } });
        la.start();
        ca.advance(3000);
        const cb = createClock();
        const lb = cb.lane({ duration: 0.3, loop: true, onComplete: function () { fb = (fb + 1) | 0; } });
        lb.start();
        for (let s = 0; s < 3000; s = (s + 1) | 0) cb.advance(1);
        assertEq(ca.simTime, cb.simTime, "loop ulp-recipe simTime");
        assertEq(la.positionPeek(), lb.positionPeek(), "loop ulp-recipe position");
        assertEq(la.tPeek(), lb.tPeek(), "loop ulp-recipe t");
        assertEq(fa, fb, "loop ulp-recipe fire count");
    }

    // ---- pingPong triangle closed form vs an integer-k oracle -------------
    // dur 8, 41 steps of 1.7. After each step compare tPeek against an
    // independently tracked oracle computing base + k*dur with the SAME
    // expression (never %), reflecting on odd k. simTime is accumulated by the
    // same left-to-right addition the engine uses, so the compare is exact.
    {
        const dur = 8, step = 1.7, base = 0;
        const c = createClock();
        const l = c.lane({ duration: dur, pingPong: true });
        l.start();
        let simTime = 0;
        for (let s = 0; s < 41; s = (s + 1) | 0) {
            c.advance(step);
            simTime = simTime + step;
            const k = Math.floor((simTime - base) / dur);
            const startT = base + k * dur;
            const pos = simTime - startT;
            const ratio = pos / dur;
            const expected = ((k & 1) === 1) ? (1 - ratio) : ratio;
            const si = s;
            assertEq(l.tPeek(), expected, function () { return "pingPong triangle step " + si + " (k=" + k + ")"; });
            assertEq(l.donePeek(), false, function () { return "pingPong triangle never done step " + si; });
        }
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

    // ---- snapshot/hydrate round-trip law (K5, D1/D2/D3) --------------------
    // same-clock snapshot -> hydrate -> advance(seq) is bit-identical to an
    // uninterrupted advance(seq): compared by byte-equal final snapshots AND
    // per-lane onComplete fire counts. Mixed one-shot/loop/pingPong lanes, a
    // non-dyadic (0.3) cycling duration, and a re-advance sequence that crosses
    // multiple cycles. The window contains no lane()/dispose() (D1a), so refire
    // fidelity is exact. Cross-clock virgin-hydrate variant proves A2.
    {
        // Reference: uninterrupted advance of the whole sequence.
        const fcU = new Int32Array(RT_N);
        const cU = createClock();
        const lU = armRoundTrip(cU, fcU);
        for (let i = 0; i < RT_WARM.length; i = (i + 1) | 0) cU.advance(RT_WARM[i]);
        for (let i = 0; i < RT_SEQ.length; i = (i + 1) | 0) cU.advance(RT_SEQ[i]);
        const bufU = new Uint8Array(cU.snapshotSize());
        cU.snapshot(bufU);

        // Same-clock round-trip: warm, snapshot at P, hydrate back onto self,
        // then advance the tail sequence.
        const fcR = new Int32Array(RT_N);
        const cR = createClock();
        const lR = armRoundTrip(cR, fcR);
        for (let i = 0; i < RT_WARM.length; i = (i + 1) | 0) cR.advance(RT_WARM[i]);
        const bufP = new Uint8Array(cR.snapshotSize());
        cR.snapshot(bufP);
        cR.hydrate(bufP);
        for (let i = 0; i < RT_SEQ.length; i = (i + 1) | 0) cR.advance(RT_SEQ[i]);
        const bufR = new Uint8Array(cR.snapshotSize());
        cR.snapshot(bufR);

        assertBytesEqual(bufU, bufR, "round-trip same-clock final snapshot");
        for (let i = 0; i < RT_N; i = (i + 1) | 0) {
            assertEq(fcR[i], fcU[i], function () { return "round-trip same-clock fire count lane " + i; });
        }
        assertEq(lR.length, lU.length, "round-trip lane count");

        // Cross-clock variant: hydrate P onto a virgin same-capacity clock, drive
        // the identical tail, compare byte-equal to the uninterrupted reference.
        const cX = createClock();
        cX.hydrate(bufP);
        for (let i = 0; i < RT_SEQ.length; i = (i + 1) | 0) cX.advance(RT_SEQ[i]);
        const bufX = new Uint8Array(cX.snapshotSize());
        cX.snapshot(bufX);
        assertBytesEqual(bufU, bufX, "round-trip cross-clock final snapshot");
    }

    // ---- k-fold-adjacent capture (K5) -------------------------------------
    // Capture ONE step short of a Uint32 cycle-count fold (2^30) on a dur-1 loop
    // lane, hydrate onto a virgin clock, then advance across the fold on both.
    // Byte-equal final snapshots prove the fold is restored path-independently.
    {
        const cU = createClock();
        const lU = cU.lane({ duration: 1, loop: true });
        lU.start();
        cU.advance((2 ** 30) - 1 + 0.5);           // one cycle short of the fold
        const bufP = new Uint8Array(cU.snapshotSize());
        cU.snapshot(bufP);

        const cH = createClock();
        cH.hydrate(bufP);
        cU.advance(4.25);                           // crosses the fold
        cH.advance(4.25);

        const bufU = new Uint8Array(cU.snapshotSize());
        const bufH = new Uint8Array(cH.snapshotSize());
        cU.snapshot(bufU);
        cH.snapshot(bufH);
        assertBytesEqual(bufU, bufH, "k-fold-adjacent capture final snapshot");
        assertEq(cU.simTime, cH.simTime, "k-fold-adjacent simTime");
        assertEq(lU.positionPeek(), 0.75, "k-fold-adjacent position post-fold");
    }
}

// ---- round-trip law fixtures (K5) -----------------------------------------
// Mixed lanes with counting callbacks; a non-dyadic 0.3 cycling duration keeps
// the carry ulp-sensitive. RT_WARM reaches a mid-state P; RT_SEQ is the tail
// re-advanced identically on every world. Integer + .5 dts keep simTime exact.
const RT_N = 6;
const RT_DURS = [40, 7, 10, 0.3, 8, 1e9];
const RT_MODES = [0, 0, "loop", "loop", "pingPong", 0];
const RT_WARM = [12.5, 9, 3.5];
const RT_SEQ = [5, 17.5, 2, 30, 0.5, 100];

function armRoundTrip(c, fireCounts) {
    const lanes = new Array(RT_N);
    for (let i = 0; i < RT_N; i = (i + 1) | 0) {
        const idx = i;
        const opts = { duration: RT_DURS[idx], onComplete: function () { fireCounts[idx] = (fireCounts[idx] + 1) | 0; } };
        if (RT_MODES[idx] === "loop") opts.loop = true;
        else if (RT_MODES[idx] === "pingPong") opts.pingPong = true;
        const l = c.lane(opts);
        l.start();
        lanes[i] = l;
    }
    return lanes;
}

function assertBytesEqual(a, b, label) {
    assertEq(a.length, b.length, function () { return label + " length"; });
    for (let i = 0; i < a.length; i = (i + 1) | 0) {
        if (a[i] !== b[i]) {
            assertEq(a[i], b[i], function () { return label + " byte " + i; });
        }
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
