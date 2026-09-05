# 0001 -- Re-entrant advance()/advanceTo() during a tick

Status: ADOPTED (K1, v1.0.2)
Date: 2026-09-05
Findings: C-01, C-02, C-03

## Context

The completion window -- compaction -> frame-signal propagation -> onComplete
drain -- re-enters user code at two points: effects/subscribers fire during
`frameSig.set()`, and onComplete callbacks fire during the drain. The 1.0.x
code trusted singly-buffered shared state (`completedIds` + `completedCount`)
across that window. Three reproduced S1 corruptions resulted:

- C-01: a nested `advance()` resets `completedCount` to 0; the outer drain's
  bound collapses and queued callbacks are dropped forever.
- C-02: a nested `lane()` that triggers growth swaps `completedIds` for a fresh
  zeroed buffer mid-drain; remaining iterations read id 0 (the wrong callback).
- C-03: a callback disposes a queued sibling and allocates a new lane, which
  reuses the sibling's LIFO slot; the drain then fires the NEW tenant's
  onComplete on its creation tick, at t=0.

## Decision A -- ADOPTED: re-entrant advance()/advanceTo() throws

A nested `advance()`/`advanceTo()` -- from an onComplete callback, an effect
tracking `frame()`, or a `frame.subscribe` subscriber -- throws a new exported
`LiteClockReentrancyError`. The tick is atomic. One boolean check + one write
in the cold entry/exit zones; the per-lane compaction loop takes zero new
instructions.

The guard removes a capability the README claimed ("onComplete callbacks may
call clock.advance()") but which never worked -- it silently corrupted. Every
other clock method stays legal during the tick: `lane()` (with and without
growth), `dispose()`, `pause()`, `start()`, `reverse()`, `attachInterval()`,
`detach()`. Only nested time-advancement dies.

Migration: schedule follow-up advances for the next frame -- `queueMicrotask`,
`requestAnimationFrame`, or your own scheduler.

## Option B -- REJECTED: defer/queue the nested dt

Queue the nested `dt` and apply it after the drain. Rejected because:

- New mutable state (a pending-dt queue) on a package whose identity is flat
  arrays and one signal write per tick.
- Ordering ambiguity: a deferred advance interleaves with callbacks queued by
  the same tick; "after the drain" is under-specified when the drain itself
  queues more work.
- Unbounded re-entry loop hazard: a callback that advances every tick, whose
  advance completes a lane whose callback advances again, spins without a
  natural fixpoint. Fail-closed throwing has no such hazard.

## lite-signal 1.5.0 effect/subscriber throw semantics (empirical, step 0c)

Probed against lite-signal 1.5.0 with a force-propagate signal
(`equals: () => false`), triggering the throw on the SECOND fire (not the
immediate subscribe-time fire):

- Q1: when an effect tracking the signal throws during `set()`, `set()`
  DOES rethrow synchronously to the setter (the caller of `set()`).
- Q2: OTHER effects tracking the same signal STILL run on that set. Observed
  run order with a throwing middle effect: `effA-run, effB-throw, effC-run`
  -- lite-signal runs all effects, then rethrows after propagation completes.
- Q3: a throwing `subscribe` callback behaves identically -- `set()` rethrows
  synchronously and the other subscribers still run.
- Q4: the signal remains usable after a throwing set; subsequent sets
  propagate normally.

This is pinned in `test/torture/t8-cross.mjs` so an upstream lite-signal
change screams there instead of silently corrupting the drain.

## finally-topology rationale

Because `frameSig.set()` CAN rethrow synchronously (Q1/Q3), the drain and the
guard-clear both live in a single `finally` wrapping `frameSig.set()`:

- If a re-entrant advance throws inside an effect, lite-signal rethrows it out
  of `frameSig.set()`. The `finally` still drains the queued completions (the
  no-drop law: a queued callback is never silently lost) and still clears the
  `advancing` guard, so the clock is not bricked -- a subsequent `advance()`
  works. The original error then propagates to the outer `advance()` caller.
- A single `finally` for both the drain and the guard-clear means a rethrowing
  effect can neither brick the clock via a stuck guard nor drop queued
  completions.

Defense in depth independent of the guard:
- The drain bounds (`drainIds = completedIds`, `drainCount = completedCount`)
  are captured BEFORE `frameSig.set()`, so growth swapping `completedIds`
  mid-propagation cannot corrupt the drain (C-02).
- Each drain entry re-checks `(flags[id] & FLAG_DONE) !== 0` in addition to
  the `onCompleteFns[id] !== undefined` check, so a slot disposed and
  reallocated during propagation/drain (now not DONE) is skipped (C-03). Two
  loads per completed lane, on the completion arm only.

## Measured hot-path cost

Provenance: package version 1.0.1 (before) / 1.0.2 (after), node v26.3.1,
darwin arm64. Bench scenarios each run 3x; within-noise criterion is
overlapping min/max across the 3 runs OR delta < 10%.

BEFORE (1.0.1):
- idle-advance:          69.15M / 69.38M / 68.16M ops/s
- active-lanes-1k:      355.43M / 360.83M / 336.01M ops/s
- lane-reads-tracked:    10.99M / 10.93M / 10.50M ops/s

AFTER (1.0.2):
- idle-advance:          68.05M / 68.69M / 67.63M ops/s
- active-lanes-1k:      364.97M / 352.98M / 357.33M ops/s
- lane-reads-tracked:    11.36M / 11.37M / 10.89M ops/s

Verdict: within noise. All three hot scenarios have overlapping BEFORE/AFTER
min-max ranges (idle-advance 68.16-68.69; active-lanes-1k 352.98-360.83;
lane-reads-tracked 10.89-10.99) and mean deltas under 2%. The per-lane
compaction loop is byte-identical (proven by diff against the pre-K1 copy).
