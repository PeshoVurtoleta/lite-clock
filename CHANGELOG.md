# Changelog

All notable changes to `@zakkster/lite-clock` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## 1.1.0 -- 2026-09-05

Lifecycle-honesty release. A stale handle can no longer touch its slot's next
tenant, and a disposed clock fails closed instead of running as a zombie.
Fixes three reproduced findings (C-04/C-06/C-08), removes one dead branch
(C-12). Decision record: `decisions/0002-handle-lifecycle.md` in the repo.

### Fixed

- **C-04** -- a stale `Lane` handle drove and observed its slot's next tenant.
  The free list is LIFO, so a disposed slot is reused immediately, and a
  handle that only checked the alloc flag could not tell "my slot was freed"
  from "my slot was freed and handed to a new lane". Fail-before (1.0.2):
  dispose A, allocate B into the same slot, start B, advance -- `A.tPeek()`
  read B's `0.5` and `A.dispose()` killed B (`activeCount 1 -> 0`).
  Pass-after: every slot carries a `Uint32` generation tag, stamped into the
  handle at `lane()` and compared FIRST on every method and read; the stale
  handle reads inert `0 / 0 / false`, its methods are true no-ops, and B
  keeps running.
- **C-06** -- a disposed clock kept accepting lanes and firing callbacks while
  its reactivity was silently dead and `frame()` returned `undefined` against
  a `d.ts` that says `number`. Fail-before (1.0.2): after `dispose()`,
  `lane()` + `advance(10)` "worked" (`fired=true simTime=10`) while effects
  never re-ran and `frame()` was `undefined`. Pass-after: the mutation
  surface throws `LiteClockDisposedError` and `frame()`/`frame.peek()` return
  the frozen `simTime` -- a number, always.
- **C-08** -- `Clock.d.ts` claimed `dispose()` resets `simTime`/`ticks`; the
  code never did. The docs are corrected to reality: dispose is terminal,
  counters freeze, nothing rewinds. A dead clock's counters are inert either
  way; the honest sentence is shorter.

### Added

- Per-slot `Uint32` generation tags (4 bytes/slot; 4 KB at default capacity)
  -- the ABA guard behind the C-04 fix. A tag wrap needs ~2 years of
  continuous single-slot churn.
- `LiteClockDisposedError` export (Error subclass; `name` field). Thrown by
  `advance`, `advanceTo`, `lane`, `attachRAF`, `attachInterval` and
  `frame.subscribe` on a disposed clock. The disposed check runs BEFORE the
  re-entrancy check: a dead clock throws `LiteClockDisposedError`, never
  `LiteClockReentrancyError`.

### Changed

- `clock.dispose()` is now terminal and fail-closed. The mutation surface of
  a disposed clock throws (see Added); `detach()` and `dispose()` stay
  idempotent no-ops; `frame()`/`frame.peek()` return the frozen `simTime`.
  **Migration:** dispose means dispose -- create a new clock instead of
  re-using a disposed one (re-use previously "worked" only as the C-06
  zombie bug). `frame.subscribe` on a disposed clock throws instead of
  silently wiring a subscriber that could never fire.
- Stale-handle reads return inert terminals (`position 0`, `t 0`,
  `done false`) WITHOUT touching the frame signal -- a stale read inside an
  `effect` creates no live dependency. Previously a stale read returned the
  next tenant's values (C-04). Stale-handle methods are now the true silent
  no-ops the docs always promised.
- Internal: `LaneHandle` access routes through one growth-mutable SOA carrier
  (plain data loads) instead of per-array instance getters -- see
  Performance.

### Removed

- **C-12** -- the unreachable `dur <= 0` branch in `t()`/`tPeek()`. `lane()`
  rejects `duration <= 0` up front and a stale handle takes the inert path
  first, so no readable handle can observe a non-positive duration (pinned in
  torture t1).

### Performance

The `advance()` per-lane compaction loop is untouched -- generations are not
read there (activeList entries are live by construction). The read path gains
one `Uint32` load + compare, placed before the tracked frame-signal read. The
naive guard (a fifth instance getter) measured -15% on `lane-reads-tracked`,
so handle access was rerouted through a growth-mutable SOA carrier: plain
data loads replace ALL per-read getter dispatch, which more than pays for the
guard. Within-noise criterion: overlapping min/max OR delta < 10%.

