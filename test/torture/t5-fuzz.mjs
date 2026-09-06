// test/torture/t5-fuzz.mjs -- differential fuzz vs a naive per-lane oracle.
// GATING (K1): 100K seeded mixed ops (advance/advanceTo/lane/start/pause/
// reverse/dispose + callbacks that log order, dispose others, start others,
// create others, and RE-ENTER advance) driven against a naive per-lane object
// oracle implementing the SAME contract -- including the re-entrancy throw, the
// active-list swap-on-remove ordering, the captured drain queue, and the
// DONE-recheck skip. After every advance we compare simTime, every live lane's
// positionPeek/tPeek/donePeek, and the callback order logs. On divergence the
// seed and op index print (TORTURE_SEED replays). Stale-handle ABA (C-04) is
// out of K1 scope, so ops never touch a slot that is dead in either world.
// Also gates the C-07 config-law: the three fail-open probe shapes now throw.

import { createClock, LiteClockReentrancyError } from "../../Clock.js";
import { AssertionError, makeRng, SEED, assertThrows } from "./harness.mjs";

const OPS = 100000;
const MAX_LIVE = 48;

// Callback kinds.
const CB_NONE = 0;
const CB_LOG = 1;
const CB_REENTER = 2;
const CB_DISPOSE_OTHER = 3;
const CB_START_OTHER = 4;
const CB_CREATE_OTHER = 5;

