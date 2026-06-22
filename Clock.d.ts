/**
 * @zakkster/lite-clock -- zero-GC simulation/timeline engine.
 *
 * Public type surface for the JavaScript implementation in `Clock.js`.
 */

import { Dispose } from "@zakkster/lite-signal";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ClockConfig {
    /** Initial lane pool size. Default: 1024. Max: 65534. */
    capacity?: number;
    /** When true, pool doubles on exhaustion. Default: false (throws). */
    growable?: boolean;
}

// ---------------------------------------------------------------------------
// Lane handle
// ---------------------------------------------------------------------------

export interface LaneOptions {
    /** Lane duration in sim-time units (typically ms). Must be > 0. */
    duration: number;
    /** Optional callback fired in the end-of-tick queue when the lane completes. */
    onComplete?: () => void;
}

/**
 * A handle to one lane in the clock's pool. Methods route through the clock,
 * so handles survive pool growth. Reads track the clock's `frame` signal.
 */
export interface Lane {
    /** Begin advancing (or resume from a pause). Idempotent. */
    start(): void;
    /** Stop advancing; preserves position for a later start(). */
    pause(): void;
    /** Toggle direction-of-reporting for position() and t(). */
    reverse(): void;
    /** Free the lane slot back to the pool. Idempotent. */
    dispose(): void;

    /**
     * Current position in sim-time units, in [0..duration]. Tracks the frame
     * signal: reading inside an `effect` or `computed` re-runs on each tick.
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
    /** Read current sim-time WITHOUT tracking. */
    peek(): number;
    /** Subscribe to frame ticks. Fires immediately with current sim-time, then per advance. */
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
     */
    advance(dt: number): void;
    /** Advance simTime to absolute `t`. Throws if `t < simTime`. */
    advanceTo(t: number): void;

    /** Allocate a new lane. Throws LiteClockCapacityError if pool exhausted (no grow). */
    lane(opts: LaneOptions): Lane;

    /** Force-propagate frame signal; value = current simTime. */
    frame: FrameAccessor;

    /**
     * Attach a requestAnimationFrame-driven advancer. Computes `dt` from rAF
     * timestamps and calls `advance(dt)` each frame. Replaces any prior attach.
     */
    attachRAF(): void;
    /**
     * Attach a setInterval-driven advancer at `ms` cadence. Drift-uncorrected;
     * use rAF for visual work, this for non-visual periodic sims.
     */
    attachInterval(ms: number): void;
    /** Cancel any attached tick source. Idempotent. */
    detach(): void;

    /**
     * Reset internal state: detach tick source, dispose all lanes, reset
     * simTime/ticks counters. Existing Lane handles go inert (method calls
     * become silent no-ops).
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Compile a new clock instance. All validation is up front; the returned
 * object is frozen at the public surface (internal SOA arrays may relocate
 * on growth when `growable: true`).
 *
 * @throws {TypeError}  Wrong-shape config.
 * @throws {RangeError} Invalid capacity (< 1, non-integer, > 65534).
 */
export function createClock(config?: ClockConfig): Clock;