Provenance: node v26.3.1, darwin arm64, `npm run bench` (BEFORE x3, AFTER x5;
first three AFTER runs tabled, verdicts use the full range).

BEFORE (1.0.2), ops/s per run:

| scenario             | run 1   | run 2   | run 3   |
| -------------------- | ------- | ------- | ------- |
| idle-advance         | 66.65M  | 67.88M  | 66.40M  |
| active-lanes-1k      | 320.44M | 356.80M | 312.54M |
| lane-reads-tracked   | 10.98M  | 10.73M  | 10.78M  |
| alloc-dispose-churn  | 27.05M  | 27.40M  | 27.49M  |
| completion-fanout*   | 10.64M  | 10.66M  | 10.47M  |
| attach-interval-once | 113.87K | 111.48K | 113.64K |

AFTER (1.1.0), ops/s per run:

| scenario             | run 1   | run 2   | run 3   |
| -------------------- | ------- | ------- | ------- |
| idle-advance         | 69.43M  | 68.35M  | 67.49M  |
| active-lanes-1k      | 375.54M | 338.33M | 370.06M |
| lane-reads-tracked   | 15.50M  | 14.69M  | 14.85M  |
| alloc-dispose-churn  | 23.44M  | 23.23M  | 23.65M  |
| completion-fanout*   | 9.56M   | 9.27M   | 9.49M   |
| attach-interval-once | 123.64K | 131.62K | 124.20K |

\* completion-fanout-100: the bench scenario itself was fixed in this release
-- it disposed a shared clock inside the measured fn and re-used it next
iteration, which only ever worked via the C-06 zombie bug and now throws.
The fixed scenario creates the clock inside the iteration (what its comment
always claimed); its BEFORE column was re-measured with the fixed bench
against the preserved 1.0.2 `Clock.js`.

Verdict: `lane-reads-tracked` (the gated number) is 13.49-15.50M across five
AFTER runs vs 10.73-10.98M before -- 24-41% FASTER than 1.0.2.
`idle-advance`, `active-lanes-1k` and `attach-interval-once` overlap or
improve; the one-boolean disposed check does not register on `advance()`.
`alloc-dispose-churn` is -14% and `completion-fanout` -11%: the lifecycle
price of ABA safety (generation stamp at `lane()`, bump at dispose, guard on
lifecycle methods; fanout also pays `createClock`'s new generations array
per iteration). 23M alloc/start/dispose cycles per second remains orders of
magnitude beyond any real workload, so the handle-pooling NON-GOAL stands.

---

## 1.0.2 -- 2026-09-05

Drain-integrity release. The completion window is now atomic. Fixes three
reproduced S1 silent-corruption findings (C-01/C-02/C-03) that all shared one
root cause: the callback drain trusted singly-buffered shared state across a
phase that re-enters user code.

### Fixed

- **C-01** -- re-entrant `advance()` silently dropped queued completion
  callbacks forever. Fail-before (1.0.1): two lanes complete the same tick, the
  first callback calls `advance(1)` -> fired `["A"]`, B lost permanently.
  Pass-after: the nested advance throws `LiteClockReentrancyError` and B still
  fires -> `["A","B"]`.
- **C-02** -- pool growth during the drain corrupted the callback queue.
  Fail-before: capacity-2 growable clock, first callback allocates a third lane
  (triggering growth that swaps `completedIds` mid-iteration) -> fired
  `["A","A"]` (A twice, B never). Pass-after: the drain bounds are captured
  before propagation -> `["A","B"]`.
- **C-03** -- slot reuse during the drain fired a new tenant's callback at t=0.
  Fail-before: a callback disposes a queued sibling and allocates a new lane in
  the freed LIFO slot -> fired `["A","C"]` with `C.tPeek() === 0` on its
  creation tick. Pass-after: each drain entry re-checks `FLAG_DONE`, so the
  reused (not-DONE) slot is skipped -> `["A"]`; C fires once, later, on its
  real completion.

### Changed

- Re-entrant `advance()` / `advanceTo()` -- from an onComplete callback, an
  effect tracking `frame()`, or a `frame.subscribe` subscriber -- now throws the
  new `LiteClockReentrancyError`. This removes a capability the README claimed
  ("callbacks may call `advance()`") but which never worked; it silently
  corrupted the drain. Every other clock method (`lane`, `dispose`, `pause`,
  `start`, `reverse`, `attachInterval`, `detach`) stays legal during the tick.
  **Migration:** schedule follow-up advances for the next frame --
  `queueMicrotask`, `requestAnimationFrame`, or your own scheduler.