// ---------------------------------------------------------------------------
// Naive per-lane object oracle. Mirrors the engine contract faithfully: same
// active-list swap-remove ordering, same captured-queue + DONE-recheck drain,
// same re-entrancy guard. It may allocate freely (not under the gc gate).
// ---------------------------------------------------------------------------
function makeOracle() {
    const activeList = [];
    let simTime = 0;
    let advancing = false;
    let timeScale = 1;

    // mode: 0 (one-shot), "loop", or "pingPong". base/k mirror baseStartTimes/
    // cycleCounts; ONE reversed boolean carries both user reverse() and the
    // pingPong per-cycle flip (they XOR the same flag). gen mirrors the slot
    // generation for the drain re-check.
    function createLane(dur, cb, mode) {
        return {
            alloc: true, active: false, done: false, reversed: false,
            start: 0, base: 0, k: 0, dur: dur, pos: 0, cb: cb, aidx: -1, gen: 0,
            loop: mode === "loop", pingPong: mode === "pingPong"
        };
    }
    function start(L) {
        if (!L.alloc) return;
        if (L.active) return;
        if (L.done) return;
        L.active = true;
        L.start = simTime - L.pos;
        L.base = L.start;
        L.k = 0;
        L.aidx = activeList.length;
        activeList.push(L);
    }
    function removeFromActive(L) {
        const idx = L.aidx;
        if (idx < 0) return;
        const last = activeList.length - 1;
        const lastL = activeList[last];
        if (idx !== last) { activeList[idx] = lastL; lastL.aidx = idx; }
        activeList.pop();
        L.aidx = -1;
    }
    function pause(L) {
        if (!L.alloc) return;
        if (!L.active) return;
        L.pos = simTime - L.start;
        L.active = false;
        removeFromActive(L);
    }
    function reverse(L) { if (!L.alloc) return; L.reversed = !L.reversed; }
    function seek(L, p) {
        if (!L.alloc) return;                       // stale/disposed -- no-op
        const dur = L.dur;
        if (p < 0) p = 0; else if (p > dur) p = dur;
        L.pos = p;
        L.start = simTime - p;
        L.base = L.start;
        L.k = 0;
        if (p < dur) L.done = false;                // clears DONE iff p < dur
    }
    function restart(L) {
        if (!L.alloc) return;
        seek(L, 0);
        start(L);
    }
    function dispose(L) {
        if (!L.alloc) return;
        if (L.active) removeFromActive(L);
        L.alloc = false; L.active = false; L.done = false; L.cb = undefined; L.pos = 0;
        L.gen = (L.gen + 1) >>> 0;                   // retire this token
    }
    function setTimeScale(v) { timeScale = v; }
    function advanceBy(delta) {
        if (advancing) throw new LiteClockReentrancyError();
        advancing = true;
        if (delta === 0) {
            try { /* dt=0 tick: compaction skipped, no completions */ } finally { advancing = false; }
            return;
        }
        simTime = simTime + delta;
        const queue = [];      // parallel {L, cycles, gen}
        let writeIdx = 0;
        const ac = activeList.length;
        for (let readIdx = 0; readIdx < ac; readIdx = (readIdx + 1) | 0) {
            const L = activeList[readIdx];
            const elapsed = simTime - L.start;
            const dur = L.dur;
            if (elapsed >= dur) {
                if (L.loop || L.pingPong) {
                    // Mirror limitation: this branch reuses the engine's exact
                    // carry expressions, so a bug INSIDE the shared expression
                    // is invisible to the fuzz by construction. t0's non-dyadic
                    // dt-split cases and the t9 naive-carry control carry that
                    // burden on the real engine.
                    const cycles = Math.floor(elapsed / dur);
                    if (cycles >= 1) {
                        let k = L.k + cycles;
                        if (k >= 0x40000000) { L.base = L.base + k * dur; k = 0; }
                        L.start = L.base + k * dur;
                        L.k = k;
                        L.pos = simTime - L.start;
                        if (L.pingPong && (cycles & 1) === 1) L.reversed = !L.reversed;
                        if (L.cb !== undefined) queue.push({ L: L, cycles: cycles, gen: L.gen });
                    }
                    activeList[writeIdx] = L; L.aidx = writeIdx; writeIdx = (writeIdx + 1) | 0;
                } else {
                    L.pos = dur; L.done = true; L.active = false; L.aidx = -1;
                    if (L.cb !== undefined) queue.push({ L: L, cycles: 1, gen: L.gen });
                }
            } else {
                L.pos = elapsed;
                activeList[writeIdx] = L; L.aidx = writeIdx; writeIdx = (writeIdx + 1) | 0;
            }
        }
        activeList.length = writeIdx;
        const drainN = queue.length;
        try {
            /* no frame signal to propagate */
        } finally {
            for (let i = 0; i < drainN; i = (i + 1) | 0) {
                const entry = queue[i];
                const L = entry.L;
                const n = entry.cycles;
                for (let c = 0; c < n; c = (c + 1) | 0) {
                    // gen + cb re-check BEFORE every fire, mirroring the engine.
                    if (L.gen !== entry.gen || L.cb === undefined) break;
                    try { L.cb(); } catch (e) { /* isolate, like the engine drain */ }
                }
            }
            advancing = false;
        }
    }
    function advance(dt) {
        if (!Number.isFinite(dt) || dt < 0) throw new RangeError("oracle dt");
        const sdt = dt * timeScale;
        if (!Number.isFinite(sdt)) throw new RangeError("oracle overflow");
        advanceBy(sdt);
    }
    function advanceTo(t) {
        if (!Number.isFinite(t)) throw new RangeError("oracle t");
        if (t < simTime) throw new RangeError("oracle t<simTime");
        advanceBy(t - simTime);                      // absolute + unscaled
    }
    return {
        advance: advance,
        advanceTo: advanceTo,
        get simTime() { return simTime; },
        createLane: createLane,
        start: start, pause: pause, reverse: reverse, dispose: dispose,
        seek: seek, restart: restart, setTimeScale: setTimeScale,
        positionPeek: function (L) { return L.reversed ? (L.dur - L.pos) : L.pos; },
        tPeek: function (L) { const r = L.pos / L.dur; return L.reversed ? (1 - r) : r; },
        donePeek: function (L) { return L.done; }
    };
}

