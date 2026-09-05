// @zakkster/lite-clock 1.2.0
// Zero-GC simulation/timeline engine for @zakkster/lite-signal.
//
// SOA TypedArray lane pool. Deterministic advance(dt) -- the only mutation
// entry point. Single force-propagate frame signal carrying simTime; lane
// reads pull positions/durations directly from TypedArrays so 10K lanes cost
// one signal write per tick, not 10K.
//
// Copyright (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com>
// MIT License

import {signal, dispose as disposeSig} from "@zakkster/lite-signal";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CAPACITY = 1024;
const MAX_LANES = 0xFFFE;                  // Uint16Array bound; 0xFFFF reserved
const NO_INDEX = -1;                       // activeIndex marker for "not in list"

// flags bits (stored in Uint8Array)
const FLAG_ALLOC = 1 << 0;               // lane slot is allocated (not free)
const FLAG_ACTIVE = 1 << 1;               // lane is currently advancing
const FLAG_DONE = 1 << 2;               // lane reached its duration
const FLAG_REVERSE = 1 << 3;               // direction inverted for reporting

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class LiteClockCapacityError extends Error {
    constructor(capacity) {
        super(
            "lite-clock: lane pool exhausted (capacity " + capacity + "). "
            + "Either pass { capacity: N } to createClock() for a larger fixed pool, "
            + "or pass { growable: true } to allow runtime growth."
        );
        this.name = "LiteClockCapacityError";
        this.capacity = capacity;
    }
}

class LiteClockReentrancyError extends Error {
    constructor() {
        super(
            "lite-clock: advance() re-entered during a tick (from an onComplete "
            + "callback, effect, or subscriber). The tick is atomic; schedule "
            + "follow-up advances for the next frame."
        );
        this.name = "LiteClockReentrancyError";
    }
}

class LiteClockDisposedError extends Error {
    constructor() {
        super(
            "lite-clock: clock method called after dispose(). dispose() is "
            + "terminal -- counters freeze, every lane goes stale, and the frame "
            + "signal node is returned to the pool. Create a new clock with "
            + "createClock()."
        );
        this.name = "LiteClockDisposedError";
    }
}

// ---------------------------------------------------------------------------
// Option-key validation (COLD ZONE -- runs once per createClock()/lane() call,
// never on advance/read hot paths). Fail closed: an unknown option key is a
// TypeError with a did-you-mean hint, never a silent ignore.
// ---------------------------------------------------------------------------

// Data-driven known-key lists so a future option is one array entry, not code.
const KNOWN_CLOCK_KEYS = ["capacity", "growable"];
const KNOWN_LANE_KEYS = ["duration", "onComplete"];

// Hand-rolled two-row O(n*m) Levenshtein. Only ever called on the throw path
// (once per unknown key), so its allocation of two small Int arrays is cold.
function levenshtein(a, b) {
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    let prev = new Array(bl + 1);
    let curr = new Array(bl + 1);
    for (let j = 0; j <= bl; j = (j + 1) | 0) prev[j] = j;
    for (let i = 1; i <= al; i = (i + 1) | 0) {
        curr[0] = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= bl; j = (j + 1) | 0) {
            const cost = (ca === b.charCodeAt(j - 1)) ? 0 : 1;
            let m = prev[j] + 1;              // deletion
            const ins = curr[j - 1] + 1;      // insertion
            if (ins < m) m = ins;
            const sub = prev[j - 1] + cost;   // substitution
            if (sub < m) m = sub;
            curr[j] = m;
        }
        const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[bl];
}

