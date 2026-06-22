# Roadmap

`@zakkster/lite-clock` follows the same philosophy as `lite-signal` and
`lite-statechart`: **the 1.0 API is final**, additions land via 1.x minor
releases only after a real consumer pulls on them. Speculative features stay
on this document until they earn their way in.

This document is the explicit "deferred" list. Each entry has a rationale,
a sketch of the API shape, and the trigger that would unblock it.

---

## 1.1 candidates (gated on real consumer pull)

### Handle pooling

**What:** Reuse `LaneHandle` objects across `lane()` / `dispose()` cycles
instead of allocating a fresh handle per call.

**Why deferred:** The hot path is `advance()` and lane reads -- both already
zero-allocation. Handle allocation only matters in alloc-heavy patterns
(short-lived lanes in tight loops). Bench shows 4.7M alloc/dispose cycles/sec
already; for typical animation usage (a few hundred concurrent lanes max)
this is well below the noise floor.

**API sketch:** transparent -- `clock.lane()` returns a reused handle if one
is available, otherwise allocates fresh. Handles carry an ABA-generation tag
to detect stale references.

**Trigger:** profiling data from a real consumer showing handle allocation
in the top-5 GC roots, or a sustained-throughput benchmark (>= 1M lane/dispose
per second) where the allocation cost is observable.

### Loop and ping-pong modes

**What:** Lanes that auto-restart on completion (loop) or reverse direction
on completion (ping-pong).

**Why deferred:** Adds branches to the hot loop's completion path. Currently
the path is "completed -> mark DONE, remove from active, queue callback" --
adding "completed AND looping -> reset startTime, keep in active" doubles
the branch count. For a feature only ~5% of lanes will use, paying the cost
on the other 95% is the wrong trade.

**API sketch:**

```ts
clock.lane({
    duration: 500,
    loop: true,                     // restart on completion
    // OR
    pingPong: true,                 // reverse direction on completion
});
```

**Trigger:** real demand from `lite-keyframe` consumers, OR a benchmark
proving the branch cost is below 2% on the non-looping path (would require
either V8 hint-emitting the branch as cold, or splitting the compaction
into two loops).

### Time-scale multiplier

**What:** A clock-wide multiplier applied to dt: `clock.timeScale = 0.5`
runs the simulation at half speed.

**Why deferred:** Easy to add; the only reason it's not in 1.0 is the
question of whether per-lane time scales (e.g. lane A at 2x, lane B at 0.5x)
are wanted. Locking clock-wide-only now forecloses that option.

**API sketch:**

```ts
clock.timeScale = 0.5;
// Internally: advance(dt) becomes advance(dt * timeScale).
// validation runs on the unscaled dt; the active loop sees the scaled value.
```

**Trigger:** a consumer that explicitly wants slow-motion / fast-forward.
Decision branch is whether to also support per-lane scaling.

### Epoch-based dependency tracking

**What:** Track which lanes have actually changed each tick; only fire
effects that depend on changed lanes.

**Why deferred:** The current model fires the frame signal every tick,
which fans out to every effect that tracks any lane. For 1000 effects
each tracking one lane, that's 1000 effect dispatches per tick even if only
3 lanes are active. Looks like waste -- but it's actually cheap (TypedArray
reads at >1B/sec), and adding epoch tracking adds per-lane bookkeeping that
hurts the hot loop.

**API sketch:** transparent. Effects only re-run when lanes they actually
read have changed `positions[id]`.

**Trigger:** a workload with >100K total effects + lanes where most effects
are independent of most lanes. Realistic only at extreme scale.

### Snapshot / restore

**What:** Capture the full clock state (simTime, all lane positions, active
list, free list) into a `SharedArrayBuffer` or serializable form, then
restore it later.

