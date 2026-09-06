// @zakkster/lite-clock 1.4.0
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
const FLAG_LOOP = 1 << 4;               // lane wraps at duration (never DONE)
const FLAG_PINGPONG = 1 << 5;               // lane wraps + flips REVERSE per cycle

// Snapshot binary format (see decisions/0004-snapshot.md). Same-agent, native-
// endian, canary-guarded -- NOT a wire format. Header is 72 bytes (four u32 +
// seven f64 scalars); each lane costs 49 bytes across the ten D1-order slabs.
const SNAP_FORMAT = 1;
const SNAP_MAGIC = 0x4C43534E;              // "LCSN"
const SNAP_ENDIAN = 0x01020304;             // native-endian canary
const SNAP_HEADER_BYTES = 72;
const SNAP_BYTES_PER_LANE = 49;

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
const KNOWN_LANE_KEYS = ["duration", "onComplete", "loop", "pingPong"];
const KNOWN_FIXED_KEYS = ["maxSubSteps"];

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
    // Cycle-carry base: the effective start of cycle 0. loop/pingPong recompute
    // startTimes = baseStartTimes + k*dur (one rounding) so any dt partition
    // reaching the same (base, k) yields bit-identical state (never accumulate).
    // LAZY: null until the first loop/pingPong lane() materializes both carry
    // arrays -- a non-cycling consumer never pays their bytes (the recorded
    // 1.3.0 lifecycle-bench tune). Only the completion arm reads them, and only
    // under the mode-bit check, so every read is post-materialization. The cold
    // write-sites (allocLane/startLane/seekLane/disposeLane) guard on the MODE
    // BIT, not a null check -- a set bit proves lane() materialized, and the
    // flags byte is already loaded at every site. clockDispose and growth keep
    // hoisted null checks (no per-slot mode context there).
    let baseStartTimes = null;
    // Integer count of completed cycles per lane (loop/pingPong). Uint32 with a
    // k-determined fold at 2^30 for headroom: the fold lands at the same k
    // under any split (replay determinism holds), at the price of one extra
    // rounding folded into base -- cross-partition bit-exactness is guaranteed
    // only between folds (~2^30 cycles apart, years of sim per lane).
    // Lazy alongside baseStartTimes.
    let cycleCounts = null;
    let durations = new Float64Array(capacity);
    let positions = new Float64Array(capacity);
    let flags = new Uint8Array(capacity);
    let activeList = new Uint16Array(capacity);
    let activeIndex = new Int32Array(capacity);
    let onCompleteFns = new Array(capacity);
    let completedIds = new Uint16Array(capacity);
    // Per-tick scratch parallel to completedIds: cycles completed this tick and
    // the lane generation at queue time (drain re-checks gen before each fire).
    // LAZY like the carry arrays, but materialized by the FIRST lane() of any
    // mode (every completing lane's drain entry carries cycles + generation).
    // A bare createClock()/dispose() cycle allocates nothing beyond 1.2.0.
    let completedCycles = null;
    let completedGens = null;
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
    // Plain closure numbers (no |0): totalCompletions counts completed cycles
    // and can exceed 2^31; peakActive is the high-water active-lane count. Both
    // freeze at dispose (terminal law), never reset.
    let totalCompletions = 0;
    let peakActive = 0;

    // ---- Frame signal: force-propagate; value = simTime --------------------
    const frameSig = signal(0, {equals: () => false});

    // ---- Tick-source bookkeeping ------------------------------------------
    let detachFn = null;
    let lastRealTime = 0;
    // Fixed-step driver drop counter (D5/D6): whole quanta discarded after the
    // maxSubSteps cap is hit (a tab-suspend catch-up). Real-time observability
    // reported by stats(); NOT sim state -- frozen at dispose, never reset,
    // absent from the snapshot.
    let droppedMs = 0;
    // Re-entrancy guard: set true across a tick, cleared in advance()'s finally.
    // The tick (compaction -> frame propagation -> callback drain) is atomic; a
    // nested advance()/advanceTo() from a callback, effect, or subscriber throws.
    let advancing = false;
    // Clock-wide rate multiplier. Scales dt once at advance() entry (0 is a
    // legal freeze; advanceTo is unscaled). Replay state: same set()+advance
    // sequence replays identically. Read surface after dispose (never throws).
    let timeScale = 1;
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

    // ---- Snapshot plumbing (see decisions/0004-snapshot.md) ---------------
    // Persistent 72-byte header buffer (the clock's own ArrayBuffer, aligned by
    // construction) with typed views: four u32 (magic/format/capacity/canary)
    // then seven f64 scalars. snapshot() fills these and copies the whole header
    // with one set(); hydrate() reads the canary/capacity/scalars back out
    // through the same route.
    const hdrBuf = new ArrayBuffer(SNAP_HEADER_BYTES);
    const hdrU32 = new Uint32Array(hdrBuf, 0, 4);
    const hdrF64 = new Float64Array(hdrBuf, 16, 7);
    const hdrU8 = new Uint8Array(hdrBuf);

    // Cached Uint8Array view over every slab's buffer, in D1 order. Rebuilt only
    // at cold sites (construction, growth, materialization) -- a stale view
    // after a realloc is silent corruption, so rebuildViews() runs at EVERY site
    // that reassigns or materializes a slab in this table. The two lazy slabs
    // (baseStartTimes, cycleCounts) read null until materialized; snapshot
    // writes a zero section for a null slot (bit-identical to materialized
    // zeros). The queue scratch slabs are NOT in this table (D1: never captured).
    const slabU8 = [null, null, null, null, null, null, null, null, null, null];
    function rebuildViews() {
        slabU8[0] = new Uint8Array(startTimes.buffer);
        slabU8[1] = baseStartTimes !== null ? new Uint8Array(baseStartTimes.buffer) : null;
        slabU8[2] = new Uint8Array(durations.buffer);
        slabU8[3] = new Uint8Array(positions.buffer);
        slabU8[4] = new Uint8Array(flags.buffer);
        slabU8[5] = new Uint8Array(generations.buffer);
        slabU8[6] = new Uint8Array(activeList.buffer);
        slabU8[7] = new Uint8Array(activeIndex.buffer);
        slabU8[8] = new Uint8Array(freeList.buffer);
        slabU8[9] = cycleCounts !== null ? new Uint8Array(cycleCounts.buffer) : null;
    }
    rebuildViews();

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
        if (baseStartTimes !== null) {
            const nbs = new Float64Array(newCap);
            nbs.set(baseStartTimes);
            baseStartTimes = nbs;
            const ncc = new Uint32Array(newCap);
            ncc.set(cycleCounts);
            cycleCounts = ncc;
        }
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
        completedCycles = new Uint32Array(newCap);
        completedGens = new Uint32Array(newCap);

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
        // Every slab was reallocated: the cached snapshot views are now stale.
        rebuildViews();
    }

    // ---- Lane lifecycle (operates on integer IDs) -------------------------
    function allocLane(duration, onComplete, mode) {
        // First lane of any mode materializes the per-tick queue scratch --
        // growth below can then grow it unconditionally.
        if (completedCycles === null) {
            completedCycles = new Uint32Array(capacity);
            completedGens = new Uint32Array(capacity);
        }
        ensureCapacity();
        freeTop = (freeTop - 1) | 0;
        const id = freeList[freeTop];

        startTimes[id] = simTime;
        // Mode-bit guard, not a null check: a set mode bit proves lane()
        // materialized the carry arrays, and the register test is free.
        if (mode !== 0) {
            baseStartTimes[id] = simTime;
            cycleCounts[id] = 0;
        }
        durations[id] = duration;
        positions[id] = 0;
        flags[id] = (FLAG_ALLOC | mode) & 0xFF;
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
        // Cycling lanes re-base on resume (mode bit proves the arrays exist).
        if ((f & (FLAG_LOOP | FLAG_PINGPONG)) !== 0) {
            baseStartTimes[id] = startTimes[id];
            cycleCounts[id] = 0;
        }
        activeList[activeCount] = id & 0xFFFF;
        activeIndex[id] = activeCount;
        activeCount = (activeCount + 1) | 0;
        if (activeCount > peakActive) peakActive = activeCount;
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

    // seek is an authored edit, not time: it clamps p to [0, duration], re-bases
    // the carry, and clears DONE iff p < duration. Never starts a stopped lane,
    // never fires onComplete, never sets DONE, never ticks the frame signal
    // (peeks see it now; tracked reads pull on the next tick). Validation of p
    // happens in the handle (fail closed) before this clamp.
    function seekLane(id, p) {
        if ((flags[id] & FLAG_ALLOC) === 0) return;    // disposed -- silent no-op
        const dur = durations[id];
        if (p < 0) p = 0;
        else if (p > dur) p = dur;
        positions[id] = p;
        startTimes[id] = simTime - p;
        // Cycling lanes re-base on seek (mode bit proves the arrays exist).
        if ((flags[id] & (FLAG_LOOP | FLAG_PINGPONG)) !== 0) {
            baseStartTimes[id] = startTimes[id];
            cycleCounts[id] = 0;
        }
        if (p < dur) flags[id] = (flags[id] & ~FLAG_DONE) & 0xFF;
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
        // Retire the cycle count only for cycling tenants (mode bit on the
        // pre-zeroed flags); non-cycling slots keep their initial 0.
        if ((f & (FLAG_LOOP | FLAG_PINGPONG)) !== 0) cycleCounts[id] = 0;
        freeList[freeTop] = id & 0xFFFF;
        freeTop = (freeTop + 1) | 0;
        generations[id] = (generations[id] + 1) >>> 0;   // retire this handle
    }

    // ---- advanceBy(delta) -- scaled-delta core (the only stepping body) ---
    // Receives the already-scaled delta. Raw-dt validation and timeScale
    // scaling live in the public advance() wrapper; advanceTo() calls this
    // directly with an unscaled (t - simTime). Body is 1.2.0 advance() bytes.
    function advanceBy(delta) {
        if (disposed) throw new LiteClockDisposedError();
        // Re-entrancy guard lives in the cold entry/exit zones, not the per-lane
        // loop. Both arms below run under one try/finally so a rethrowing effect
        // (lite-signal set() rethrows synchronously; see decisions/0001) can
        // neither brick the clock via a stuck guard nor drop queued completions.
        if (advancing) throw new LiteClockReentrancyError();
        advancing = true;

        if (delta === 0) {
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

        simTime = simTime + delta;
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
                if ((flags[id] & (FLAG_LOOP | FLAG_PINGPONG)) !== 0) {
                    // Carry recompute from the stored base: ONE multiply + ONE
                    // add, never startTimes += overshoot. Same (base, k, dur)
                    // yields bit-identical state under any dt partition.
                    const cycles = Math.floor(elapsed / dur);
                    if (cycles >= 1) {
                        let k = cycleCounts[id] + cycles;
                        // k-determined fold: fixed by k, lands identically under
                        // any split, keeps the Uint32 lane exact.
                        if (k >= 0x40000000) {
                            baseStartTimes[id] = baseStartTimes[id] + k * dur;
                            k = 0;
                        }
                        startTimes[id] = baseStartTimes[id] + k * dur;
                        cycleCounts[id] = k;
                        // simTime - (base + k*dur) can escape [0, dur) by ~1
                        // ulp at extreme magnitudes: reporting-only, self-
                        // corrects next tick; accepted over a hot-arm clamp.
                        positions[id] = simTime - startTimes[id];
                        if ((flags[id] & FLAG_PINGPONG) !== 0 && (cycles & 1) === 1) {
                            flags[id] = (flags[id] ^ FLAG_REVERSE) & 0xFF;
                        }
                        // Plain add (no |0): cycles per tick can exceed 2^31.
                        totalCompletions += cycles;
                        if (onCompleteFns[id] !== undefined) {
                            completedIds[completedCount] = id & 0xFFFF;
                            // Uint32 store: a tick spanning > 2^32 cycles
                            // truncates the FIRE count (totalCompletions above
                            // keeps the true total). Clamp dts upstream.
                            completedCycles[completedCount] = cycles;
                            completedGens[completedCount] = generations[id];
                            completedCount = (completedCount + 1) | 0;
                        }
                    }
                    // Survivor: loop lanes stay active, FLAG_DONE never set.
                    activeList[writeIdx] = id & 0xFFFF;
                    activeIndex[id] = writeIdx;
                    writeIdx = (writeIdx + 1) | 0;
                } else {
                    positions[id] = dur;
                    flags[id] = ((flags[id] | FLAG_DONE) & ~FLAG_ACTIVE) & 0xFF;
                    activeIndex[id] = NO_INDEX;
                    totalCompletions += 1;
                    if (onCompleteFns[id] !== undefined) {
                        completedIds[completedCount] = id & 0xFFFF;
                        completedCycles[completedCount] = 1;
                        completedGens[completedCount] = generations[id];
                        completedCount = (completedCount + 1) | 0;
                    }
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
        const drainCycles = completedCycles;
        const drainGens = completedGens;
        const drainCount = completedCount;

        try {
            // Propagate frame signal -- force-propagate, value = simTime.
            frameSig.set(simTime);
        } finally {
            // Drain end-of-tick completion callbacks. Callbacks fire AFTER signal
            // propagation, so any effect that tracks lane.t() already observed the
            // completion frame. In finally so a rethrowing effect cannot drop
            // queued completions. loop lanes fire once per completed cycle.
            for (let i = 0; i < drainCount; i = (i + 1) | 0) {
                const id = drainIds[i];
                const n = drainCycles[i];
                for (let c = 0; c < n; c = (c + 1) | 0) {
                    // Generation + fn re-check BEFORE every fire: a callback that
                    // disposes its own lane (or the clock) stops the remaining
                    // cycle fires cold. Generation-based guard replaces the 1.2.0
                    // FLAG_DONE re-check: any disposal bumps the slot generation
                    // (and a reallocated tenant keeps the bump), so every C-03
                    // case is caught by inequality, and loop lanes (never DONE)
                    // are now guardable at all.
                    if (generations[id] !== drainGens[i] || onCompleteFns[id] === undefined) break;
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

    // ---- advance(dt) -- public entry: validate raw dt, then scale ---------
    function advance(dt) {
        if (disposed) throw new LiteClockDisposedError();
        if (!Number.isFinite(dt) || dt < 0) {
            throw new RangeError(
                "clock.advance: dt must be a finite non-negative number (got " + dt + ")"
            );
        }
        // Scale once at entry (dt validated finite, timeScale finite >= 0). A
        // finite*finite product can still overflow to Infinity: fail closed.
        const sdt = dt * timeScale;
        if (!Number.isFinite(sdt)) {
            throw new RangeError(
                "clock.advance: dt * timeScale is not finite (dt " + dt
                + ", timeScale " + timeScale + ")"
            );
        }
        advanceBy(sdt);
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
        // Absolute + unscaled: reaches t exactly at any timeScale (0 included).
        advanceBy(t - simTime);
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

    // Fixed-timestep accumulator driver (D5). Feeds the PUBLIC advance(stepMs)
    // a whole number of times per frame; the sim quantum is stepMs * timeScale.
    // The maxSubSteps cap is the spiral-of-death guard: excess whole quanta are
    // dropped (never fed) and counted in droppedMs; the sub-quantum remainder
    // always carries -- that is the determinism point.
    function attachFixed(stepMs, opts) {
        if (disposed) throw new LiteClockDisposedError();
        if (typeof stepMs !== "number" || !Number.isFinite(stepMs) || stepMs <= 0) {
            throw new RangeError(
                "clock.attachFixed: stepMs must be a finite number > 0 (got " + stepMs + ")"
            );
        }
        let maxSubSteps = 8;
        if (opts !== undefined && opts !== null) {
            if (typeof opts !== "object") {
                throw new TypeError("clock.attachFixed: opts must be an object");
            }
            validateKeys(opts, KNOWN_FIXED_KEYS, "clock.attachFixed");
            if (opts.maxSubSteps !== undefined) {
                const m = opts.maxSubSteps;
                if (typeof m !== "number") {
                    throw new TypeError(
                        "clock.attachFixed: maxSubSteps must be a number (got "
                        + (m === null ? "null" : typeof m) + ")"
                    );
                }
                if (!Number.isInteger(m) || m < 1) {
                    throw new RangeError(
                        "clock.attachFixed: maxSubSteps must be an integer >= 1 (got " + m + ")"
                    );
                }
                maxSubSteps = m;
            }
        }
        if (detachFn !== null) detachFn();
        if (typeof requestAnimationFrame !== "function") {
            throw new Error("clock.attachFixed: requestAnimationFrame is not available in this runtime");
        }
        let running = true;
        let acc = 0;
        lastRealTime = nowMs();

        function fixedTick(now) {
            if (!running) return;
            const realDt = now - lastRealTime;
            lastRealTime = now;
            if (realDt > 0) acc = acc + realDt;
            let n = Math.floor(acc / stepMs);
            if (n > maxSubSteps) n = maxSubSteps;
            // Break on disposed/!running: an onComplete may dispose the clock
            // mid-drain, and advance() would otherwise throw out of this frame.
            for (let i = 0; i < n; i = (i + 1) | 0) {
                if (!running || disposed) break;
                advance(stepMs);
            }
            // ONE multiply, never repeated subtraction.
            acc = acc - n * stepMs;
            if (acc >= stepMs) {
                const d = acc - (acc % stepMs);
                droppedMs = droppedMs + d;
                acc = acc % stepMs;
            }
            requestAnimationFrame(fixedTick);
        }

        detachFn = () => {
            running = false;
            detachFn = null;
        };
        requestAnimationFrame(fixedTick);
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
    LaneHandle.prototype.seek = function (p) {
        const c = this._clock;
        // Stale check FIRST: a stale handle is a true no-op even for garbage
        // input (matches every other method). A live handle fails closed on
        // non-finite p (validation before the clamp inside _seekLane).
        if (c._soa.generations[this._id] !== this._gen) return;
        if (typeof p !== "number" || !Number.isFinite(p)) {
            throw new RangeError("lane.seek: position must be a finite number (got " + p + ")");
        }
        c._seekLane(this._id, p);
    };
    LaneHandle.prototype.restart = function () {
        const c = this._clock;
        if (c._soa.generations[this._id] !== this._gen) return;
        c._seekLane(this._id, 0);
        c._startLane(this._id);
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
        // Type-strict booleans when present (null named): fail closed.
        const lp = opts.loop;
        if (lp !== undefined && typeof lp !== "boolean") {
            throw new TypeError(
                "clock.lane: opts.loop must be a boolean (got "
                + (lp === null ? "null" : typeof lp) + ")"
            );
        }
        const pp = opts.pingPong;
        if (pp !== undefined && typeof pp !== "boolean") {
            throw new TypeError(
                "clock.lane: opts.pingPong must be a boolean (got "
                + (pp === null ? "null" : typeof pp) + ")"
            );
        }
        if (lp === true && pp === true) {
            throw new TypeError("clock.lane: loop and pingPong are mutually exclusive");
        }
        let mode = 0;
        if (lp === true) mode = FLAG_LOOP;
        else if (pp === true) mode = FLAG_PINGPONG;
        // The first cycling lane materializes the carry arrays (cold, once per
        // clock). Every later allocLane/startLane/seekLane keeps them coherent.
        if (mode !== 0 && baseStartTimes === null) {
            baseStartTimes = new Float64Array(capacity);
            cycleCounts = new Uint32Array(capacity);
            // Two lazy slabs just materialized: refresh their cached views.
            rebuildViews();
        }
        const id = allocLane(dur, oc, mode);
        return new LaneHandle(instance, id, generations[id]);
    }

    // Read surface: fills a caller sink (zero-alloc) or allocates the documented
    // convenience object. Stays readable after dispose (frozen counters, never
    // throws on the read path); only a non-null-object out is rejected.
    function stats(out) {
        if (out === undefined) out = {};
        else if (out === null || typeof out !== "object") {
            throw new TypeError(
                "clock.stats: out must be an object (got "
                + (out === null ? "null" : typeof out) + ")"
            );
        }
        out.poolUsed = capacity - freeTop;
        out.poolFree = freeTop;
        out.peakActive = peakActive;
        out.totalTicks = tickCount;
        out.totalCompletions = totalCompletions;
        out.capacity = capacity;
        out.timeScale = timeScale;
        out.droppedMs = droppedMs;
        return out;
    }

    // ---- Snapshot / hydrate (D2/D3, see decisions/0004-snapshot.md) -------
    // Byte size of a snapshot at the CURRENT capacity. Pure read: legal on a
    // disposed clock (the frozen state shape is still a fact).
    function snapshotSize() {
        return SNAP_HEADER_BYTES + capacity * SNAP_BYTES_PER_LANE;
    }

    // Capture all replay-observable sim state into `out` (D1). Strictly zero-
    // allocation: fill the persistent header, one out.set() for it, then one
    // set()/fill(0) per slab. Readable on a disposed clock; illegal mid-tick.
    function snapshot(out) {
        if (advancing) throw new LiteClockReentrancyError();
        if (!(out instanceof Uint8Array)) {
            throw new TypeError("clock.snapshot: out must be a Uint8Array");
        }
        const need = SNAP_HEADER_BYTES + capacity * SNAP_BYTES_PER_LANE;
        if (out.byteLength < need) {
            throw new RangeError(
                "clock.snapshot: out too small (need " + need + " bytes, got "
                + out.byteLength + ")"
            );
        }
        hdrU32[0] = SNAP_MAGIC;
        hdrU32[1] = SNAP_FORMAT;
        hdrU32[2] = capacity;
        hdrU32[3] = SNAP_ENDIAN;
        hdrF64[0] = simTime;
        hdrF64[1] = timeScale;
        hdrF64[2] = tickCount;
        hdrF64[3] = totalCompletions;
        hdrF64[4] = peakActive;
        hdrF64[5] = activeCount;
        hdrF64[6] = freeTop;
        out.set(hdrU8, 0);
        const cap = capacity;
        let off = SNAP_HEADER_BYTES;
        out.set(slabU8[0], off); off = off + cap * 8;                    // startTimes
        if (slabU8[1] !== null) out.set(slabU8[1], off);
        else out.fill(0, off, off + cap * 8);
        off = off + cap * 8;                                             // baseStartTimes (lazy)
        out.set(slabU8[2], off); off = off + cap * 8;                    // durations
        out.set(slabU8[3], off); off = off + cap * 8;                    // positions
        out.set(slabU8[4], off); off = off + cap;                       // flags
        out.set(slabU8[5], off); off = off + cap * 4;                    // generations
        out.set(slabU8[6], off); off = off + cap * 2;                    // activeList
        out.set(slabU8[7], off); off = off + cap * 4;                    // activeIndex
        out.set(slabU8[8], off); off = off + cap * 2;                    // freeList
        if (slabU8[9] !== null) out.set(slabU8[9], off);
        else out.fill(0, off, off + cap * 4);
        off = off + cap * 4;                                             // cycleCounts (lazy)
        return need;
    }

    // Restore sim state from a same-agent snapshot (D3/R2). Guard ladder is
    // state-first (disposed -> advancing) then shape/header/size; NO mutation
    // until all nine guards pass. Materializes the four lazy arrays if this is a
    // virgin clock receiving cycling-lane state, BEFORE any slab restore, and
    // rebuilds the cached views. The copy-in uses exactly 10 buf.subarray
    // wrappers (documented minor-GC fodder on the restore path).
    function hydrate(buf) {
        if (disposed) throw new LiteClockDisposedError();
        if (advancing) throw new LiteClockReentrancyError();
        if (!(buf instanceof Uint8Array)) {
            throw new TypeError("clock.hydrate: buf must be a Uint8Array");
        }
        if (buf.byteLength < SNAP_HEADER_BYTES) {
            throw new RangeError(
                "clock.hydrate: buf too small for header (need " + SNAP_HEADER_BYTES
                + " bytes, got " + buf.byteLength + ")"
            );
        }
        // View-free 72-byte header copy-in, then read the fields back out.
        for (let i = 0; i < SNAP_HEADER_BYTES; i = (i + 1) | 0) hdrU8[i] = buf[i];
        if (hdrU32[0] !== SNAP_MAGIC) {
            throw new TypeError("clock.hydrate: bad magic (not a lite-clock snapshot)");
        }
        if (hdrU32[1] !== SNAP_FORMAT) {
            throw new TypeError(
                "clock.hydrate: unsupported snapshot format " + hdrU32[1]
                + " (this build reads format " + SNAP_FORMAT + ")"
            );
        }
        if (hdrU32[3] !== SNAP_ENDIAN) {
            throw new TypeError(
                "clock.hydrate: endian canary mismatch (foreign-endian snapshot)"
            );
        }
        const cap = hdrU32[2];
        if (cap !== capacity) {
            throw new RangeError(
                "clock.hydrate: capacity mismatch (snapshot " + cap + ", clock "
                + capacity + ")"
            );
        }
        const need = SNAP_HEADER_BYTES + capacity * SNAP_BYTES_PER_LANE;
        if (buf.byteLength < need) {
            throw new RangeError(
                "clock.hydrate: buf too small (need " + need + " bytes, got "
                + buf.byteLength + ")"
            );
        }
        // All guards passed -- materialize lazy arrays BEFORE slab restore.
        if (baseStartTimes === null) {
            baseStartTimes = new Float64Array(capacity);
            cycleCounts = new Uint32Array(capacity);
        }
        if (completedCycles === null) {
            completedCycles = new Uint32Array(capacity);
            completedGens = new Uint32Array(capacity);
        }
        rebuildViews();
        simTime = hdrF64[0];
        timeScale = hdrF64[1];
        tickCount = hdrF64[2];
        totalCompletions = hdrF64[3];
        peakActive = hdrF64[4];
        activeCount = hdrF64[5];
        freeTop = hdrF64[6];
        const cc = capacity;
        let off = SNAP_HEADER_BYTES;
        slabU8[0].set(buf.subarray(off, off + cc * 8)); off = off + cc * 8;
        slabU8[1].set(buf.subarray(off, off + cc * 8)); off = off + cc * 8;
        slabU8[2].set(buf.subarray(off, off + cc * 8)); off = off + cc * 8;
        slabU8[3].set(buf.subarray(off, off + cc * 8)); off = off + cc * 8;
        slabU8[4].set(buf.subarray(off, off + cc));     off = off + cc;
        slabU8[5].set(buf.subarray(off, off + cc * 4)); off = off + cc * 4;
        slabU8[6].set(buf.subarray(off, off + cc * 2)); off = off + cc * 2;
        slabU8[7].set(buf.subarray(off, off + cc * 4)); off = off + cc * 4;
        slabU8[8].set(buf.subarray(off, off + cc * 2)); off = off + cc * 2;
        slabU8[9].set(buf.subarray(off, off + cc * 4)); off = off + cc * 4;
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
        // Reset state. Bumping every slot's generation is what makes a
        // dispose-mid-tick skip the remaining drain (the finally re-checks the
        // captured generation before each fire) and proves every outstanding
        // LaneHandle stale.
        // Counters (simTime/tickCount) are NOT reset: dispose is terminal, they
        // freeze (see decisions/0002, C-08).
        for (let i = 0; i < capacity; i = (i + 1) | 0) {
            flags[i] = 0;
            activeIndex[i] = NO_INDEX;
            onCompleteFns[i] = undefined;
            positions[i] = 0;
            generations[i] = (generations[i] + 1) >>> 0;
        }
        // Hoisted guard: one check, not one per slot.
        if (cycleCounts !== null) {
            for (let i = 0; i < capacity; i = (i + 1) | 0) cycleCounts[i] = 0;
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
        stats: stats,
        frame: frame,
        attachRAF: attachRAF,
        attachInterval: attachInterval,
        attachFixed: attachFixed,
        detach: detach,
        dispose: clockDispose,
        snapshotSize: snapshotSize,
        snapshot: snapshot,
        hydrate: hydrate,
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
        // Clock-wide rate multiplier. Getter never throws (read surface, frozen
        // after dispose). Setter fails closed: disposed throws, non-finite or
        // negative throws; 0 is a legal freeze.
        get timeScale() {
            return timeScale;
        },
        set timeScale(v) {
            if (disposed) throw new LiteClockDisposedError();
            if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
                throw new RangeError(
                    "clock.timeScale: must be a finite non-negative number (got "
                    + (v === null ? "null" : v) + ")"
                );
            }
            timeScale = v;
        },
        // Private hooks for LaneHandle prototype
        _frameSig: frameSig,
        _soa: soa,
        _startLane: startLane,
        _pauseLane: pauseLane,
        _reverseLane: reverseLane,
        _seekLane: seekLane,
        _disposeLane: disposeLane
    };

    // ---- Test-only conservation hook (UNSTABLE; not in d.ts or llms.txt) --
    // Non-enumerable so it never widens the public/frozen surface. O(capacity),
    // never called from any hot path -- the torture suite runs it between
    // phases. Reads the CURRENT closure bindings so it sees growth-rebound
    // arrays. Returns null when every invariant holds, else a short string
    // naming the first violated line (see ROADMAP.md section 2).
    let invariantSeen = null;
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
            // Line 4: every free-list entry in [0, freeTop) is in-bounds, not
            // allocated, and unique. The first three lines cannot see a
            // duplicated or alloc-pointing free entry -- the corruption class a
            // partial or unfaithful hydrate would introduce. The seen-map is
            // lazy and reused (test hook; never inside a gated gc window).
            if (invariantSeen === null || invariantSeen.length < capacity) {
                invariantSeen = new Uint8Array(capacity);
            } else {
                invariantSeen.fill(0, 0, capacity);
            }
            for (let i = 0; i < freeTop; i = (i + 1) | 0) {
                const entry = freeList[i];
                if (entry >= capacity) return "free-list-coherence";
                if ((flags[entry] & FLAG_ALLOC) !== 0) return "free-list-coherence";
                if (invariantSeen[entry] !== 0) return "free-list-coherence";
                invariantSeen[entry] = 1;
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

const VERSION = "1.4.0";

export {createClock, LiteClockCapacityError, LiteClockReentrancyError, LiteClockDisposedError, VERSION};