### Added

- `LiteClockReentrancyError` export (Error subclass; `name` field). Thrown at
  the atomic-tick guard.

### Performance

The per-lane compaction loop is byte-identical to 1.0.1 (proven by diff); the
guard is one boolean write + one check in the cold entry/exit zones, and the
`FLAG_DONE` re-check is on the completion arm (once per completed lane, not per
lane per tick). Within-noise criterion: overlapping min/max across 3 runs OR
delta < 10%.

Provenance: node v26.3.1, darwin arm64, `npm run bench` x3.

BEFORE (1.0.1), ops/s per run:

| scenario           | run 1   | run 2   | run 3   |
| ------------------ | ------- | ------- | ------- |
| idle-advance       | 69.15M  | 69.38M  | 68.16M  |
| active-lanes-1k    | 355.43M | 360.83M | 336.01M |
| lane-reads-tracked | 10.99M  | 10.93M  | 10.50M  |

AFTER (1.0.2), ops/s per run:

| scenario           | run 1   | run 2   | run 3   |
| ------------------ | ------- | ------- | ------- |
| idle-advance       | 68.05M  | 68.69M  | 67.63M  |
| active-lanes-1k    | 364.97M | 352.98M | 357.33M |
| lane-reads-tracked | 11.36M  | 11.37M  | 10.89M  |

Verdict: within noise. All three hot scenarios have overlapping BEFORE/AFTER
min-max ranges (idle-advance 68.16-68.69 overlap; active-lanes-1k 352.98-360.83
overlap; lane-reads-tracked 10.89-10.99 overlap) and mean deltas under 2%.

---

## 1.0.1 -- 2026-09-05

Gate + version-hygiene release. No runtime behavior change.

### Added

- `test/torture.mjs` -- the authoritative memory + determinism gate
  (`node --expose-gc test/torture.mjs`, @zakkster/lite-leak +
  @zakkster/lite-gc-profiler). Gating tiers: t0 (metamorphic determinism
  laws), t1 (degenerate scalar inputs), t6 (zero-alloc gc gate), t7 (lite-leak
  soak + conservation), t8 (cross-package lite-signal conformance) and t9
  (controls). Tiers t2-t5 are `todo` reproductions of findings C-01..C-08
  (visible, replayable, not yet gating); they carry the C-xx recipes, while
  t8 holds no findings -- it pins the lite-signal contract the suite depends
  on. Each control (`alloc`, `leak`) is a deliberately broken variant proven
  to exit non-zero.
- `VERSION` export from `Clock.js` (`export const VERSION = "1.0.1"`) --
  three-place version sync (package.json, VERSION const, llms.txt) now live.
- Internal non-enumerable `_invariant()` test hook on the clock instance
  (UNSTABLE; excluded from `Clock.d.ts` and llms.txt). Returns `null` when
  the section-2 conservation invariant holds, else a short string naming the
  first violated line. O(capacity), never called from any hot path.

### Fixed

- llms.txt peer-range drift: the peer dependency line said
  `lite-signal ^1.2.0` while package.json pins `^1.2.2` (finding C-10). Both
  now read `^1.2.2`.

### Known issues

- Findings C-01..C-08 are registered as replayable `todo` reproductions in
  the torture suite (tiers t2-t5) and observe the CURRENT behavior. Fixes
  land in 1.0.2+ (drain integrity), 1.1.0 (handle generations / dead-clock)
  and 1.2.0 (config law / growth ceiling). See ROADMAP.md section 2 for the
  exact reproduction recipes and severities.

---

## 1.0.0 -- 2026-06-22

**Initial public release.** API frozen; subsequent 1.x releases are purely additive.

### Added

- `createClock({ capacity?, growable? })` -- factory returning a frozen `Clock`
  instance. Initial pool capacity defaults to 1024, max 65534. Growth is
  opt-in (`growable: true`); default policy is hard cap with throw.
- Synchronous `clock.advance(dt)` -- the ONLY mutation entry point. Validates
  `Number.isFinite(dt) && dt >= 0`. `dt=0` still ticks the frame signal so
  subscribers observe the call.
