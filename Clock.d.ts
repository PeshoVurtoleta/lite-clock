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
    /** Optional callback fired in the end-of-tick queue when the lane completes. */
    onComplete?: () => void;
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
     * @throws {LiteClockDisposedError}   advance on a disposed clock.
     * @throws {LiteClockReentrancyError} Re-entrant advance during a tick.
     */
    advance(dt: number): void;
    /**
     * Advance simTime to absolute `t`. Throws if `t < simTime`.
     *
     * @throws {LiteClockDisposedError}   advanceTo on a disposed clock.
     * @throws {LiteClockReentrancyError} Re-entrant advance during a tick.
     */
    advanceTo(t: number): void;

    /**
     * Allocate a new lane. Throws LiteClockCapacityError if pool exhausted (no grow).
     *
     * @throws {LiteClockDisposedError} lane on a disposed clock.
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