**Why deferred:** `lite-rollback` will need this for netcode rollback.
Until that's the active consumer, we don't know exactly which fields need
to survive the round-trip (e.g. should `onComplete` callbacks survive? --
clearly not; they're function references).

**API sketch:**

```ts
const snap = clock.snapshot();        // Uint8Array or structured object
const fresh = createClock({ capacity: snap.capacity });
fresh.hydrate(snap);
```

**Trigger:** `lite-rollback` 1.0 design freezes its checkpoint format.

---

## 1.2 candidates

### Diagnostics

**What:** `clock.stats()` returning a structured report: pool utilization,
peak active count, total ticks, completion histogram by duration bucket.

**API sketch:**

```ts
const stats = clock.stats();
//  {
//    poolUsed: 17, poolFree: 1007,
//    peakActive: 142, totalTicks: 18372,
//    totalCompletions: 5829,
//    avgLaneLifetime: 287.3
//  }
```

**Trigger:** dev tooling integration via `lite-devtools`.

### Cleanup hooks per lane

**What:** Per-lane cleanup callback that fires on `dispose()`, separate from
`onComplete` which fires on natural completion.

**API sketch:**

```ts
clock.lane({
    duration: 500,
    onComplete: () => {},     // fires when duration reached
    onDispose: () => {}        // fires when dispose() called, including
                               // dispose-mid-animation
});
```

**Trigger:** real consumer cancel/cleanup patterns. May land alongside
`AbortSignal` integration.

### AbortSignal integration

**What:** Pass an `AbortSignal` to `lane()`; aborting it disposes the lane.

**API sketch:**

```ts
const ctrl = new AbortController();
const lane = clock.lane({ duration: 500, signal: ctrl.signal });
// later: ctrl.abort() -> lane.dispose()
```

**Trigger:** Twitch Extension async patterns where cancellation propagates
through unrelated layers.

---

## Deferred indefinitely

These are explicitly NOT roadmap items unless something fundamental changes
about the constraints `lite-clock` operates under.

### Async lane completion (promises)

`onComplete` is synchronous and fires inside `advance()`. Returning a Promise
from `lane()` that resolves on completion would:
- Add allocation per lane (Promise objects)
- Couple the engine to the microtask queue
- Pull async semantics into a synchronous engine

Async coordination belongs upstream. Consumers can wrap a lane in a Promise
themselves if they want one.

### Built-in easing

Easing belongs in `lite-ease`. `lane.t()` is the linear input; pipe it through
your easing function in user code. Bundling easing here would mean shipping
curves that consumers don't use.

### Per-lane signals

The whole point of the architecture is that there are NOT per-lane signals.
See [README -- The case for SOA + one frame signal](./README.md#the-case-for-soa--one-frame-signal).

### Multi-threading / worker support

`lite-clock` is synchronous and single-threaded. Workers can each create their
own clock; shared state across workers via `SharedArrayBuffer` is a
hypothetical future for `lite-rollback` and not a `lite-clock` concern.

### Tween chaining DSL

```js
clock.tween(el).to({ opacity: 1 }).then(...);  // <- NOT this
```

This is a tween library, not a clock. `lite-clock` provides the timing
primitive; chains belong in a higher-level library (probably
`@zakkster/lite-tween` if it ever exists, or composed in user code).

### Spring physics

Not a clock concern. Compose with a separate physics integrator and use
`lane.position()` / `lane.t()` only for time-based animations.

### Replay / time-travel debugging

Possible in user code via `clock.snapshot()` + manual `advance(dt)` replay
once snapshot lands in 1.1. Not a dedicated API.

---

## Non-goals

- **Built-in DOM bindings.** `lite-clock` returns numbers. Binding to DOM,
  Canvas, WebGL is the consumer's job.
- **Hot reloading.** Compile-time decisions are frozen at `createClock()`.
  Changing capacity at runtime means disposing and creating a new clock.
- **Implicit timing.** All time comes from `advance(dt)` calls. There is no
  hidden internal timer; `attachRAF`/`attachInterval` are explicit
  convenience wrappers that call `advance()`.
- **Per-lane reactivity granularity.** Effects re-run on every tick of the
  frame signal. For granular reactivity, use `lite-signal` directly with
  manually-driven signals.

---

## How to request a roadmap item

Open an issue at the GitHub tracker. Bring:
- The use case (what are you trying to build that needs this?)
- The proposed API shape
- Any profiling / benchmark data showing the current API is the bottleneck

Speculative requests without a real use case stay on this document.
