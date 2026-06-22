// @zakkster/lite-clock 1.0.0
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

// ---------------------------------------------------------------------------
// createClock
// ---------------------------------------------------------------------------

function createClock(config) {
    const cfg = (config !== undefined && config !== null) ? config : {};
    if (typeof cfg !== "object") {
        throw new TypeError("createClock: config must be an object");
    }

    let capacity = cfg.capacity !== undefined ? cfg.capacity : DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity <= 0) {
        throw new RangeError("createClock: capacity must be a positive integer");
    }
    if (capacity > MAX_LANES) {
        throw new RangeError("createClock: capacity exceeds maximum (" + MAX_LANES + ")");
    }

    const growable = cfg.growable === true;

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

    // ---- Growth (rebinds SOA arrays) --------------------------------------
    function ensureCapacity() {
        if (freeTop > 0) return;
        if (!growable) throw new LiteClockCapacityError(capacity);

        const oldCap = capacity;
        const newCap = oldCap * 2;
        if (newCap > MAX_LANES) throw new LiteClockCapacityError(oldCap);

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

        const nfl = new Uint16Array(newCap);
        // Push the new slots [oldCap..newCap-1] in descending order so pop
        // yields ascending IDs.
        for (let i = newCap - 1; i >= oldCap; i = (i - 1) | 0) {
            nfl[freeTop] = i & 0xFFFF;
            freeTop = (freeTop + 1) | 0;
        }
        freeList = nfl;
        capacity = newCap;
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
    }

    // ---- advance(dt) -- the only mutation entry point --------------------
    function advance(dt) {
        if (!Number.isFinite(dt) || dt < 0) {
            throw new RangeError(
                "clock.advance: dt must be a finite non-negative number (got " + dt + ")"
            );
        }
        if (dt === 0) {
            tickCount = (tickCount + 1) | 0;
            frameSig.set(simTime);
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

        // Propagate frame signal -- force-propagate, value = simTime.
        frameSig.set(simTime);

        // Drain end-of-tick completion callbacks. Callbacks fire AFTER signal
        // propagation, so any effect that tracks lane.t() already observed the
        // completion frame.
        for (let i = 0; i < completedCount; i = (i + 1) | 0) {
            const id = completedIds[i];
            const fn = onCompleteFns[id];
            if (fn !== undefined) {
                try {
                    fn();
                } catch (e) {
                    if (typeof console !== "undefined" && console.error) {
                        console.error("[lite-clock] onComplete threw:", e);
                    }
                }
            }
        }
    }

    function advanceTo(t) {
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
        return frameSig();
    }

    frame.peek = function () {
        return frameSig.peek();
    };
    frame.subscribe = function (fn) {
        return frameSig.subscribe(fn);
    };

    // ---- Lane handle (prototype-based; reads route through instance) -----
    function LaneHandle(c, id) {
        this._clock = c;
        this._id = id;
    }

    LaneHandle.prototype.start = function () {
        this._clock._startLane(this._id);
    };
    LaneHandle.prototype.pause = function () {
        this._clock._pauseLane(this._id);
    };
    LaneHandle.prototype.reverse = function () {
        this._clock._reverseLane(this._id);
    };
    LaneHandle.prototype.dispose = function () {
        this._clock._disposeLane(this._id);
    };

    LaneHandle.prototype.position = function () {
        this._clock._frameSig();
        const id = this._id;
        const c = this._clock;
        const p = c._positions[id];
        return ((c._flags[id] & FLAG_REVERSE) !== 0) ? (c._durations[id] - p) : p;
    };

    LaneHandle.prototype.t = function () {
        this._clock._frameSig();
        const id = this._id;
        const c = this._clock;
        const dur = c._durations[id];
        if (dur <= 0) return 0;
        const ratio = c._positions[id] / dur;
        return ((c._flags[id] & FLAG_REVERSE) !== 0) ? (1 - ratio) : ratio;
    };

    LaneHandle.prototype.done = function () {
        this._clock._frameSig();
        return (this._clock._flags[this._id] & FLAG_DONE) !== 0;
    };

    LaneHandle.prototype.positionPeek = function () {
        const id = this._id;
        const c = this._clock;
        const p = c._positions[id];
        return ((c._flags[id] & FLAG_REVERSE) !== 0) ? (c._durations[id] - p) : p;
    };
    LaneHandle.prototype.tPeek = function () {
        const id = this._id;
        const c = this._clock;
        const dur = c._durations[id];
        if (dur <= 0) return 0;
        const ratio = c._positions[id] / dur;
        return ((c._flags[id] & FLAG_REVERSE) !== 0) ? (1 - ratio) : ratio;
    };
    LaneHandle.prototype.donePeek = function () {
        return (this._clock._flags[this._id] & FLAG_DONE) !== 0;
    };

    // ---- Lane factory ----------------------------------------------------
    function lane(opts) {
        if (opts === null || typeof opts !== "object") {
            throw new TypeError("clock.lane: opts must be an object");
        }
        const dur = opts.duration;
        if (!Number.isFinite(dur) || dur <= 0) {
            throw new RangeError("clock.lane: opts.duration must be a finite positive number");
        }
        const oc = opts.onComplete;
        if (oc !== undefined && typeof oc !== "function") {
            throw new TypeError("clock.lane: opts.onComplete must be a function");
        }
        const id = allocLane(dur, oc);
        return new LaneHandle(instance, id);
    }

    function clockDispose() {
        if (detachFn !== null) detachFn();
        // Return the frame signal's node to the lite-signal pool. Without this,
        // every createClock()/dispose() cycle permanently leaks one registry
        // slot; consumers that mount/unmount clocks per game level or component
        // would eventually hit lite-signal's CapacityError at ~1024 cycles.
        disposeSig(frameSig);
        // Reset state. Existing LaneHandle objects become inert (their slots
        // are freed; subsequent method calls become no-ops via FLAG_ALLOC check).
        for (let i = 0; i < capacity; i = (i + 1) | 0) {
            flags[i] = 0;
            activeIndex[i] = NO_INDEX;
            onCompleteFns[i] = undefined;
            positions[i] = 0;
        }
        activeCount = 0;
        completedCount = 0;
        freeTop = capacity;
        for (let i = 0; i < capacity; i = (i + 1) | 0) {
            freeList[i] = (capacity - 1 - i) & 0xFFFF;
        }
    }

    // ---- Public instance --------------------------------------------------
    // Getters for SOA arrays so LaneHandle prototype reads see growth-relocated
    // arrays. Read cost: one property access per call -- accepted.
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
        get _positions() {
            return positions;
        },
        get _durations() {
            return durations;
        },
        get _flags() {
            return flags;
        },
        _startLane: startLane,
        _pauseLane: pauseLane,
        _reverseLane: reverseLane,
        _disposeLane: disposeLane
    };

    return Object.freeze(instance);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {createClock, LiteClockCapacityError};