// Throw path only: build the did-you-mean TypeError for one unknown key.
// Kept OUT of validateKeys so the happy-path scan stays small enough to
// inline into lane() -- lane() is benched (alloc-dispose-churn) and pays for
// every byte in the scan body. Allocation here is fine: it always throws.
// Distance cap of 2: past that a "suggestion" is noise, so we list known keys.
function throwUnknownKey(prefix, k, known) {
    let best = null;
    let bestDist = 3;                         // one past the cap; any hit beats it
    for (let i = 0; i < known.length; i = (i + 1) | 0) {
        const d = levenshtein(k, known[i]);
        if (d < bestDist) { bestDist = d; best = known[i]; }
    }
    if (best !== null && bestDist <= 2) {
        throw new TypeError(
            prefix + ": unknown option '" + k + "' -- did you mean '" + best + "'?"
        );
    }
    throw new TypeError(
        prefix + ": unknown option '" + k + "' (known keys: " + known.join(", ") + ")"
    );
}

// Reject any enumerable string key not in `known` -- own OR inherited
// (for-in walks the prototype chain; rejecting an inherited junk key is
// stricter, which is the fail-closed direction). Symbol keys are skipped by
// for-in and sit outside the option contract: every option read is
// string-keyed. The happy-path loop is a bare for-in with an indexOf check
// and NO allocation (the V8 enum-cache bet -- t6's churn window proves
// createClock/lane stay maxMajor 0). `obj` may be any object; for-in over
// undefined/null (the degenerate lane() opts already rejected upstream)
// iterates zero times.
function validateKeys(obj, known, prefix) {
    for (const k in obj) {
        if (known.indexOf(k) === -1) throwUnknownKey(prefix, k, known);
    }
}

// ---------------------------------------------------------------------------
// createClock
// ---------------------------------------------------------------------------