// ---------------------------------------------------------------------------
// Module-level scratch (allocated once; reused every op). The oracle world and
// the record objects allocate -- that is allowed here.
// ---------------------------------------------------------------------------
const curEngLog = [];
const curOraLog = [];
const pendingE = [];
const pendingO = [];
const recs = [];    // every record ever created (stable indices)
const live = [];    // records currently alive in BOTH worlds (swap-remove)

let engine = null;
let oracle = null;

function removeFromLive(rec) {
    if (!rec.inLive) return;
    const idx = rec.liveIdx;
    const last = live.length - 1;
    const lastRec = live[last];
    if (idx !== last) { live[idx] = lastRec; lastRec.liveIdx = idx; }
    live.pop();
    rec.inLive = false;
    rec.liveIdx = -1;
}
function addToLive(rec) {
    rec.liveIdx = live.length;
    rec.inLive = true;
    live.push(rec);
}

// Build a per-world onComplete closure for a record.
function makeCb(rec, isEngine) {
    return function () {
        (isEngine ? curEngLog : curOraLog).push(rec.key);
        const w = isEngine ? engine : oracle;
        switch (rec.cbType) {
            case CB_REENTER:
                w.advance(1);   // throws LiteClockReentrancyError; isolated by the drain
                break;
            case CB_DISPOSE_OTHER: {
                const t = rec.cbTarget;
                if (t !== null && (isEngine ? t.aliveE : t.aliveO)) {
                    w.dispose(isEngine ? t.eTok : t.oTok);
                    if (isEngine) t.aliveE = false; else t.aliveO = false;
                    if (!t.aliveE && !t.aliveO) removeFromLive(t);
                }
                break;
            }
            case CB_START_OTHER: {
                const t = rec.cbTarget;
                if (t !== null && (isEngine ? t.aliveE : t.aliveO)) {
                    w.start(isEngine ? t.eTok : t.oTok);
                }
                break;
            }
            case CB_CREATE_OTHER:
                (isEngine ? pendingE : pendingO).push(w.createLane(rec.cbDur, undefined));
                break;
            default:
                break;   // CB_LOG: order log only
        }
    };
}

let keyCounter = 0;
function createRecord(rng) {
    const roll = rng() % 100;
    let cbType = CB_NONE;
    if (roll < 20) cbType = CB_NONE;
    else if (roll < 45) cbType = CB_LOG;
    else if (roll < 60) cbType = CB_REENTER;
    else if (roll < 78) cbType = CB_DISPOSE_OTHER;
    else if (roll < 90) cbType = CB_START_OTHER;
    else cbType = CB_CREATE_OTHER;

    const dur = (rng() % 500) + 1 + 0.25;
    const rec = {
        key: keyCounter, eTok: null, oTok: null,
        aliveE: true, aliveO: true, inLive: false, liveIdx: -1,
        cbType: cbType, cbTarget: null, cbDur: (rng() % 300) + 1 + 0.5
    };
    keyCounter = (keyCounter + 1) | 0;

    if (cbType === CB_DISPOSE_OTHER || cbType === CB_START_OTHER) {
        rec.cbTarget = (live.length > 0) ? live[rng() % live.length] : null;
    }

    // ~25% of new lanes cycle: 13% loop, 12% pingPong. Callback-created lanes
    // (CB_CREATE_OTHER path) stay one-shot.
    let mode = 0;
    const moderoll = rng() % 100;
    if (moderoll < 13) mode = "loop";
    else if (moderoll < 25) mode = "pingPong";

    const engCb = cbType === CB_NONE ? undefined : makeCb(rec, true);
    const oraCb = cbType === CB_NONE ? undefined : makeCb(rec, false);
    rec.eTok = engine.createLane(dur, engCb, mode);
    rec.oTok = oracle.createLane(dur, oraCb, mode);
    recs.push(rec);
    addToLive(rec);
    return rec;
}

function pickAlive(rng) {
    if (live.length === 0) return null;
    return live[rng() % live.length];
}

