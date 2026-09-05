# 0002 -- Stale handles, dead clocks, and the dispose lifecycle

Status: ADOPTED (K2, v1.1.0)
Date: 2026-09-05
Findings: C-04, C-06, C-08, C-12

## Context

The pool free list is LIFO and a disposed slot is reused immediately. A
LaneHandle that only checks `FLAG_ALLOC` cannot tell "my slot was freed" from
"my slot was freed and handed to a new lane": both leave `FLAG_ALLOC` set once
the slot is reallocated. The documented "silent no-op" promise was therefore a
lie -- a stale handle drove and observed an unrelated tenant (C-04). Separately,
a disposed clock kept accepting lanes and firing callbacks while its reactivity
was silently dead and `frame()` returned `undefined` against a `d.ts` that says
`number` (C-06); and `dispose()` never did what the `d.ts` claimed (C-08).

The fix is a per-slot generation tag. `lane()` stamps the current generation
into the handle; every disposal bumps the slot's generation; every handle method
and read compares first. A mismatch is provably a stale handle.

## Decision 1 -- ADOPTED: generation width is `Uint32Array`

One `Uint32Array(capacity)`, 4 bytes/slot, 4 KB at the default capacity of 1024.

Rejected -- `Uint16Array`: a 16-bit counter wraps at 65536 disposals per slot,
which is ~18 minutes of 60 fps single-slot churn. A wrap re-collides a live
handle's generation with a stale one and reopens exactly the corruption zone
this record closes -- the lite-arena AR-01 lesson. `Uint32` pushes the wrap past
2 years of continuous single-slot churn; not reachable in practice.

Rejected -- slot retirement (arena-style: burn a slot after N reuses so a
generation never wraps): an animation pool must not shrink its usable capacity
over its lifetime. Retiring slots silently lowers the effective pool size of a
long-lived clock until a capacity error appears with no code change. The pool
stays fixed-width; the generation counter absorbs churn instead.

## Decision 2 -- ADOPTED: stale-handle methods no-op, reads return inert terminals

The generation check runs FIRST in every handle method and read.

- Methods (`start`, `pause`, `reverse`, `dispose`): a mismatch returns without
  touching state -- a true silent no-op, which is what the docs already promised.
- Tracked reads (`position`, `t`, `done`): a mismatch returns the inert terminal
  (position `0`, t `0`, done `false`) WITHOUT reading the frame signal. The guard
  runs BEFORE the tracked `frameSig()` read so a stale read creates no reactive
  dependency -- a dead handle read inside an `effect` must not resurrect the
  effect on the next tick.
- Peek reads (`positionPeek`, `tPeek`, `donePeek`): same inert terminals; no
  signal read on either the live or the stale path.

Rejected -- throw on stale read/call: animation teardown races (a lane disposed
one frame, a queued read landing the next) are routine, not exceptional. Default
throwing would turn ordinary teardown into caller error-handling. A future
opt-in checked mode may surface stale access as a throw; the default stays inert.

## Decision 3 -- ADOPTED: a dead clock fails closed

After `clock.dispose()` the mutation surface throws the new exported
`LiteClockDisposedError` (Error subclass, `name` field, shaped like
`LiteClockCapacityError`): `advance`, `advanceTo`, `lane`, `attachRAF`,
`attachInterval`. The disposed check runs BEFORE the `advancing` re-entrancy
check, so a dead clock always throws `LiteClockDisposedError`, never
`LiteClockReentrancyError`.

`detach()` and `dispose()` stay idempotent no-ops.

Reads never return `undefined` -- the `d.ts` says `number`. `frame()` and
`frame.peek()` on a disposed clock return the clock's own `simTime` closure
binding, NOT `frameSig()`/`frameSig.peek()`. This is WHY C-06 read `undefined`
today: `dispose()` returns the frame signal node to the lite-signal pool and
birthGen-guarded stale accessors return `undefined` (pinned in t8). The fix
caches nothing new -- `simTime` is already a live closure binding; it does not
change lite-signal.

`frame.subscribe` on a disposed clock THROWS `LiteClockDisposedError`. A
subscription established on a dead clock could never fire again (every `advance`
throws), so a silent no-op subscriber would be a trap -- the subscriber would
believe it was live. Fail closed and force the caller to notice: a new
subscription is not a read, it is an attempt to wire reactivity onto a clock
that has none. Pinned in t4.

## Decision 4 -- ADOPTED: C-08 is fixed in the docs, not the code

The `d.ts` claimed `dispose()` "reset simTime/ticks counters". It never did and
should not. Dispose is TERMINAL: the tick source detaches, the frame signal node
returns to the pool, every lane goes stale, and the counters FREEZE at their
last values -- a dead clock's counters are inert and reading a frozen count is
more honest than reading a silently-rewound zero. The `d.ts` sentence is
corrected to terminal semantics. Nothing rewinds. Migration: dispose means
dispose; create a new clock with `createClock()`.

## Decision 5 -- ADOPTED: dispose-mid-propagation is LEGAL and PINNED

`clock.dispose()` from an effect/subscriber firing DURING `frameSig.set()` (the
todo K1 registered at the old t4-handles.mjs:64) is legal. The baseline torture
run printed:

    todo K2-dispose-mid-propagation: threw=null simTime=10 activeCount=0

