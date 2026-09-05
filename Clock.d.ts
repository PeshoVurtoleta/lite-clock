/**
 * @zakkster/lite-clock -- zero-GC simulation/timeline engine.
 *
 * Public type surface for the JavaScript implementation in `Clock.js`.
 */

import { Dispose } from "@zakkster/lite-signal";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for createClock(). Fails closed: an unknown key throws a
 * TypeError with a did-you-mean hint, never a silent ignore.
 */
export interface ClockConfig {
    /** Initial lane pool size. Default: 1024. Max: 65534. */
    capacity?: number;
    /**
     * When true, the pool doubles on exhaustion up to the 65534 ceiling; the
     * final growth step clamps, so the ceiling is reachable from any start.
     * Must be exactly a boolean when present (TypeError otherwise).
     * Default: false (throws on exhaustion).
     */
    growable?: boolean;
}

// ---------------------------------------------------------------------------
// Lane handle
// ---------------------------------------------------------------------------

/**
 * Options for clock.lane(). Fails closed: an unknown key throws a TypeError
 * with a did-you-mean hint ("onComplte" -> "did you mean 'onComplete'?").
 */
export interface LaneOptions {
    /** Lane duration in sim-time units (typically ms). Must be > 0. */
    duration: number;
    /**
     * Optional callback fired in the end-of-tick queue when the lane completes.
     * A loop/pingPong lane fires it once per completed cycle (including when a
     * single advance spans many cycles).
     */
    onComplete?: () => void;
    /**
     * When true the lane wraps at `duration` and never becomes DONE
     * (done()/donePeek() report false for its whole life; t() cycles in
     * [0,1), except that a seek(duration) edit parks it at exactly 1 until
     * the next advance). Must be exactly a boolean when present (TypeError
     * otherwise). Mutually exclusive with `pingPong` (both true throws
     * TypeError).
     */
    loop?: boolean;
    /**
     * When true the lane wraps at `duration` and flips reported direction every
     * cycle (a triangle wave), and never becomes DONE. The flip toggles the same
     * REVERSE flag reverse() controls, so the two compose. Must be exactly a
     * boolean when present. Mutually exclusive with `loop`.
     */
    pingPong?: boolean;
}

/**
 * A handle to one lane in the clock's pool. Methods route through the clock,
 * so handles survive pool growth. Reads track the clock's `frame` signal.
 *
 * Generation-tag contract: the slot carries a Uint32 generation, bumped on
 * every disposal. The handle stamps the generation at lane() and compares it
 * FIRST on every method and read. A stale handle (its slot was freed, maybe
 * reused by a new tenant) takes the inert path: methods become TRUE no-ops
 * (no state touched), tracked and peek reads return the inert terminals
 * (position 0, t 0, done false) WITHOUT reading the frame signal -- a stale
 * tracked read creates no reactive dependency. A stale handle never drives or
 * observes the next tenant of its slot.
 */
export interface Lane {
    /** Begin advancing (or resume from a pause). Idempotent. Stale: no-op. */
    start(): void;
    /** Stop advancing; preserves position for a later start(). Stale: no-op. */
    pause(): void;
    /** Toggle direction-of-reporting for position() and t(). Stale: no-op. */
    reverse(): void;
    /**
     * Authored edit, NOT time: clamp `position` to [0, duration] and jump there.
     * Re-bases the cycle carry and clears DONE iff the new position < duration.
     * NEVER starts a stopped lane (a DONE lane seeked below duration becomes
     * PAUSED at the new position), NEVER fires onComplete, NEVER sets DONE, and
     * NEVER ticks the frame signal -- peeks see the new position immediately;
     * tracked reads pull it on the next tick.
     *
     * seek(duration) leaves position == duration WITHOUT completing: completion
     * is advance-exclusive and needs a compaction pass, so a following
     * advance(0) does NOT complete the lane while any advance(dt > 0) does.
     *
     * A stale handle is a TRUE silent no-op even for garbage input (the stale
     * check runs before validation). On a live handle a non-finite / non-number
     * position throws RangeError.
     *
     * @throws {RangeError} Non-finite / non-number position on a live handle.
     */
    seek(position: number): void;
    /**
     * Seek to 0, then start. Re-bases an ACTIVE lane to 0 (stays active,
     * activeCount unchanged); clears DONE and runs a finished lane. Replaces the
     * dispose/realloc replay pattern. Stale: no-op.
     */
    restart(): void;
    /**
     * Free the lane slot back to the pool and bump the slot's generation.
     * Idempotent. After dispose the handle is stale: subsequent method calls
     * are TRUE silent no-ops and reads return inert terminals -- a handle to a
     * freed-and-reused slot never drives or observes the new tenant.
     */
    dispose(): void;