function fail(opIndex, detail) {
    throw new AssertionError("t5 fuzz DIVERGENCE seed=" + SEED + " op=" + opIndex + " -- " + detail);
}

function compareAfterAdvance(opIndex, label) {
    if (engine.simTime !== oracle.simTime) {
        fail(opIndex, label + " simTime eng=" + engine.simTime + " ora=" + oracle.simTime);
    }
    // Callback order logs must be identical.
    if (curEngLog.length !== curOraLog.length) {
        fail(opIndex, label + " drain-log length eng=" + curEngLog.length + " ora=" + curOraLog.length
            + " engLog=[" + curEngLog.join(",") + "] oraLog=[" + curOraLog.join(",") + "]");
    }
    for (let i = 0; i < curEngLog.length; i = (i + 1) | 0) {
        if (curEngLog[i] !== curOraLog[i]) {
            fail(opIndex, label + " drain-log order at " + i + " eng=" + curEngLog[i] + " ora=" + curOraLog[i]
                + " engLog=[" + curEngLog.join(",") + "] oraLog=[" + curOraLog.join(",") + "]");
        }
    }
    // Created-from-callback lanes must pair 1:1.
    if (pendingE.length !== pendingO.length) {
        fail(opIndex, label + " create-from-cb count eng=" + pendingE.length + " ora=" + pendingO.length);
    }
    // Live lanes: reads must agree bit-for-bit.
    for (let i = 0; i < live.length; i = (i + 1) | 0) {
        const rec = live[i];
        if (rec.aliveE !== rec.aliveO) {
            fail(opIndex, label + " liveness key=" + rec.key + " aliveE=" + rec.aliveE + " aliveO=" + rec.aliveO);
        }
        const ep = engine.positionPeek(rec.eTok), op = oracle.positionPeek(rec.oTok);
        if (ep !== op) fail(opIndex, label + " positionPeek key=" + rec.key + " eng=" + ep + " ora=" + op);
        const et = engine.tPeek(rec.eTok), ot = oracle.tPeek(rec.oTok);
        if (et !== ot) fail(opIndex, label + " tPeek key=" + rec.key + " eng=" + et + " ora=" + ot);
        const ed = engine.donePeek(rec.eTok), od = oracle.donePeek(rec.oTok);
        if (ed !== od) fail(opIndex, label + " donePeek key=" + rec.key + " eng=" + ed + " ora=" + od);
    }
}

function pairPending(opIndex) {
    const n = pendingE.length;
    for (let i = 0; i < n; i = (i + 1) | 0) {
        const rec = {
            key: keyCounter, eTok: pendingE[i], oTok: pendingO[i],
            aliveE: true, aliveO: true, inLive: false, liveIdx: -1,
            cbType: CB_NONE, cbTarget: null, cbDur: 0
        };
        keyCounter = (keyCounter + 1) | 0;
        recs.push(rec);
        addToLive(rec);
    }
    pendingE.length = 0;
    pendingO.length = 0;
}