function createClock(config) {
    const cfg = (config !== undefined && config !== null) ? config : {};
    if (typeof cfg !== "object") {
        throw new TypeError("createClock: config must be an object");
    }
    validateKeys(cfg, KNOWN_CLOCK_KEYS, "createClock");

    let capacity = cfg.capacity !== undefined ? cfg.capacity : DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new RangeError("createClock: capacity must be a positive integer");
    }
    if (capacity > MAX_LANES) {
        throw new RangeError("createClock: capacity exceeds maximum (" + MAX_LANES + ")");
    }

    // Type-strict: absent (undefined) is false; a present non-boolean is a
    // config error, never coerced. `null` is not false -- fail closed.
    let growable;
    if (cfg.growable === undefined) {
        growable = false;
    } else if (typeof cfg.growable !== "boolean") {
        throw new TypeError(
            "createClock: growable must be a boolean (got "
            + (cfg.growable === null ? "null" : typeof cfg.growable) + ")"
        );
    } else {
        growable = cfg.growable;
    }

    // ---- SOA storage (let so growth can rebind) ----------------------------
    let startTimes = new Float64Array(capacity);
    let durations = new Float64Array(capacity);
    let positions = new Float64Array(capacity);
    let flags = new Uint8Array(capacity);
    let activeList = new Uint16Array(capacity);
    let activeIndex = new Int32Array(capacity);
    let onCompleteFns = new Array(capacity);
    let completedIds = new Uint16Array(capacity);
    let freeList = new Uint16Array(capacity);
    // Per-slot generation tag. Bumped on every disposal (one slot in
    // disposeLane, every slot in clockDispose). A LaneHandle stamps the slot's
    // generation at lane() and compares first on every method/read, so a
    // handle to a freed-and-reused slot proves stale instead of driving the new
    // tenant. Uint32: a wrap needs ~2 years of continuous single-slot churn.
    let generations = new Uint32Array(capacity);

    // Initial state: activeIndex defaults to 0 from Int32Array; we use -1.
    for (let i = 0; i < capacity; i = (i + 1) | 0) {
        activeIndex[i] = NO_INDEX;
        onCompleteFns[i] = undefined;
        // Free list initialized in descending order so pop yields 0, 1, 2, ...
        freeList[i] = (capacity - 1 - i) & 0xFFFF;
    }
    let freeTop = capacity;                    // one PAST the last free entry

    let activeCount = 0;
    let completedCount = 0;
    let simTime = 0;
    let tickCount = 0;

    // ---- Frame signal: force-propagate; value = simTime --------------------
    const frameSig = signal(0, {equals: () => false});

    // ---- Tick-source bookkeeping ------------------------------------------
    let detachFn = null;
    let lastRealTime = 0;
    // Re-entrancy guard: set true across a tick, cleared in advance()'s finally.
    // The tick (compaction -> frame propagation -> callback drain) is atomic; a
    // nested advance()/advanceTo() from a callback, effect, or subscriber throws.
    let advancing = false;
    // dispose() is terminal. Once set, the mutation surface (advance, advanceTo,
    // lane, attachRAF, attachInterval) throws LiteClockDisposedError; reads go
    // inert but never undefined. Checked BEFORE the advancing guard so a dead
    // clock throws DisposedError, never ReentrancyError.
    let disposed = false;

    // ---- SOA carrier for LaneHandle access --------------------------------
    // The instance is frozen, so live arrays reach handles through this
    // non-frozen carrier: handle reads stay plain data loads (no getter
    // dispatch on the hot path) and growth reassigns the fields so a
    // relocation is transparent to live handles. Only what handles read
    // lives here.
    const soa = {
        positions: positions,
        durations: durations,
        flags: flags,
        generations: generations
    };

    // ---- Growth (rebinds SOA arrays) --------------------------------------
    function ensureCapacity() {
        if (freeTop > 0) return;
        if (!growable) throw new LiteClockCapacityError(capacity);

        // Throw only when ALREADY AT the ceiling with the pool exhausted;
        // otherwise the final growth is a clamp to MAX_LANES, not a double, so
        // the documented ceiling of 65534 is reachable (1024 -> ... -> 32768 ->
        // 65534). The copy/rebind tail below is length-driven and correct for a
        // non-double step.
        if (capacity >= MAX_LANES) throw new LiteClockCapacityError(capacity);

        const oldCap = capacity;
        let newCap = oldCap * 2;
        if (newCap > MAX_LANES) newCap = MAX_LANES;

        const ns = new Float64Array(newCap);
        ns.set(startTimes);
        startTimes = ns;
        const nd = new Float64Array(newCap);
        nd.set(durations);
        durations = nd;
        const np = new Float64Array(newCap);
        np.set(positions);
        positions = np;
        const nf = new Uint8Array(newCap);
        nf.set(flags);
        flags = nf;
        const na = new Uint16Array(newCap);
        na.set(activeList);
        activeList = na;

        const ni = new Int32Array(newCap);
        ni.set(activeIndex);
        for (let i = oldCap; i < newCap; i = (i + 1) | 0) ni[i] = NO_INDEX;
        activeIndex = ni;

        onCompleteFns.length = newCap;
        for (let i = oldCap; i < newCap; i = (i + 1) | 0) onCompleteFns[i] = undefined;

        completedIds = new Uint16Array(newCap);

        const ng = new Uint32Array(newCap);
        ng.set(generations);            // copy old tags; tail zero-filled by ctor
        generations = ng;

        const nfl = new Uint16Array(newCap);
        // Push the new slots [oldCap..newCap-1] in descending order so pop
        // yields ascending IDs.
        for (let i = newCap - 1; i >= oldCap; i = (i - 1) | 0) {
            nfl[freeTop] = i & 0xFFFF;
            freeTop = (freeTop + 1) | 0;
        }
        freeList = nfl;
        capacity = newCap;
        soa.positions = positions;
        soa.durations = durations;
        soa.flags = flags;
        soa.generations = generations;
    }

    // ---- Lane lifecycle (operates on integer IDs) -------------------------
    function allocLane(duration, onComplete) {
        ensureCapacity();
        freeTop = (freeTop - 1) | 0;
        const id = freeList[freeTop];

        startTimes[id] = simTime;
        durations[id] = duration;
        positions[id] = 0;
        flags[id] = FLAG_ALLOC;
        activeIndex[id] = NO_INDEX;
        onCompleteFns[id] = onComplete;

        return id;
    }

    function startLane(id) {
        const f = flags[id];
        if ((f & FLAG_ALLOC) === 0) return;        // disposed -- silent no-op
        if ((f & FLAG_ACTIVE) !== 0) return;        // already running
        if ((f & FLAG_DONE) !== 0) return;          // finished; explicit reset needed

        flags[id] = (f | FLAG_ACTIVE) & 0xFF;
        // Compute resume startTime so (simTime - startTime) == positions[id].
        // Fresh lane: positions[id] === 0, so startTime === simTime.
        // Paused-resumed lane: preserves elapsed.
        startTimes[id] = simTime - positions[id];
        activeList[activeCount] = id & 0xFFFF;
        activeIndex[id] = activeCount;
        activeCount = (activeCount + 1) | 0;
    }

    function removeFromActive(id) {
        const idx = activeIndex[id];
        if (idx === NO_INDEX) return;
        const last = (activeCount - 1) | 0;
        const lastId = activeList[last];
        if (idx !== last) {
            activeList[idx] = lastId;
            activeIndex[lastId] = idx;
        }
        activeIndex[id] = NO_INDEX;
        activeCount = last;
    }

    function pauseLane(id) {
        const f = flags[id];
        if ((f & FLAG_ALLOC) === 0) return;
        if ((f & FLAG_ACTIVE) === 0) return;
        positions[id] = simTime - startTimes[id];
        flags[id] = (f & ~FLAG_ACTIVE) & 0xFF;
        removeFromActive(id);
    }

    function reverseLane(id) {
        const f = flags[id];
        if ((f & FLAG_ALLOC) === 0) return;
        flags[id] = (f ^ FLAG_REVERSE) & 0xFF;
    }

    function disposeLane(id) {
        const f = flags[id];
        if ((f & FLAG_ALLOC) === 0) return;            // already free; idempotent
        if ((f & FLAG_ACTIVE) !== 0) removeFromActive(id);
        flags[id] = 0;
        onCompleteFns[id] = undefined;
        positions[id] = 0;
        freeList[freeTop] = id & 0xFFFF;
        freeTop = (freeTop + 1) | 0;
        generations[id] = (generations[id] + 1) >>> 0;   // retire this handle
    }

    // ---- advance(dt) -- the only mutation entry point --------------------
    function advance(dt) {
        if (disposed) throw new LiteClockDisposedError();
        if (!Number.isFinite(dt) || dt < 0) {
            throw new RangeError(
                "clock.advance: dt must be a finite non-negative number (got " + dt + ")"
            );
        }
        // Re-entrancy guard lives in the cold entry/exit zones, not the per-lane
        // loop. Both arms below run under one try/finally so a rethrowing effect
        // (lite-signal set() rethrows synchronously; see decisions/0001) can
        // neither brick the clock via a stuck guard nor drop queued completions.
        if (advancing) throw new LiteClockReentrancyError();
        advancing = true;

        if (dt === 0) {
            tickCount = (tickCount + 1) | 0;
            try {
                frameSig.set(simTime);
            } finally {
                // No completions queued on the dt=0 path (compaction is skipped),
                // so the drain is empty; the guard still clears here because an
                // effect can fire and re-enter during frameSig.set.
                advancing = false;
            }
            return;
        }

        simTime = simTime + dt;
        tickCount = (tickCount + 1) | 0;

        completedCount = 0;

        // In-place active-list compaction: iterate, write back survivors,
        // queue completed lanes for end-of-tick callback drain.
        let writeIdx = 0;
        const ac = activeCount;
        for (let readIdx = 0; readIdx < ac; readIdx = (readIdx + 1) | 0) {
            const id = activeList[readIdx];
            const elapsed = simTime - startTimes[id];
            const dur = durations[id];

            if (elapsed >= dur) {
                positions[id] = dur;
                flags[id] = ((flags[id] | FLAG_DONE) & ~FLAG_ACTIVE) & 0xFF;
                activeIndex[id] = NO_INDEX;
                if (onCompleteFns[id] !== undefined) {
                    completedIds[completedCount] = id & 0xFFFF;
                    completedCount = (completedCount + 1) | 0;
                }
            } else {
                positions[id] = elapsed;
                activeList[writeIdx] = id & 0xFFFF;
                activeIndex[id] = writeIdx;
                writeIdx = (writeIdx + 1) | 0;
            }
        }
        activeCount = writeIdx;

        // Capture the drain bounds BEFORE frameSig.set: an effect can grow the
        // pool (swapping completedIds) or reset completedCount via nested state,
        // and the drain must iterate the buffer that was filled (C-01/C-02).
        const drainIds = completedIds;
        const drainCount = completedCount;

        try {
            // Propagate frame signal -- force-propagate, value = simTime.
            frameSig.set(simTime);
        } finally {
            // Drain end-of-tick completion callbacks. Callbacks fire AFTER signal
            // propagation, so any effect that tracks lane.t() already observed the
            // completion frame. In finally so a rethrowing effect cannot drop
            // queued completions. Re-check FLAG_DONE: a slot disposed and
            // reallocated during propagation/drain is no longer DONE (C-03).
            for (let i = 0; i < drainCount; i = (i + 1) | 0) {
                const id = drainIds[i];
                const f = flags[id];
                if ((f & FLAG_DONE) !== 0 && onCompleteFns[id] !== undefined) {
                    try {
                        onCompleteFns[id]();
                    } catch (e) {
                        if (typeof console !== "undefined" && console.error) {
                            console.error("[lite-clock] onComplete threw:", e);
                        }
                    }
                }
            }
            advancing = false;
        }
    }

    function advanceTo(t) {
        if (disposed) throw new LiteClockDisposedError();
        if (!Number.isFinite(t)) {
            throw new RangeError("clock.advanceTo: t must be a finite number (got " + t + ")");
        }
        if (t < simTime) {
            throw new RangeError(
                "clock.advanceTo: t (" + t + ") is before current simTime (" + simTime + ")"
            );
        }
        advance(t - simTime);
    }

    // ---- Tick-source attach helpers --------------------------------------
    function nowMs() {
        return (typeof performance !== "undefined" && performance.now)
            ? performance.now() : Date.now();
    }

    function attachRAF() {
        if (disposed) throw new LiteClockDisposedError();
        if (detachFn !== null) detachFn();
        if (typeof requestAnimationFrame !== "function") {
            throw new Error("clock.attachRAF: requestAnimationFrame is not available in this runtime");
        }
        let running = true;
        lastRealTime = nowMs();

        function rafTick(now) {
            if (!running) return;
            const dt = now - lastRealTime;
            lastRealTime = now;
            advance(dt > 0 ? dt : 0);
            requestAnimationFrame(rafTick);
        }

        detachFn = () => {
            running = false;
            detachFn = null;
        };
        requestAnimationFrame(rafTick);
    }

    function attachInterval(ms) {
        if (disposed) throw new LiteClockDisposedError();
        if (detachFn !== null) detachFn();
        if (!Number.isFinite(ms) || ms <= 0) {
            throw new RangeError("clock.attachInterval: ms must be a finite positive number");
        }
        lastRealTime = nowMs();
        const handle = setInterval(() => {
            const now = nowMs();
            const dt = now - lastRealTime;
            lastRealTime = now;
            advance(dt > 0 ? dt : 0);
        }, ms);
        if (handle !== undefined && handle !== null && typeof handle.unref === "function") {
            handle.unref();
        }
        detachFn = () => {
            clearInterval(handle);
            detachFn = null;
        };
    }

    function detach() {
        if (detachFn !== null) detachFn();
    }

    // ---- Frame signal accessor (read-only wrapper) -----------------------
    function frame() {
        // Reads never return undefined (d.ts says number). After dispose the
        // frame signal node is back in the lite-signal pool and stale accessors
        // return undefined, so return the frozen simTime closure binding.
        if (disposed) return simTime;
        return frameSig();
    }

    frame.peek = function () {
        if (disposed) return simTime;
        return frameSig.peek();
    };
    frame.subscribe = function (fn) {
        // A subscription on a dead clock could never fire again (advance throws),
        // so a silent no-op subscriber would be a trap. Fail closed.
        if (disposed) throw new LiteClockDisposedError();
        return frameSig.subscribe(fn);
    };

    // ---- Lane handle (prototype-based; reads route through instance) -----
    // The generation stamped at lane() proves the handle still owns its slot.
    // Every method and read compares generations[id] === this._gen FIRST; a
    // mismatch is a stale handle (its slot was freed, maybe reused) and takes
    // the inert tail branch WITHOUT touching the frame signal -- a dead read
    // must not create a live dependency. Access goes through the clock's
    // _soa carrier (plain data loads; growth reassigns its fields) so a
    // relocation stays transparent to live handles and the hot read path
    // pays no getter dispatch.
    function LaneHandle(c, id, gen) {
        this._clock = c;
        this._id = id;
        this._gen = gen;
    }

    LaneHandle.prototype.start = function () {
        const c = this._clock;
        if (c._soa.generations[this._id] !== this._gen) return;
        c._startLane(this._id);
    };
    LaneHandle.prototype.pause = function () {
        const c = this._clock;
        if (c._soa.generations[this._id] !== this._gen) return;
        c._pauseLane(this._id);
    };
    LaneHandle.prototype.reverse = function () {
        const c = this._clock;
        if (c._soa.generations[this._id] !== this._gen) return;
        c._reverseLane(this._id);
    };
    LaneHandle.prototype.dispose = function () {
        const c = this._clock;
        if (c._soa.generations[this._id] !== this._gen) return;
        c._disposeLane(this._id);
    };

    LaneHandle.prototype.position = function () {
        const c = this._clock;
        const s = c._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return 0;
        c._frameSig();
        const p = s.positions[id];
        return ((s.flags[id] & FLAG_REVERSE) !== 0) ? (s.durations[id] - p) : p;
    };

    LaneHandle.prototype.t = function () {
        const c = this._clock;
        const s = c._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return 0;
        c._frameSig();
        // durations[id] > 0 always for a readable handle: lane() rejects
        // duration <= 0 and a stale handle returned above (C-12).
        const dur = s.durations[id];
        const ratio = s.positions[id] / dur;
        return ((s.flags[id] & FLAG_REVERSE) !== 0) ? (1 - ratio) : ratio;
    };

    LaneHandle.prototype.done = function () {
        const c = this._clock;
        const s = c._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return false;
        c._frameSig();
        return (s.flags[id] & FLAG_DONE) !== 0;
    };

    LaneHandle.prototype.positionPeek = function () {
        const s = this._clock._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return 0;
        const p = s.positions[id];
        return ((s.flags[id] & FLAG_REVERSE) !== 0) ? (s.durations[id] - p) : p;
    };
    LaneHandle.prototype.tPeek = function () {
        const s = this._clock._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return 0;
        const dur = s.durations[id];
        const ratio = s.positions[id] / dur;
        return ((s.flags[id] & FLAG_REVERSE) !== 0) ? (1 - ratio) : ratio;
    };
    LaneHandle.prototype.donePeek = function () {
        const s = this._clock._soa;
        const id = this._id;
        if (s.generations[id] !== this._gen) return false;
        return (s.flags[id] & FLAG_DONE) !== 0;
    };

    // ---- Lane factory ----------------------------------------------------
    function lane(opts) {
        if (disposed) throw new LiteClockDisposedError();
        if (opts === null || typeof opts !== "object") {
            throw new TypeError("clock.lane: opts must be an object");
        }
        validateKeys(opts, KNOWN_LANE_KEYS, "clock.lane");
        const dur = opts.duration;
        if (!Number.isFinite(dur) || dur <= 0) {
            throw new RangeError("clock.lane: opts.duration must be a finite positive number");
        }
        const oc = opts.onComplete;
        if (oc !== undefined && typeof oc !== "function") {
            throw new TypeError("clock.lane: opts.onComplete must be a function");
        }
        const id = allocLane(dur, oc);
        return new LaneHandle(instance, id, generations[id]);
    }

    function clockDispose() {
        if (disposed) return;                      // terminal + idempotent
        disposed = true;
        if (detachFn !== null) detachFn();
        // Return the frame signal's node to the lite-signal pool. Without this,
        // every createClock()/dispose() cycle permanently leaks one registry
        // slot; consumers that mount/unmount clocks per game level or component
        // would eventually hit lite-signal's CapacityError at ~1024 cycles.
        disposeSig(frameSig);
        // Reset state. Zero-filling flags is what makes a dispose-mid-tick skip
        // the remaining drain (the finally re-checks FLAG_DONE). Every slot's
        // generation is bumped so every outstanding LaneHandle proves stale.
        // Counters (simTime/tickCount) are NOT reset: dispose is terminal, they
        // freeze (see decisions/0002, C-08).
        for (let i = 0; i < capacity; i = (i + 1) | 0) {
            flags[i] = 0;
            activeIndex[i] = NO_INDEX;
            onCompleteFns[i] = undefined;
            positions[i] = 0;
            generations[i] = (generations[i] + 1) >>> 0;
        }
        activeCount = 0;
        completedCount = 0;
        freeTop = capacity;
        for (let i = 0; i < capacity; i = (i + 1) | 0) {
            freeList[i] = (capacity - 1 - i) & 0xFFFF;
        }
    }

    // ---- Public instance --------------------------------------------------
    // LaneHandle access goes through the _soa carrier (plain data loads);
    // growth reassigns the carrier fields, so handles always see the live
    // arrays without per-read getter dispatch.
    const instance = {
        advance: advance,
        advanceTo: advanceTo,
        lane: lane,
        frame: frame,
        attachRAF: attachRAF,
        attachInterval: attachInterval,
        detach: detach,
        dispose: clockDispose,
        get simTime() {
            return simTime;
        },
        get ticks() {
            return tickCount;
        },
        get capacity() {
            return capacity;
        },
        get activeCount() {
            return activeCount;
        },
        // Private hooks for LaneHandle prototype
        _frameSig: frameSig,
        _soa: soa,
        _startLane: startLane,
        _pauseLane: pauseLane,
        _reverseLane: reverseLane,
        _disposeLane: disposeLane
    };

    // ---- Test-only conservation hook (UNSTABLE; not in d.ts or llms.txt) --
    // Non-enumerable so it never widens the public/frozen surface. O(capacity),
    // never called from any hot path -- the torture suite runs it between
    // phases. Reads the CURRENT closure bindings so it sees growth-rebound
    // arrays. Returns null when every invariant holds, else a short string
    // naming the first violated line (see ROADMAP.md section 2).
    Object.defineProperty(instance, "_invariant", {
        value: function () {
            let allocCount = 0;
            for (let i = 0; i < capacity; i = (i + 1) | 0) {
                if ((flags[i] & FLAG_ALLOC) !== 0) allocCount = (allocCount + 1) | 0;
            }
            if (allocCount + freeTop !== capacity) return "slot-conservation";
            for (let i = 0; i < activeCount; i = (i + 1) | 0) {
                if (activeIndex[activeList[i]] !== i) return "active-index-roundtrip";
            }
            for (let id = 0; id < capacity; id = (id + 1) | 0) {
                const active = (flags[id] & FLAG_ACTIVE) !== 0;
                if (active !== (activeIndex[id] !== NO_INDEX)) return "active-flag-index-agreement";
            }
            return null;
        },
        enumerable: false
    });

    return Object.freeze(instance);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const VERSION = "1.2.0";

export {createClock, LiteClockCapacityError, LiteClockReentrancyError, LiteClockDisposedError, VERSION};