- `clock.advanceTo(t)` -- advance to absolute simTime. Throws if `t < simTime`.
- `clock.lane({ duration, onComplete? })` -- allocate a lane handle from the
  pool. Throws `LiteClockCapacityError` if pool exhausted and `growable: false`.
- Lane lifecycle: `start`, `pause`, `reverse`, `dispose`. All idempotent.
- Lane reads: `position()`, `t()`, `done()` (tracked) and `positionPeek()`,
  `tPeek()`, `donePeek()` (untracked). Tracked reads register a dependency on
  the clock's frame signal.
- `clock.frame` -- ReadSignal-shaped accessor for current simTime. Force-
  propagates on every advance (`equals: () => false`).
- Tick-source helpers: `clock.attachRAF()`, `clock.attachInterval(ms)`,
  `clock.detach()`. Each attach replaces any prior one. Node-side interval
  handles are `.unref()`'d.
- `clock.dispose()` -- returns the frame signal's node to the lite-signal pool,
  detaches any attached tick source, resets the lane pool. Idempotent. Required
  for bounded-lifetime clocks to prevent registry leak.
- Read-only counters: `clock.simTime`, `clock.ticks`, `clock.capacity`,
  `clock.activeCount`.
- `LiteClockCapacityError` exported. Carries `capacity` field. Message names
  both escape hatches (`{ capacity: N }` and `{ growable: true }`).

### Architecture

- SOA TypedArray storage: `startTimes`/`durations`/`positions` (`Float64Array`),
  `flags` (`Uint8Array` with `ALLOC|ACTIVE|DONE|REVERSE` bits),
  `activeList`/`activeIndex` (`Uint16Array`/`Int32Array`), free-list stack.
- In-place active-list compaction in `advance()`: completed lanes drop out
  without a second pass.
- End-of-tick completion drain: callbacks fire AFTER frame signal propagation.
- Lane handles are prototype-based; reads route through clock getter properties
  so SOA-array relocation on grow is transparent.
- Reverse mode flips reporting only; engine always advances `elapsed` forward.

### Verified

- 84 functional tests + 4 GC tests (`node --expose-gc`).
- 4096 create/dispose cycles do not leak nodes from the lite-signal default
  registry.
- 1K active lanes x 10K ticks: retention < 256 KB.
- 100K empty ticks: retention < 128 KB.
- 1M lane-read trio: retention < 128 KB.
- 100K alloc/dispose cycles: retention < 1 MB; activeCount returns to 0.
- Bench (Node 22.x x64): 117.94M lane-ticks/s under 1K active lanes;
  16.31M idle ticks/s; 3.08M tracked frame-ticks/s with one effect reading
  position+t+done.

### Compatibility

- Node 18+ (ESM-only)
- Modern browsers (Chrome 80+, Firefox 78+, Safari 14+)
- Peer dependency: `@zakkster/lite-signal ^1.2.0`

### Known limitations (see [`ROADMAP.md`](./ROADMAP.md))

- Lane handles are allocated per `lane()` call. Pooling handles is a 1.1
  candidate gated on real consumer pressure data.
- No loop / ping-pong modes; lanes complete once. Adding these would change
  the hot-loop branch structure; explicit roadmap item.
- No time-scale multiplier (e.g. slow-motion). Easy to add in 1.1.
- No epoch-based dependency tracking; the frame signal force-propagates to
  ALL trackers, even ones whose lanes haven't changed. For the typical
  animation use case this is the right trade-off; epochs are roadmap.

---

## 0.9.0 -- 2026-06-19

Pre-release. Clock skeleton, advance(dt), single-lane proof-of-concept.

### Added

- Initial SOA layout exploration. Confirmed Float64Array + Uint8Array beats
  per-lane objects in V8 micro-bench by 4-6x.
- `advance(dt)` validation contract finalized.
- `signal({ equals: () => false })` force-propagate pattern adopted from
  `lite-time`.

---

## 0.5.0 -- 2026-06-15

Pre-release. Architectural sketch.

### Added

- "Adjacent to the signal graph, not inside it" decision. One frame signal
  per clock; lane reads pull from TypedArrays.
- 10K lane capacity ceiling locked (`Uint16Array` bound, 65534 ID space with
  0xFFFF reserved as `NO_TRANSITION`-equivalent sentinel).