export async function run() {
    // Re-entrant callbacks make the engine drain console.error the isolated
    // throw; silence it for the duration of the fuzz.
    const origErr = console.error;
    console.error = function () {};
    try {
        engine = wrapEngine(createClock({ growable: true }));
        oracle = makeOracle();
        recs.length = 0; live.length = 0; keyCounter = 0;

        const rng = makeRng(SEED);
        let advances = 0;

        for (let op = 0; op < OPS; op = (op + 1) | 0) {
            const roll = rng() % 100;

            if (roll < 30) {
                // ADVANCE
                let dt;
                if (rng() % 15 === 0) dt = 0;
                else if (rng() % 20 === 0) dt = 5000 + 0.5;
                else dt = (rng() % 50) + 0.5;
                curEngLog.length = 0; curOraLog.length = 0;
                pendingE.length = 0; pendingO.length = 0;
                let te = null;
                try { engine.advance(dt); } catch (e) { te = e; }
                let to = null;
                try { oracle.advance(dt); } catch (e) { to = e; }
                if ((te === null) !== (to === null)) {
                    fail(op, "advance throw mismatch eng=" + (te && te.name) + " ora=" + (to && to.name));
                }
                pairPending(op);
                compareAfterAdvance(op, "advance");
                advances = (advances + 1) | 0;
            } else if (roll < 40) {
                // ADVANCE_TO
                const delta = (rng() % 60) + ((rng() % 2 === 0) ? 0 : 0.5);
                const target = engine.simTime + delta;
                curEngLog.length = 0; curOraLog.length = 0;
                pendingE.length = 0; pendingO.length = 0;
                let te = null;
                try { engine.advanceTo(target); } catch (e) { te = e; }
                let to = null;
                try { oracle.advanceTo(target); } catch (e) { to = e; }
                if ((te === null) !== (to === null)) {
                    fail(op, "advanceTo throw mismatch eng=" + (te && te.name) + " ora=" + (to && to.name));
                }
                pairPending(op);
                compareAfterAdvance(op, "advanceTo");
                advances = (advances + 1) | 0;
            } else if (roll < 55) {
                // LANE create (respect the live cap)
                if (live.length < MAX_LIVE) createRecord(rng);
            } else if (roll < 65) {
                // START
                const rec = pickAlive(rng);
                if (rec !== null) { engine.start(rec.eTok); oracle.start(rec.oTok); }
            } else if (roll < 72) {
                // PAUSE
                const rec = pickAlive(rng);
                if (rec !== null) { engine.pause(rec.eTok); oracle.pause(rec.oTok); }
            } else if (roll < 77) {
                // REVERSE
                const rec = pickAlive(rng);
                if (rec !== null) { engine.reverse(rec.eTok); oracle.reverse(rec.oTok); }
            } else if (roll < 82) {
                // SEEK -- finite position incl. out-of-range (exercise clamp)
                const rec = pickAlive(rng);
                if (rec !== null) {
                    const p = ((rng() % 800) - 100) + (((rng() % 2) === 0) ? 0 : 0.5);
                    engine.seek(rec.eTok, p); oracle.seek(rec.oTok, p);
                }
            } else if (roll < 87) {
                // RESTART
                const rec = pickAlive(rng);
                if (rec !== null) { engine.restart(rec.eTok); oracle.restart(rec.oTok); }
            } else if (roll < 92) {
                // SET_TIMESCALE from a fixed small set (0 is a legal freeze)
                const TS = [0, 0.25, 1, 2, 4];
                const v = TS[rng() % 5];
                engine.setTimeScale(v); oracle.setTimeScale(v);
            } else {
                // DISPOSE
                const rec = pickAlive(rng);
                if (rec !== null) {
                    engine.dispose(rec.eTok); oracle.dispose(rec.oTok);
                    rec.aliveE = false; rec.aliveO = false;
                    removeFromLive(rec);
                }
            }

            if ((op & 16383) === 0) {
                const inv = engine._invariant();
                if (inv !== null) fail(op, "engine invariant: " + inv);
            }
        }

        const inv = engine._invariant();
        if (inv !== null) fail(OPS, "engine final invariant: " + inv);

        console.log("t5 fuzz: pass (seed=" + SEED + " ops=" + OPS + " advances=" + advances
            + " records=" + recs.length + " live=" + live.length + ")");
    } finally {
        console.error = origErr;
    }

    // ---- C-07 (GATING, K3): config fails closed ---------------------------
    // The three fail-before probe shapes (1.1.0 accepted all silently):
    //   capacty  -> silent capacity 1024;  onComplte -> callback never fired;
    //   growable:1 -> silently false.  All three now throw with pinned fragments.
    {
        const c = createClock();
        assertThrows(function () { createClock({ capacty: 4 }); }, TypeError, "did you mean 'capacity'?", "t5 C-07 capacty did-you-mean");
        assertThrows(function () { c.lane({ duration: 10, onComplte: function () {} }); }, TypeError, "did you mean 'onComplete'?", "t5 C-07 onComplte did-you-mean");
        assertThrows(function () { createClock({ growable: 1 }); }, TypeError, "growable must be a boolean (got number)", "t5 C-07 growable 1");
    }
    console.log("t5 fuzz: C-07 config-law gating (3 probe shapes throw with pinned fragments)");

    await runMirror();
}