The in-flight tick completes cleanly under K1's captured drain bounds + the
`FLAG_DONE` re-check: `dispose()` sets `disposed = true` and zero-fills every
flag, so when the `finally` drain iterates the queue captured before
`frameSig.set()`, every remaining entry fails the `(flags[id] & FLAG_DONE) !== 0`
re-check and is skipped. The `advancing` guard is cleared in the same `finally`,
so the clock is not bricked mid-tick -- but `disposed` is now `true`, so the next
`advance`/`advanceTo`/`lane`/`attachRAF`/`attachInterval` throws
`LiteClockDisposedError`. Only SUBSEQUENT mutation throws; the in-flight tick is
never aborted. The t2 pin "clock.dispose() from onComplete is legal" stays green
because dispose remains a legal in-tick call; only time-advancement re-entry and
post-dispose mutation throw.

## C-12 -- the `dur <= 0` branch in `t()`/`tPeek()` is dead

`lane()` rejects `duration <= 0` up front (`RangeError`), so `durations[id]` is
`> 0` for every allocated slot. A stale handle now returns its inert terminal via
the Decision 2 generation guard BEFORE reaching the ratio computation, so the
`dur <= 0` guard inside `t()`/`tPeek()` is unreachable for any readable handle.
Deleted; pinned by a unit test proving durations are always `> 0` for a readable
handle.

## Measured read-path cost (and the tuning it forced)

The tracked/peek read path gains exactly one `Uint32` load + one compare,
placed BEFORE the tracked frame-signal read. The `advance()` per-lane
compaction loop is UNTOUCHED: generations are not read there because
`activeList` entries are live by construction (an entry is written only by
`startLane`, which runs on a live slot, and cleared on completion/dispose).

FIRST ATTEMPT (rejected by measurement): exposing `generations` as a fifth
instance getter next to `_positions`/`_durations`/`_flags`. The instance is
frozen, so growth-rebindable arrays had always been exposed as getters; the
guard added one more getter dispatch per read and `lane-reads-tracked`
measured 8.24-9.12M ops/s over 5 clean runs vs the 10.73-10.98M baseline --
a -15% mean delta, outside the noise law.

ADOPTED TUNING: a growth-mutable SOA carrier. One non-frozen object
(`_soa = { positions, durations, flags, generations }`) is exposed as a data
property on the frozen instance; growth reassigns its fields; handle methods
and reads load arrays from the carrier with plain data loads. This removes
not just the guard's getter but ALL per-read getter dispatch, and the read
path ends up faster than 1.0.2. This widens the session's declared Clock.js
diff surface (the pre-existing `_positions`/`_durations`/`_flags` getters were
replaced by `_soa`) -- recorded here as a deliberate, measured deviation; the
underscore surface is internal, undocumented, and grep-verified unused outside
`Clock.js`.

Provenance: package version 1.0.2 (before) / 1.1.0 (after), node v26.3.1,
darwin arm64. `npm run bench`: BEFORE x3, AFTER x5 (first 3 listed; verdict
uses the full-range min/max). Within-noise = overlapping min/max OR mean
delta < 10%. `lane-reads-tracked` is the gated number.

BEFORE (1.0.2), ops/s:
- idle-advance:          66.65M / 67.88M / 66.40M
- active-lanes-1k:      320.44M / 356.80M / 312.54M
- lane-reads-tracked:    10.98M / 10.73M / 10.78M
- alloc-dispose-churn:   27.05M / 27.40M / 27.49M
- completion-fanout-100: 10.64M / 10.66M / 10.47M  (re-based; see note)
- attach-interval-once: 113.87K / 111.48K / 113.64K

AFTER (1.1.0), ops/s:
- idle-advance:          69.43M / 68.35M / 67.49M
- active-lanes-1k:      375.54M / 338.33M / 370.06M
- lane-reads-tracked:    15.50M / 14.69M / 14.85M  (x5 range 13.49-15.50M)
- alloc-dispose-churn:   23.44M / 23.23M / 23.65M
- completion-fanout-100:  9.56M /  9.27M /  9.49M
- attach-interval-once: 123.64K / 131.62K / 124.20K

Verdict:
- lane-reads-tracked (the gated number): 13.49-15.50M vs 10.73-10.98M --
  +24% to +41% FASTER than 1.0.2. The carrier more than pays for the guard.
- idle-advance, active-lanes-1k, attach-interval-once: overlapping ranges or
  faster; within noise. The one-boolean `disposed` check on advance() does
  not register.
- alloc-dispose-churn: 22.50-23.65M vs 27.05-27.49M, about -14%. This is the
  lifecycle price of ABA safety itself: the generation stamp at `lane()`, the
  bump at dispose, the guard in `start`/`dispose`, and the handle's third
  field. 23M full alloc/start/dispose cycles per second remains orders of
  magnitude from any real workload (the pooling NON-GOAL note in ROADMAP
  still holds). Accepted and recorded per the "either way" law.
- completion-fanout-100: -11% for the same lifecycle reason (the scenario
  rebuilds a clock and 100 lanes per iteration, and createClock now also
  allocates the generations array).

Bench note (authorized deviation): bench scenario 5 (completion-fanout-100)
previously disposed a SHARED clock inside the measured fn and re-used it the
next iteration -- that only ever worked via the C-06 zombie bug and now throws
`LiteClockDisposedError`. The scenario was fixed to create the clock inside
the iteration (what its own comment always claimed it measured), and its
BEFORE number was re-measured with the FIXED bench against the preserved
1.0.2 `Clock.js`. No other bench edit; the stale bench header stays for K6.