    /**
     * Current position in sim-time units, in [0..duration]. Tracks the frame
     * signal: reading inside an `effect` or `computed` re-runs on each tick.
     * Stale handle: returns 0 without creating a dependency.
     */
    position(): number;
    /** Normalized progress in [0..1]. Tracked. */
    t(): number;
    /** True iff the lane has completed. Tracked. */
    done(): boolean;

    /** Untracked peek of position(). */
    positionPeek(): number;
    /** Untracked peek of t(). */
    tPeek(): number;
    /** Untracked peek of done(). */
    donePeek(): boolean;
}

// ---------------------------------------------------------------------------
// Frame accessor (ReadSignal-shaped)
// ---------------------------------------------------------------------------

export interface FrameAccessor {
    /** Read current sim-time, tracking if inside an effect or computed. */
    (): number;
    /** Read current sim-time WITHOUT tracking. On a disposed clock returns the frozen simTime (never undefined). */
    peek(): number;
    /**
     * Subscribe to frame ticks. Fires immediately with current sim-time, then
     * per advance. On a disposed clock this THROWS LiteClockDisposedError: a
     * subscription on a dead clock could never fire again (every advance
     * throws), so a silent no-op subscriber would be a trap.
     *
     * @throws {LiteClockDisposedError} Subscribe on a disposed clock.
     */
    subscribe(fn: (simTime: number) => void): Dispose;
}

// ---------------------------------------------------------------------------
// Clock instance
// ---------------------------------------------------------------------------

export interface Clock {
    /**
     * Advance simulation time by `dt` units. The ONLY mutation entry point.
     * Validates `Number.isFinite(dt) && dt >= 0`. dt=0 still ticks the frame
     * signal so subscribers observe the call.
     *
     * The tick is atomic. Calling advance() or advanceTo() AGAIN during the same
     * tick -- from an onComplete callback, an effect tracking frame(), or a
     * frame.subscribe subscriber -- throws LiteClockReentrancyError. Every other
     * clock method (lane, dispose, pause, start, reverse, attachInterval, detach)
     * stays legal during the tick; schedule follow-up advances for the next frame.
     *
     * On a disposed clock this THROWS LiteClockDisposedError. The disposed check
     * runs BEFORE the re-entrancy check, so a dead clock always throws
     * LiteClockDisposedError, never LiteClockReentrancyError.
     *
     * The raw dt is scaled once at entry by `timeScale` (`dt * timeScale`); a
     * finite product that overflows to non-finite throws RangeError naming both
     * dt and timeScale. At timeScale 0 the scaled dt is 0 -- a true freeze that
     * still ticks and propagates the frame signal but completes nothing.
     *
     * @throws {LiteClockDisposedError}   advance on a disposed clock.
     * @throws {LiteClockReentrancyError} Re-entrant advance during a tick.
     * @throws {RangeError} Invalid dt, or dt * timeScale overflows to non-finite.
     */
    advance(dt: number): void;
    /**
     * Advance simTime to absolute `t`. Throws if `t < simTime`.
     *
     * advanceTo is ABSOLUTE and UNSCALED: it reaches `t` exactly at any
     * timeScale (0 included -- an explicit destination overrides the freeze).
     * The identity `advanceTo(t) === advance(t - simTime)` holds only at
     * `timeScale === 1`.
     *
     * @throws {LiteClockDisposedError}   advanceTo on a disposed clock.
     * @throws {LiteClockReentrancyError} Re-entrant advance during a tick.
     */
    advanceTo(t: number): void;

    /**
     * Allocate a new lane. Throws LiteClockCapacityError if pool exhausted (no grow).
     *
     * @throws {LiteClockDisposedError} lane on a disposed clock.
     * @throws {TypeError} Unknown option key (did-you-mean hint), a present
     *                     non-boolean `loop`/`pingPong`, or both set true
     *                     (mutually exclusive).
     */
    lane(opts: LaneOptions): Lane;

    /** Force-propagate frame signal; value = current simTime. */
    frame: FrameAccessor;

    /**
     * Attach a requestAnimationFrame-driven advancer. Computes `dt` from rAF
     * timestamps and calls `advance(dt)` each frame. Replaces any prior attach.
     *
     * @throws {LiteClockDisposedError} attachRAF on a disposed clock.
     */
    attachRAF(): void;
    /**
     * Attach a setInterval-driven advancer at `ms` cadence. Drift-uncorrected;
     * use rAF for visual work, this for non-visual periodic sims.
     *
     * @throws {LiteClockDisposedError} attachInterval on a disposed clock.
     */
    attachInterval(ms: number): void;
    /** Cancel any attached tick source. Idempotent (safe on a disposed clock). */
    detach(): void;