// ---------------------------------------------------------------------------
// runMirror -- snapshot/hydrate mirror-pair fuzz (K5, A1/A2). SEPARATE from the
// 100K oracle above: its callbacks are LOG-ONLY (no structural ops -- D1a). A
// primary clock evolves under fuzzed non-topology ops; at 10K+ capture points it
// is snapshotted, a virgin same-capacity clock is hydrated from the bytes, an
// IDENTICAL clock-level tail (advance/advanceTo/timeScale + fixed-quanta bursts)
// is applied to both, and their final snapshots must be byte-equal. Tail ops are
// clock-level only because hydrate restores STATE, not handle objects, so the
// standby has no lane handles. The standby stays byte-equal despite carrying no
// callbacks because totalCompletions counts cycles independently of callbacks.
// ---------------------------------------------------------------------------

const MIRROR_CAP = 128;
const MIRROR_LANES = 20;
const MIRROR_POINTS = 10000;
const mirrorLog = [];   // log-only callback sink (never compared; proves no structural side effect)

function armMirror(c) {
    const lanes = new Array(MIRROR_LANES);
    for (let i = 0; i < MIRROR_LANES; i = (i + 1) | 0) {
        const idx = i;
        // Spread of dyadic and non-dyadic durations; ~1/3 loop, ~1/3 pingPong.
        const dur = ((i * 7) % 97) + 0.5;
        const opts = { duration: dur, onComplete: function () { mirrorLog.push(idx); } };
        const m = i % 3;
        if (m === 1) opts.loop = true;
        else if (m === 2) opts.pingPong = true;
        const l = c.lane(opts);
        l.start();
        lanes[i] = l;
    }
    return lanes;
}

function bytesEqualOrFail(a, b, point, label) {
    if (a.length !== b.length) {
        throw new AssertionError("t5 mirror DIVERGENCE seed=" + SEED + " point=" + point
            + " -- " + label + " length a=" + a.length + " b=" + b.length);
    }
    for (let i = 0; i < a.length; i = (i + 1) | 0) {
        if (a[i] !== b[i]) {
            throw new AssertionError("t5 mirror DIVERGENCE seed=" + SEED + " point=" + point
                + " -- " + label + " byte " + i + " a=" + a[i] + " b=" + b[i]);
        }
    }
}

