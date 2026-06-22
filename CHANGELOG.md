# Changelog

All notable changes to `@zakkster/lite-clock` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