    /**
     * TERMINAL. Detach the tick source, return the frame signal node to the
     * lite-signal pool, and retire every lane (each slot's generation is bumped,
     * so every outstanding handle proves stale). Idempotent.
     *
     * Dispose is terminal, NOT a reset: simTime and ticks FREEZE at their last
     * values (they do not rewind). After dispose the mutation surface fails
     * closed -- advance, advanceTo, lane, attachRAF, attachInterval, and
     * frame.subscribe throw LiteClockDisposedError. frame() and frame.peek()
     * return the frozen simTime (a number, never undefined). detach() and
     * dispose() stay idempotent no-ops. Migration from a "reset and reuse"
     * pattern: dispose means dispose; create a new clock with createClock().
     */
    dispose(): void;

    /** Current sim-time. */
    readonly simTime: number;
    /** Monotonic tick counter (incremented per advance call). */
    readonly ticks: number;
    /** Current pool capacity. */
    readonly capacity: number;
    /** Number of currently-active lanes. */
    readonly activeCount: number;

    /**
     * Clock-wide rate multiplier applied to advance() dts once at entry
     * (advanceTo is unscaled). Must be a finite number >= 0; 0 is a legal
     * freeze in which advance() still ticks and propagates but completes
     * nothing. Replay state: the same sequence of assignments and advances
     * replays identically. Reading never throws (frozen value after dispose).
     *
     * @throws {RangeError} Assigning a non-finite, negative, or non-number value.
     * @throws {LiteClockDisposedError} Assigning on a disposed clock.
     */
    timeScale: number;

    /**
     * Counter snapshot. With `out` (any non-null object) fills the 7 fields
     * in place and returns it -- the zero-allocation form. Without `out`,
     * allocates and returns a fresh object (the documented allocating
     * convenience). Read surface: stays callable after dispose -- counters
     * and timeScale are frozen; the pool reads as empty (dispose retires
     * every lane).
     *
     * @throws {TypeError} `out` present but not an object.
     */
    stats(out?: Partial<ClockStats>): ClockStats;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** Counter snapshot filled by clock.stats(). All fields are numbers. */
export interface ClockStats {
    /** Allocated lane slots (capacity - poolFree). */
    poolUsed: number;
    /** Free lane slots. */
    poolFree: number;
    /** High-water mark of simultaneously active lanes. Monotone; freezes at dispose. */
    peakActive: number;
    /** Total advance() calls (equals clock.ticks). */
    totalTicks: number;
    /**
     * Total completed cycles: a plain completion counts 1, a loop/pingPong
     * lane counts every cycle (a single multi-cycle advance counts them all),
     * and lanes without an onComplete count too.
     */
    totalCompletions: number;
    /** Current pool capacity. */
    capacity: number;
    /** Current timeScale. */
    timeScale: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LiteClockCapacityError extends Error {
    readonly name: "LiteClockCapacityError";
    readonly capacity: number;
}

/**
 * Thrown by advance()/advanceTo() when re-entered during a tick (from an
 * onComplete callback, an effect tracking frame(), or a frame.subscribe
 * subscriber). The tick is atomic; schedule follow-up advances for the next
 * frame.
 */
export class LiteClockReentrancyError extends Error {
    readonly name: "LiteClockReentrancyError";
}

/**
 * Thrown by the mutation surface of a disposed clock: advance(), advanceTo(),
 * lane(), attachRAF(), attachInterval(), and frame.subscribe(). dispose() is
 * terminal; create a new clock with createClock().
 *
 * The disposed check runs BEFORE the re-entrancy check, so a dead clock always
 * throws LiteClockDisposedError, never LiteClockReentrancyError. Reads
 * (frame(), frame.peek(), and stale handle reads) never throw and never return
 * undefined.
 */
export class LiteClockDisposedError extends Error {
    readonly name: "LiteClockDisposedError";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compile a new clock instance. All validation is up front; the returned
 * object is frozen at the public surface (internal SOA arrays may relocate
 * on growth when `growable: true`).
 *
 * @throws {TypeError}  Wrong-shape config, an unknown config key
 *                      (did-you-mean hint), or a present non-boolean
 *                      `growable`.
 * @throws {RangeError} Invalid capacity (< 1, non-integer, > 65534).
 */
export function createClock(config?: ClockConfig): Clock;

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

export const VERSION: string;
