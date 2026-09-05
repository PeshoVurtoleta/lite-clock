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
// Also keeps the C-07 config-fails-open reproduction as a todo (fix in K3).

import { createClock, LiteClockCapacityError, LiteClockReentrancyError } from "../../Clock.js";
import { AssertionError, makeRng, SEED, reportTodo } from "./harness.mjs";

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

    function createLane(dur, cb) {
        return { alloc: true, active: false, done: false, reversed: false, start: 0, dur: dur, pos: 0, cb: cb, aidx: -1 };
    }
    function start(L) {
        if (!L.alloc) return;
        if (L.active) return;
        if (L.done) return;
        L.active = true;
        L.start = simTime - L.pos;
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
    function dispose(L) {
        if (!L.alloc) return;
        if (L.active) removeFromActive(L);
        L.alloc = false; L.active = false; L.done = false; L.cb = undefined; L.pos = 0;
    }
    function advance(dt) {
        if (!Number.isFinite(dt) || dt < 0) throw new RangeError("oracle dt");
        if (advancing) throw new LiteClockReentrancyError();
        advancing = true;
        if (dt === 0) {
            try { /* dt=0 tick: no completions */ } finally { advancing = false; }
            return;
        }
        simTime = simTime + dt;
        const queue = [];
        let writeIdx = 0;
        const ac = activeList.length;
        for (let readIdx = 0; readIdx < ac; readIdx = (readIdx + 1) | 0) {
            const L = activeList[readIdx];
            const elapsed = simTime - L.start;
            if (elapsed >= L.dur) {
                L.pos = L.dur; L.done = true; L.active = false; L.aidx = -1;
                if (L.cb !== undefined) queue.push(L);
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
                const L = queue[i];
                if (L.done && L.cb !== undefined) {
                    try { L.cb(); } catch (e) { /* isolate, like the engine drain */ }
                }
            }
            advancing = false;
        }
    }
    function advanceTo(t) {
        if (!Number.isFinite(t)) throw new RangeError("oracle t");
        if (t < simTime) throw new RangeError("oracle t<simTime");
        advance(t - simTime);
    }
    return {
        advance: advance,
        advanceTo: advanceTo,
        get simTime() { return simTime; },
        createLane: createLane,
        start: start, pause: pause, reverse: reverse, dispose: dispose,
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

    const engCb = cbType === CB_NONE ? undefined : makeCb(rec, true);
    const oraCb = cbType === CB_NONE ? undefined : makeCb(rec, false);
    rec.eTok = engine.createLane(dur, engCb);
    rec.oTok = oracle.createLane(dur, oraCb);
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

            if (roll < 35) {
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
            } else if (roll < 45) {
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
            } else if (roll < 63) {
                // LANE create (respect the live cap)
                if (live.length < MAX_LIVE) createRecord(rng);
            } else if (roll < 76) {
                // START
                const rec = pickAlive(rng);
                if (rec !== null) { engine.start(rec.eTok); oracle.start(rec.oTok); }
            } else if (roll < 84) {
                // PAUSE
                const rec = pickAlive(rng);
                if (rec !== null) { engine.pause(rec.eTok); oracle.pause(rec.oTok); }
            } else if (roll < 90) {
                // REVERSE
                const rec = pickAlive(rng);
                if (rec !== null) { engine.reverse(rec.eTok); oracle.reverse(rec.oTok); }
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

    // ---- C-07 (todo, K3): config fails open -------------------------------
    reportTodo("C-07", function () {
        const c1 = createClock({ capacty: 4 });
        const cap = c1.capacity;

        const c2 = createClock();
        let fired = false;
        const l = c2.lane({ duration: 10, onComplte: function () { fired = true; } });
        l.start();
        c2.advance(20);
        const laneDone = l.donePeek();

        const c3 = createClock({ growable: 1 });
        let grewErr = null;
        try {
            for (let i = 0; i < 1025; i = (i + 1) | 0) c3.lane({ duration: 1e9 });
        } catch (e) {
            grewErr = e;
        }

        const repro = (cap === 1024 && fired === false && laneDone === true && grewErr instanceof LiteClockCapacityError);
        return {
            reproduces: repro,
            observed: "capacty->cap=" + cap + " onComplte-fired=" + fired + " laneDone=" + laneDone + " growable1-threw=" + (grewErr && grewErr.name)
        };
    });
}

// Uniform engine-world adapter over the real clock.
function wrapEngine(c) {
    return {
        advance: function (dt) { c.advance(dt); },
        advanceTo: function (t) { c.advanceTo(t); },
        get simTime() { return c.simTime; },
        createLane: function (dur, cb) { return c.lane({ duration: dur, onComplete: cb }); },
        start: function (h) { h.start(); },
        pause: function (h) { h.pause(); },
        reverse: function (h) { h.reverse(); },
        dispose: function (h) { h.dispose(); },
        positionPeek: function (h) { return h.positionPeek(); },
        tPeek: function (h) { return h.tPeek(); },
        donePeek: function (h) { return h.donePeek(); },
        _invariant: function () { return c._invariant(); }
    };
}
