# @zakkster/lite-clock

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-clock.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-clock)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-clock?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-clock)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-clock?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-clock)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-clock?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-clock)
[![lite-signal peer](https://img.shields.io/badge/peer-lite--signal-blue?style=for-the-badge)](https://github.com/PeshoVurtoleta/lite-signal)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Zero-GC simulation/timeline engine for [`@zakkster/lite-signal`][lite-signal].
> SOA TypedArray lane pool. Deterministic `advance(dt)`. Single force-propagate
> frame signal carrying simTime. 10K concurrent lanes for the cost of one
> signal write per tick.

---

## A clock that costs one signal per tick, no matter how many lanes you have

Animation libraries, timeline schedulers, and tweening engines hit the same
wall: every animated value wants its own reactive subscription. With 1000
concurrent tweens, you have 1000 signals firing per frame, each notifying its
own subscribers, fanning out through the reactive graph. The graph becomes the
bottleneck.

`lite-clock` flips this. There is one global `frame` signal per clock. It
force-propagates `simTime` on every `advance()` call. Lane state lives in
parallel Float64Arrays indexed by integer ID. Lane reads (`position()`, `t()`,
`done()`) track the frame signal and pull their values straight from the
TypedArrays. One write fans out to everything that cares; lanes that don't
have active readers cost nothing.

```js
import { effect } from "@zakkster/lite-signal";
import { createClock } from "@zakkster/lite-clock";

const clock = createClock();
clock.attachRAF();                            // drive from requestAnimationFrame

const fadeIn = clock.lane({ duration: 300 });
fadeIn.start();

effect(() => {
    element.style.opacity = fadeIn.t();        // re-runs each frame
});
```

That `effect` re-runs once per advance, reads one TypedArray slot, writes one
style. No per-frame closures, no per-lane signal nodes, no allocations in the
hot path.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The case for SOA + one frame signal](#the-case-for-soa--one-frame-signal)
- [Compile pipeline](#compile-pipeline)
- [How a tick propagates](#how-a-tick-propagates)
- [API reference](#api-reference)
- [Edge cases pinned down](#edge-cases-pinned-down)
- [Benchmarks](#benchmarks)
- [Testing strategy](#testing-strategy)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [Browser and runtime support](#browser-and-runtime-support)
- [Integration recipes](#integration-recipes)

---

## Why this exists

The `@zakkster/lite-*` ecosystem targets constrained environments -- Twitch
Extensions in particular, with their 1 MB bundle ceiling, 3 s cold-start
budget, and 16 ms per-frame budget. In that world, every byte of allocation
matters, every dependency is a tax, and "reactive but allocates" is no
better than imperative.

`lite-clock` exists because `lite-signal` is a great reactive primitive, but
it's not a scheduler. You can drive animations with `effect()` + a counter
signal, and it works -- until you scale up. At 100 concurrent lanes the
allocations compound; at 1000 the GC starts visible-frame-stuttering.

The fix is structural: **one signal per clock, not per lane**. Once the
frame signal is the only reactive source of truth, lane state can live in
flat TypedArrays. The signal write fans out; readers pull what they need.

This also gives you deterministic simulation for free. `advance(dt)` is the
only mutation entry point. Inject the same `dt` sequence twice and you get
identical state. That's the foundation [`@zakkster/lite-rollback`][lite-rollback]
will build on for netcode replay.

---

## What you get

- **Single-file ESM**, around 480 lines, [no runtime dependencies](./package.json)
  beyond the `lite-signal` peer dep
- **SOA TypedArray pool**: `startTimes`, `durations`, `positions` as
  `Float64Array`, `flags` as `Uint8Array`, `activeList`/`activeIndex` for
  O(1) compaction
- **One force-propagate frame signal** per clock; lane reads pull from
  TypedArrays so 10K lanes cost one signal write per tick
- **Deterministic `advance(dt)`** -- the only mutation entry point. Validates
  `Number.isFinite(dt) && dt >= 0`. `dt=0` still ticks the frame signal
- **In-place active-list compaction**: completed lanes drop out of the hot
  loop without an extra pass
- **End-of-tick onComplete drain**: callbacks fire AFTER signal propagation,
  so effects tracking `lane.done()` see the completion frame BEFORE the
  callback runs
- **Throw-on-overflow by default**, growable opt-in (doubles up to 65534)
- **Tick-source helpers**: `attachRAF()`, `attachInterval(ms)`, `detach()`.
  Manual `advance(dt)` for deterministic tests
- **Reverse mode** that flips reporting without complicating the hot loop
- **Idempotent `dispose()`** that returns the frame signal's node to the
  lite-signal pool (no registry leak)
- **MIT licensed**, ASCII-only source, [zero `any`](./Clock.d.ts)

---

## The case for SOA + one frame signal

The naive design is one signal per lane. Each lane carries its own reactive
node; `lane.value()` reads it; `advance()` writes them all. With N lanes,
each tick costs N signal writes, N propagations, and N node-pool slots.

The SOA design is one signal for the whole clock. Lane state is N integer
slots in parallel TypedArrays. `advance()` iterates the active list (a packed
`Uint16Array` of lane IDs) and writes positions directly. One `frameSig.set()`
at the end propagates to everything that cares.

| | one signal per lane | SOA + one frame signal |
| -- | -- | -- |
| Reactive node pool slots used | N | 1 |
| Signal writes per tick | N | 1 |
| Lane state storage | N closures + N nodes | N * 17 bytes |
| Cost of an inactive lane | one signal node | 1 byte (Uint8Array flag) |
| 10K lanes in default lite-signal registry | overflows at 1024 | comfortably fits |
| Per-lane read | signal read + closure call | TypedArray load + branch |

The trade-off: lane state ISN'T independently subscribable. If you want one
effect that only re-runs when lane #7 changes (and not when lanes #1-#6 change),
this isn't your library. In practice, animations re-render every frame anyway --
the granularity is wrong for animation.

The pattern matches `lite-room` (peer state in TypedArrays, one CRDT signal),
`lite-rollback` (frame state in ring buffers, one tick signal), and most other
high-scale reactive systems.

---

## Compile pipeline

`createClock(config)` performs all setup up front and returns a frozen handle:

```
config validation         capacity is positive int, <= 65534
                          growable is boolean
                          --------------------------------------
SOA allocation             Float64Array startTimes
                           Float64Array durations
                           Float64Array positions
                           Uint8Array   flags        (ALLOC|ACTIVE|DONE|REVERSE)
                           Uint16Array  activeList   (packed IDs, len activeCount)
                           Int32Array   activeIndex  (-1 sentinel for "not in list")
                           Array        onCompleteFns (sparse JS array)
                           Uint16Array  completedIds (end-of-tick scratch)
                           Uint16Array  freeList     (stack of free IDs)
                          --------------------------------------
free-list seed             freeList[i] = capacity - 1 - i
                           (so pop yields IDs 0, 1, 2, ... in order)
                          --------------------------------------
frame signal               signal(0, { equals: () => false })
                           force-propagates simTime on every set
                          --------------------------------------
Object.freeze(instance)    public surface is frozen
```

After freeze, the public methods are stable references. Internal TypedArrays
are reassigned on growth (`let` bindings, all reads through getter properties
on the instance so live `LaneHandle` instances see the new buffers).

---

## How a tick propagates

```mermaid
sequenceDiagram
    autonumber
    participant U as User code
    participant C as advance(dt)
    participant L as active loop
    participant F as frame signal
    participant CB as onComplete drain

    U->>C: clock.advance(16.67)
    C->>C: validate Number.isFinite(dt) && dt >= 0
    C->>C: simTime += dt; tickCount++
    C->>L: iterate activeList[0..activeCount)
    loop per active lane
        L->>L: elapsed = simTime - startTimes[id]
        alt elapsed >= duration
            L->>L: positions[id] = duration
            L->>L: flags[id] |= DONE; &= ~ACTIVE
            L->>L: completedIds[completedCount++] = id
        else
            L->>L: positions[id] = elapsed
            L->>L: writeBack(activeList, id)
        end
    end
    C->>L: activeCount = writeIdx (in-place compaction)
    C->>F: frameSig.set(simTime)
    F-->>U: effects re-run (lane.done() sees DONE)
    C->>CB: drain completedIds
    loop per completed lane with callback
        CB-->>U: onComplete()
    end
```

Key invariants:

1. **Validation is up front.** `dt` is checked once at the entry. Inside the
   hot loop, no per-iter validation.
2. **In-place compaction.** Active lanes are kept packed; completed lanes
   drop out without a second pass.
3. **Frame signal first, callbacks second.** Effects observing `lane.done()`
   see `true` BEFORE the `onComplete` callback fires.
4. **Re-entrant safe.** `onComplete` callbacks may call `clock.lane()`,
   `clock.advance()`, or any clock method. The active loop has finished by
   the time they run, so mutating activeList is fine.
5. **dt=0 still ticks.** The frame signal still propagates; subscribers see
   the call. This matters for paused-but-observable simulations.

---

## API reference

### Top-level

```ts
import { createClock, LiteClockCapacityError } from "@zakkster/lite-clock";
```

Exports:
- `createClock(config?)` -- factory
- `LiteClockCapacityError` -- thrown on pool exhaustion

### createClock

```ts
const clock = createClock({
    capacity?: number;       // default 1024, max 65534
    growable?: boolean;      // default false
});
```

Validation:
- `capacity` must be a positive integer <= 65534 (else `RangeError`)
- `growable` is interpreted strictly: only `=== true` enables growth

### clock.advance

```ts
clock.advance(dt: number): void;
```

The only mutation entry point. Validates `Number.isFinite(dt) && dt >= 0`.
`dt=0` still ticks the frame signal.

### clock.advanceTo

```ts
clock.advanceTo(t: number): void;
```

Advance simTime to absolute `t`. Throws if `t < simTime`. `t === simTime`
is a no-op tick (dt=0 behavior).

### clock.lane

```ts
const lane = clock.lane({
    duration: number;           // > 0
    onComplete?: () => void;    // fires once at duration, end-of-tick
});
```

Allocates from the pool. Throws `LiteClockCapacityError` when the pool is
exhausted and `growable: false`. With `growable: true`, doubles up to 65534.

### lane.start / pause / reverse / dispose

```ts
lane.start();      // begin advancing (or resume from pause)
lane.pause();      // stop advancing; preserves position
lane.reverse();    // toggle direction-of-reporting for position()/t()
lane.dispose();    // free the slot back to the pool
```

All four are idempotent. `dispose()` removes the lane from the active list
if active, frees the slot, and clears any registered `onComplete`. Subsequent
calls on the disposed handle are silent no-ops.

### lane.position / t / done

```ts
lane.position(): number;    // sim-time units, [0..duration]; tracked
lane.t(): number;            // normalized [0..1]; tracked
lane.done(): boolean;        // tracked

lane.positionPeek(): number; // untracked variants
lane.tPeek(): number;
lane.donePeek(): boolean;
```

Tracked reads register a dependency on the clock's frame signal, so reads
inside `effect()` or `computed()` re-evaluate each tick. Reverse mode flips
the reporting: `position()` returns `duration - elapsed`, `t()` returns
`1 - ratio`.

### clock.frame

```ts
clock.frame(): number;                   // tracked
clock.frame.peek(): number;
clock.frame.subscribe(fn: (simTime: number) => void): Dispose;
```

`ReadSignal`-shaped accessor. The signal is force-propagate
(`equals: () => false`) so every `advance()` notifies subscribers even when
simTime didn't actually change (e.g. dt=0).

### clock.attachRAF / attachInterval / detach

```ts
clock.attachRAF();              // drive from requestAnimationFrame
clock.attachInterval(ms);       // drive from setInterval
clock.detach();                 // cancel any attached source
```

Each attach replaces any prior one. `attachRAF` computes `dt` from the
rAF timestamp; `attachInterval` computes `dt` from `performance.now()` between
fires. `setInterval` handles are `.unref()`'d in Node so they don't block
process exit.

### clock.dispose

```ts
clock.dispose();
```

Returns the frame signal's node to the `lite-signal` pool, detaches any
attached tick source, and resets the lane pool. Idempotent. **Required**
for bounded-lifetime clocks (per game level, per route, per component mount)
-- without it, every `createClock()`/`dispose()` cycle leaks one slot from
the lite-signal default registry.

### clock.simTime / ticks / capacity / activeCount

```ts
clock.simTime;        // current sim-time (read-only)
clock.ticks;          // tick counter, incremented per advance()
clock.capacity;       // current pool capacity (changes if growable)
clock.activeCount;    // number of currently-active lanes
```

Plain getters. Not signals -- if you need to react to changes, use
`clock.frame()`.

### LiteClockCapacityError

```ts
class LiteClockCapacityError extends Error {
    readonly name: "LiteClockCapacityError";
    readonly capacity: number;
}
```

Thrown by `clock.lane()` when the pool is exhausted and growth would either
violate `growable: false` or exceed the 65534 hard ceiling. Message names
both escape hatches.

---

## Edge cases pinned down

### `dt=0` still ticks

`clock.advance(0)` increments `ticks` and force-propagates the frame signal
even though `simTime` didn't change. This matters when you want subscribers
to observe the "I am paused" tick (e.g. UI showing "PAUSED" overlay).

### `lane.start()` after completion is a no-op

Once `flags & DONE` is set, `start()` won't reactivate the lane. To replay,
`dispose()` and allocate a fresh lane. This is intentional -- the alternative
(reset on start) makes lane handles ambiguous and breaks `done()` semantics.

### Reverse only affects reporting

The engine advances `elapsed` forward always. `reverse()` flips what
`position()`, `t()`, and `positionPeek()`/`tPeek()` return. **Completion still
fires when forward elapsed reaches duration** -- a reversed lane "rewinds to
start" and completes at `t === 0`. Ping-pong / loop modes are roadmap items
that would change this; see [`ROADMAP.md`](./ROADMAP.md).

### Pool reuse is LIFO

The free list is a stack: the most recently disposed slot is reused first.
This isn't observable through the public API (lane IDs are internal), but
it does mean cache locality is naturally maintained -- a hot slot stays hot.

### onComplete throws are isolated

If an `onComplete` callback throws, the engine catches and logs via
`console.error`. Subsequent callbacks in the same tick still fire, and the
engine remains in a consistent state. The first-throw-blocks-all-throws
behavior would couple unrelated lanes; isolation is safer.

### Lane handles survive pool growth

When `growable: true` and the pool doubles, the SOA TypedArrays are reallocated
(via `Float64Array.prototype.set()` copy). Lane handles route reads through
getter properties on the clock instance, so they automatically see the new
buffers. No handle invalidation, no migration step.

### `clockDispose()` returns the frame node to lite-signal's pool

This is the bug the [pre-1.0.0 review][changelog] caught. Without it, every
clock that gets disposed permanently consumes one slot in `lite-signal`'s
default registry. At 1024 clocks (the default registry capacity), creating
the next one throws `CapacityError`. Now fixed; covered by
[`test/11-dispose-leak.test.mjs`](./test/11-dispose-leak.test.mjs).

[changelog]: ./CHANGELOG.md

---

## Benchmarks

Measured on Node 22.x x64, `--expose-gc`. Numbers are
"ops per second" normalized to the smallest meaningful unit (per advance, per
lane-tick, per alloc/dispose cycle). Retention is GC-corrected steady-state.

```
idle-advance                                   16.31M ops/s   retained:   17.30 KB   (0.0177 B/op)
active-lanes-1k                               117.94M ops/s   retained:    1.04 KB   (0.0001 B/op)
lane-reads-tracked                              3.08M ops/s   retained:   95.07 KB   (0.0974 B/op)
alloc-dispose-churn                             4.70M ops/s   retained:   25.94 KB   (0.1328 B/op)
completion-fanout-100                           8.29M ops/s   retained:    1.94 KB   (0.0040 B/op)
attach-interval-once                            7.75K ops/s   one-time setup cost
```

Reading the table:

- `active-lanes-1k`: 117.94M *lane-ticks* per second -- a single 1ms slice
  of simulation advancing all 1000 lanes. The hot loop is one TypedArray
  scan + write-back per lane.
- `lane-reads-tracked`: 3.08M *frame-ticks* per second with one effect tracking
  three reads (position + t + done). Per "op" includes signal write, effect
  dispatch, three signal reads, three TypedArray loads.
- `alloc-dispose-churn`: 4.70M lane create/dispose cycles per second. Bound
  by `new LaneHandle()` -- a small object allocation per lane. Pooled handles
  are a roadmap item.

Run the full bench yourself:

```bash
npm run bench
```

---

## Testing strategy

Three tiers, all run by `npm run verify`:

### Tier 1 -- Behavior (unit tests, fast)

`npm test` -- 84 functional tests under [`test/`](./test/):

- `01-create.test.mjs` -- config validation, capacity bounds, frozen surface
- `02-advance.test.mjs` -- dt validation, simTime accumulation, frame signal,
  force-propagate
- `03-lane-lifecycle.test.mjs` -- alloc, start/pause/dispose, pool reuse,
  idempotency
- `04-progression.test.mjs` -- position/t/done over time, tracked vs peek,
  computed composition
- `05-reverse.test.mjs` -- flag toggle, pre-start reverse, pause/resume
- `06-completion.test.mjs` -- end-of-tick drain, effect-saw-done ordering,
  throw isolation, callback re-entry
- `07-attach.test.mjs` -- attachInterval (real timers), attachRAF (mocked),
  detach, dispose
- `08-capacity.test.mjs` -- throw vs grow policies, MAX_LANES boundary
- `09-determinism.test.mjs` -- same dt sequence yields identical state
- `11-dispose-leak.test.mjs` -- 4096 create/dispose cycles do not leak
  lite-signal nodes

### Tier 2 -- Memory (allocation-free verification)

`npm run test:gc` -- 4 additional tests under `--expose-gc`:

- `10-gc.test.mjs` -- 1K active lanes x 10K ticks: retention < 256 KB
- 100K empty ticks: retention < 128 KB
- 1M lane-read trio: retention < 128 KB
- 100K alloc/dispose cycles: retention < 1 MB, pool returns to baseline

### Tier 3 -- Performance (measured throughput)

`npm run bench` -- six scenarios with retention budget, see above.

---

## What this is not

- **Not a tween library.** No easing curves, no path interpolation, no
  spring physics. Compose with [`@zakkster/lite-ease`][lite-ease] for
  easing; the lane's `t()` is the input to your easing function.
- **Not a scheduler with priorities.** All lanes advance at the clock's
  rate. If you want priority queues / staggered scheduling, do it in
  consumer code by gating `start()` on conditions.
- **Not a state machine.** Lanes have only four states (alloc, active,
  paused, done). For complex flows, compose with
  [`@zakkster/lite-statechart`][lite-statechart] -- a state's entry action
  can `start()` lanes, an exit action can `dispose()` them.
- **Not async.** No promises, no microtasks, no requestIdleCallback. Every
  call is synchronous. Async coordination belongs upstream.
- **Not a renderer.** This library only computes lane positions. Reading
  those into DOM/canvas/WebGL is your job.

---

## Ecosystem

`lite-clock` is part of the `@zakkster/lite-*` family:

| Package | Role |
| -- | -- |
| [`@zakkster/lite-signal`][lite-signal] | Zero-GC reactive graph (peer dependency) |
| [`@zakkster/lite-statechart`][lite-statechart] | Compiled finite state machines |
| [`@zakkster/lite-ease`][lite-ease] | Zero-alloc easing functions |
| [`@zakkster/lite-lerp`][lite-lerp] | Zero-alloc linear interpolation |
| [`@zakkster/lite-keyframe`][lite-keyframe] | Frame-anchored animation primitives |
| [`@zakkster/lite-room`][lite-room] | CRDT real-time collaboration |
| [`@zakkster/lite-rollback`][lite-rollback] | Deterministic netcode rollback |
| [`@zakkster/lite-persist`][lite-persist] | Storage adapter for signal/statechart |

`lite-clock` is designed to be the timeline beneath `lite-room` (peer interpolation),
`lite-rollback` (frame replay), and any animation work that needs to scale.

[lite-signal]: https://www.npmjs.com/package/@zakkster/lite-signal
[lite-statechart]: https://www.npmjs.com/package/@zakkster/lite-statechart
[lite-ease]: https://www.npmjs.com/package/@zakkster/lite-ease
[lite-lerp]: https://www.npmjs.com/package/@zakkster/lite-lerp
[lite-keyframe]: https://www.npmjs.com/package/@zakkster/lite-keyframe
[lite-room]: https://www.npmjs.com/package/@zakkster/lite-room
[lite-rollback]: https://www.npmjs.com/package/@zakkster/lite-rollback
[lite-persist]: https://www.npmjs.com/package/@zakkster/lite-persist

---

## Browser and runtime support

- **Modern browsers** (Chrome 80+, Firefox 78+, Safari 14+): full support
- **Node**: 18+ (ESM-only)
- **Bun, Deno**: should work; not tested

The package is ESM-only with no CJS shim. `lite-signal` is a peer dependency
that must be resolvable in your bundler/runtime.

---

## Integration recipes

### Driving a DOM animation

```js
import { effect } from "@zakkster/lite-signal";
import { createClock } from "@zakkster/lite-clock";
import { easeOutCubic } from "@zakkster/lite-ease";

const clock = createClock();
clock.attachRAF();

const slideIn = clock.lane({ duration: 400 });

effect(() => {
    const t = slideIn.t();
    const eased = easeOutCubic(t);
    element.style.transform = "translateX(" + (eased * 100) + "%)";
});

slideIn.start();
```

### Lane completion -> next action

```js
const fadeOut = clock.lane({
    duration: 200,
    onComplete: () => {
        element.remove();
        clock.lane({ duration: 200, onComplete: addReplacement }).start();
    }
});
fadeOut.start();
```

### Deterministic test playback

```js
const clock = createClock();
const lane = clock.lane({ duration: 100 });
lane.start();

const dts = [16.67, 33.33, 16.67, 8.33];
for (const dt of dts) clock.advance(dt);

// At this point clock.simTime, lane.positionPeek(), lane.donePeek() are
// 100% deterministic. Run again with the same dts -- identical state.
```

### Synchronizing with lite-statechart

```js
import { createStatechart } from "@zakkster/lite-statechart";
import { createClock } from "@zakkster/lite-clock";

const clock = createClock();
clock.attachRAF();
let pulse;

const machine = createStatechart({
    initial: "idle",
    states: {
        idle:    { entry: () => { pulse?.dispose(); }, on: { START: "pulsing" } },
        pulsing: {
            entry: () => {
                pulse = clock.lane({
                    duration: 1000,
                    onComplete: () => machine.send("DONE")
                });
                pulse.start();
            },
            on: { STOP: "idle", DONE: "idle" }
        }
    }
});
```

### Multi-clock for isolated subsystems

```js
const uiClock = createClock();     // 60fps animations
uiClock.attachRAF();

const simClock = createClock();    // fixed-step physics
simClock.attachInterval(8);        // 125 Hz
```

---

## License

MIT (c) [Zahary Shinikchiev](mailto:shinikchiev@yahoo.com).