async function runMirror() {
    const rng = makeRng(SEED ^ 0x5bd1e995);
    const primary = createClock({ capacity: MIRROR_CAP });
    const handles = armMirror(primary);

    const size = primary.snapshotSize();
    const bufP = new Uint8Array(size);   // capture buffer (reused)
    const bufA = new Uint8Array(size);   // primary final (reused)
    const bufB = new Uint8Array(size);   // standby final (reused)

    for (let point = 0; point < MIRROR_POINTS; point = (point + 1) | 0) {
        // PRIMARY evolution: fuzzed non-topology ops (no lane()/dispose()).
        const primaryOps = 1 + (rng() % 3);
        for (let k = 0; k < primaryOps; k = (k + 1) | 0) {
            const roll = rng() % 100;
            if (roll < 45) {
                let dt;
                if (rng() % 17 === 0) dt = 0;
                else if (rng() % 23 === 0) dt = 5000 + 0.5;   // suspend-scale jump
                else dt = (rng() % 40) + ((rng() % 2 === 0) ? 0 : 0.5);
                primary.advance(dt);
            } else if (roll < 55) {
                const delta = (rng() % 30) + ((rng() % 2 === 0) ? 0 : 0.5);
                primary.advanceTo(primary.simTime + delta);
            } else if (roll < 68) {
                handles[rng() % MIRROR_LANES].start();
            } else if (roll < 78) {
                handles[rng() % MIRROR_LANES].pause();
            } else if (roll < 86) {
                handles[rng() % MIRROR_LANES].reverse();
            } else if (roll < 94) {
                const p = ((rng() % 120) - 10) + ((rng() % 2 === 0) ? 0 : 0.5);
                handles[rng() % MIRROR_LANES].seek(p);
            } else {
                const TS = [0, 0.25, 1, 2, 4];
                primary.timeScale = TS[rng() % 5];
            }
        }

        // CAPTURE + hydrate a virgin standby of equal capacity.
        primary.snapshot(bufP);
        const standby = createClock({ capacity: MIRROR_CAP });
        standby.hydrate(bufP);

        // IDENTICAL clock-level tail on both worlds (incl. fixed-quanta bursts).
        const tailOps = 1 + (rng() % 4);
        for (let k = 0; k < tailOps; k = (k + 1) | 0) {
            const roll = rng() % 100;
            if (roll < 40) {
                let dt;
                if (rng() % 19 === 0) dt = 0;
                else dt = (rng() % 45) + ((rng() % 2 === 0) ? 0 : 0.5);
                primary.advance(dt);
                standby.advance(dt);
            } else if (roll < 55) {
                const delta = (rng() % 35) + ((rng() % 2 === 0) ? 0 : 0.5);
                primary.advanceTo(primary.simTime + delta);
                standby.advanceTo(standby.simTime + delta);
            } else if (roll < 80) {
                // Fixed-quanta pattern: advance(stepMs) a whole number of times,
                // mirroring an attachFixed drain (dyadic step so it is bit-exact).
                const step = (rng() % 2 === 0) ? 16 : 8;
                const n = 1 + (rng() % 6);
                for (let q = 0; q < n; q = (q + 1) | 0) {
                    primary.advance(step);
                    standby.advance(step);
                }
            } else {
                const TS = [0, 0.25, 1, 2, 4];
                const v = TS[rng() % 5];
                primary.timeScale = v;
                standby.timeScale = v;
            }
        }

        primary.snapshot(bufA);
        standby.snapshot(bufB);
        bytesEqualOrFail(bufA, bufB, point, "mirror tail snapshot");
        standby.dispose();

        if ((point & 4095) === 0) {
            const inv = primary._invariant();
            if (inv !== null) {
                throw new AssertionError("t5 mirror seed=" + SEED + " point=" + point
                    + " -- primary invariant: " + inv);
            }
        }
    }

    if (mirrorLog.length < 0) console.log("unreachable " + mirrorLog.length);   // keep log-sink live
    console.log("t5 mirror: pass (seed=" + SEED + " points=" + MIRROR_POINTS
        + " cap=" + MIRROR_CAP + " lanes=" + MIRROR_LANES + ")");
}

// Uniform engine-world adapter over the real clock.
function wrapEngine(c) {
    return {
        advance: function (dt) { c.advance(dt); },
        advanceTo: function (t) { c.advanceTo(t); },
        get simTime() { return c.simTime; },
        createLane: function (dur, cb, mode) {
            const opts = { duration: dur, onComplete: cb };
            if (mode === "loop") opts.loop = true;
            else if (mode === "pingPong") opts.pingPong = true;
            return c.lane(opts);
        },
        start: function (h) { h.start(); },
        pause: function (h) { h.pause(); },
        reverse: function (h) { h.reverse(); },
        seek: function (h, p) { h.seek(p); },
        restart: function (h) { h.restart(); },
        setTimeScale: function (v) { c.timeScale = v; },
        dispose: function (h) { h.dispose(); },
        positionPeek: function (h) { return h.positionPeek(); },
        tPeek: function (h) { return h.tPeek(); },
        donePeek: function (h) { return h.donePeek(); },
        _invariant: function () { return c._invariant(); }
    };
}
