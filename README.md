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
  `Number.isFinite(dt) && dt >= 0`, then scales once by `clock.timeScale`
  (0 is a legal freeze; `advanceTo` is absolute and unscaled). `dt=0` still
  ticks the frame signal
- **In-place active-list compaction**: completed lanes drop out of the hot
  loop without an extra pass
- **End-of-tick onComplete drain**: callbacks fire AFTER signal propagation,
  so effects tracking `lane.done()` see the completion frame BEFORE the
  callback runs
- **Throw-on-overflow by default**, growable opt-in (doubles up to 65534)
- **Tick-source helpers**: `attachRAF()`, `attachInterval(ms)`, `detach()`.
  Manual `advance(dt)` for deterministic tests
- **Reverse mode** that flips reporting without complicating the hot loop
- **Timeline surface (1.3.0)**: `lane.seek()`/`restart()` authored edits,
  `loop`/`pingPong` lanes with a bit-exact overshoot carry (`onComplete` once
  per cycle), and `clock.stats(out?)` counters with a zero-alloc sink form
- **Terminal, idempotent `dispose()`** that returns the frame signal's node to
  the lite-signal pool (no registry leak) and fails closed on later mutation
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

`createClock(config)` performs all setup up front (with one 1.3.0 exception:
the cycling-lane and drain-scratch arrays materialize lazily at first use --
see the block below) and returns a frozen handle:

```
config validation         unknown keys throw (did-you-mean hint)
                          capacity is positive int, <= 65534
                          growable is strictly boolean
                          --------------------------------------
SOA allocation             Float64Array startTimes
                           Float64Array durations
                           Float64Array positions
                           Uint8Array   flags        (ALLOC|ACTIVE|DONE|REVERSE|LOOP|PINGPONG)
                           Uint16Array  activeList   (packed IDs, len activeCount)
                           Int32Array   activeIndex  (-1 sentinel for "not in list")
                           Array        onCompleteFns (sparse JS array)
                           Uint16Array  completedIds (end-of-tick scratch)
                           Uint32Array  generations  (per-slot ABA tags)
                           Uint16Array  freeList     (stack of free IDs)
                          --------------------------------------
lazy SOA (1.3.0)           NOT allocated by createClock. Materialized once per
                           clock at first use, so a bare createClock()/dispose()
                           cycle allocates nothing beyond 1.2.0:
                           Uint32Array  completedCycles + completedGens
                                        (drain scratch -- first lane() call)
                           Float64Array baseStartTimes (cycle-carry base --
                                        first loop/pingPong lane)
                           Uint32Array  cycleCounts  (completed cycles per
                                        lane -- first loop/pingPong lane)
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
    C->>C: dt *= timeScale (overflow fails closed)
    C->>C: simTime += dt, tickCount++
    C->>L: iterate activeList[0..activeCount)
    loop per active lane
        L->>L: elapsed = simTime - startTimes[id]
        alt elapsed >= duration, loop / pingPong lane
            L->>L: k += cycles; start = base + k*dur (bit-exact carry)
            L->>L: queue (id, cycles, gen); stays active
        else elapsed >= duration, plain lane
            L->>L: positions[id] = duration
            L->>L: flags[id] |= DONE, &= ~ACTIVE
            L->>L: queue (id, 1, gen)
        else
            L->>L: positions[id] = elapsed
            L->>L: writeBack(activeList, id)
        end
    end
    C->>L: activeCount = writeIdx (in-place compaction)
    C->>F: frameSig.set(simTime)
    F-->>U: effects re-run (lane.done() sees DONE)
    C->>CB: drain completedIds
    loop per queued lane, once per cycle (generation re-checked before each fire)
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
4. **The tick is atomic.** Compaction -> frame propagation -> onComplete drain
   is one indivisible tick. A callback, effect, or subscriber may call
   `clock.lane()`, `clock.dispose()`, `pause()`, `start()`, `reverse()`,
   `attachInterval()`, or `detach()` -- all legal. Calling `clock.advance()` or
   `clock.advanceTo()` AGAIN during the tick throws `LiteClockReentrancyError`;
   schedule follow-up advances for the next frame. The drain runs in a
   `finally`, so a queued completion is never dropped even if a re-entering
   effect throws.
5. **dt=0 still ticks.** The frame signal still propagates; subscribers see
   the call. This matters for paused-but-observable simulations -- and it is
   exactly what `timeScale = 0` produces: every advance becomes a dt=0 tick
   that propagates and completes nothing.
6. **Stale handles are ABA-proof.** Every slot carries a `Uint32` generation
   tag, bumped on every disposal. A `Lane` stamps the tag at `lane()` and
   compares first on every method and read, so a handle to a freed-and-reused
   slot proves stale and takes the inert path -- it never drives or observes the
   next tenant. The silent-no-op promise is now enforced, not merely documented.
7. **A dead clock fails closed.** `clock.dispose()` is terminal. The mutation
   surface (`advance`, `advanceTo`, `lane`, `attachRAF`, `attachInterval`,
   `frame.subscribe`) throws `LiteClockDisposedError`; `simTime`/`ticks` freeze;
   reads return the frozen `simTime` (a number, never `undefined`). The disposed
   check runs BEFORE the re-entrancy check, so a dead clock always throws
   `LiteClockDisposedError`, never `LiteClockReentrancyError`.
8. **The cycle carry is bit-exact.** A loop/pingPong lane crossing its
   duration recomputes its effective start from a stored base and an integer
   cycle count (`base + k*duration`, one rounding) instead of accumulating
   floats, so any dt partition reaching the same total yields bit-identical
   state AND identical per-cycle `onComplete` fire counts (gated in torture
   t0; the accumulating variant is torture control #5 and demonstrably
   diverges).

---

## API reference

### Top-level

```ts
import {
    createClock,
    LiteClockCapacityError,
    LiteClockReentrancyError,
    LiteClockDisposedError
} from "@zakkster/lite-clock";
```

Exports:
- `createClock(config?)` -- factory
- `LiteClockCapacityError` -- thrown on pool exhaustion
- `LiteClockReentrancyError` -- thrown on re-entrant advance during a tick
- `LiteClockDisposedError` -- thrown by the mutation surface of a disposed clock

### createClock

```ts
const clock = createClock({
    capacity?: number;       // default 1024, max 65534
    growable?: boolean;      // default false
});
```

Validation (fails closed):
- an unknown config key throws `TypeError` with a did-you-mean hint --
  `createClock({capacty: 4})` throws
  `"createClock: unknown option 'capacty' -- did you mean 'capacity'?"`
- `capacity` must be a positive integer <= 65534 (else `RangeError`)
- `growable` must be exactly a boolean when present (else `TypeError`);
  absent means `false`

### clock.advance

```ts
clock.advance(dt: number): void;
```

The only mutation entry point. Validates `Number.isFinite(dt) && dt >= 0` on
the RAW dt, then scales once at entry: `sdt = dt * timeScale`. A finite
product that overflows to non-finite throws `RangeError` naming both inputs.
`dt=0` (raw or scaled -- `timeScale = 0` lands here) still ticks the frame
signal and completes nothing.

### clock.advanceTo

```ts
clock.advanceTo(t: number): void;
```

Advance simTime to absolute `t`. Throws if `t < simTime`. `t === simTime`
is a no-op tick (dt=0 behavior). advanceTo is ABSOLUTE and UNSCALED: it
reaches `t` exactly at any `timeScale`, 0 included (an explicit destination
overrides the freeze). The identity `advanceTo(t) === advance(t - simTime)`
holds only at `timeScale === 1`.

### clock.timeScale

```ts
clock.timeScale;          // get: current multiplier, default 1
clock.timeScale = 0.5;    // set: slow motion; 0 freezes; 2 fast-forwards
```

Clock-wide rate multiplier applied to `advance(dt)` once at entry. The setter
fails closed: a non-finite, negative, or non-number value throws `RangeError`
(`"clock.timeScale: must be a finite non-negative number (got X)"`); setting
on a disposed clock throws `LiteClockDisposedError`. The getter never throws
and returns the frozen value after dispose. Setting mid-tick is legal and
takes effect at the next `advance()`. `attachRAF`/`attachInterval` drive the
public `advance()`, so wall-clock dts ARE scaled -- attach a rAF source and
set `timeScale = 0.25` for slow motion. timeScale is replay state: the same
sequence of assignments and advances replays identically.

### clock.lane

```ts
const lane = clock.lane({
    duration: number;           // > 0
    onComplete?: () => void;    // fires once per completed cycle, end-of-tick
    loop?: boolean;             // wrap at duration; never DONE
    pingPong?: boolean;         // wrap + flip reported direction each cycle
});
```

Allocates from the pool. An unknown opts key throws `TypeError` with a
did-you-mean hint (`onComplte` -> `"did you mean 'onComplete'?"`). Throws
`LiteClockCapacityError` when the pool is exhausted and `growable: false`.
With `growable: true`, doubles up to 65534 -- the final growth step clamps to
the ceiling, so 65534 is reachable from any starting capacity.

`loop` and `pingPong` must be exactly booleans when present (`TypeError`
otherwise) and are mutually exclusive -- both true throws
`"clock.lane: loop and pingPong are mutually exclusive"`. A cycling lane is
never DONE: `done()` reports `false` for its whole life, `t()` cycles in
`[0, 1)` (a `seek(duration)` edit parks it at exactly 1 until the next
advance), and `onComplete` fires once per completed cycle -- a single advance
spanning N cycles fires it N times (clamp pathological dts upstream; the
attach helpers produce bounded ones). pingPong flips the same REVERSE flag
`reverse()` toggles, so the two compose.

### lane.start / pause / reverse / seek / restart / dispose

```ts
lane.start();      // begin advancing (or resume from pause)
lane.pause();      // stop advancing; preserves position
lane.reverse();    // toggle direction-of-reporting for position()/t()
lane.seek(p);      // authored edit: clamp to [0, duration] and jump there
lane.restart();    // seek(0) + start() -- the replay primitive
lane.dispose();    // free the slot back to the pool
```

start/pause/reverse/dispose are idempotent. `dispose()` removes the lane from the active list
if active, frees the slot, clears any registered `onComplete`, and bumps the
slot's `Uint32` generation tag.

Subsequent calls on the disposed handle are TRUE silent no-ops -- and this is
now enforced, not merely promised. The pool free list is LIFO, so a disposed
slot is reused immediately; a handle that only checked "is my slot allocated?"
would drive and observe the new tenant (the pre-1.1.0 C-04 bug). Each handle
stamps the slot's generation at `lane()` and compares it FIRST on every method
and read. A generation mismatch is provably a stale handle: methods no-op,
`position()`/`t()` return `0`, `done()` returns `false`, and the tracked reads
do NOT touch the frame signal, so a stale read inside an `effect` creates no
reactive dependency. `Uint32` pushes a generation wrap past two years of
continuous single-slot churn. Stale means stale: a handle from a freed slot
never touches the slot's next tenant.

`seek(p)` is an authored EDIT, not time (see
[`decisions/0003-seek.md`](./decisions/0003-seek.md)): it clamps a finite `p`
to `[0, duration]`, re-bases the cycle carry, and clears DONE iff the new
position is below duration. It NEVER starts a stopped lane (a DONE lane
seeked below duration becomes PAUSED at `p`), NEVER fires `onComplete`, NEVER
sets DONE, and NEVER ticks the frame signal -- peeks see the new position
immediately, tracked reads pull it on the next tick. A non-finite `p` throws
`RangeError` on a live handle; a stale handle stays a TRUE silent no-op even
for garbage input (the stale check runs first). `seek(duration)` parks the
lane AT its duration without completing it: completion is advance-exclusive
and needs a compaction pass, so a following `advance(0)` completes nothing
while any `advance(dt > 0)` completes it. `restart()` re-bases an ACTIVE lane
to 0 without leaving the active list, and clears-and-runs a finished one --
use it instead of the old dispose-and-reallocate replay pattern.

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

On a disposed clock `frame()` and `frame.peek()` return the frozen `simTime`
(a number, never `undefined`). `frame.subscribe` on a disposed clock THROWS
`LiteClockDisposedError` -- a subscription on a dead clock could never fire
again (every `advance()` throws), so a silent no-op subscriber would be a trap.

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

TERMINAL. Returns the frame signal's node to the `lite-signal` pool, detaches
any attached tick source, and retires every lane (each slot's generation is
bumped, so every outstanding handle proves stale). Idempotent.

Dispose is terminal, NOT a reset. `simTime` and `ticks` FREEZE at their last
values -- they do not rewind (reading a frozen count is more honest than a
silently-rewound zero). After dispose the mutation surface fails closed:
`advance`, `advanceTo`, `lane`, `attachRAF`, `attachInterval`, and
`frame.subscribe` throw `LiteClockDisposedError`. `frame()` and `frame.peek()`
return the frozen `simTime` (never `undefined`). `detach()` and `dispose()`
stay idempotent no-ops. A `dispose()` from an effect/subscriber firing during a
tick is legal: the in-flight tick completes, then the next mutation throws.

**Migration** from a "reset and reuse" pattern: dispose means dispose. Create a
new clock with `createClock()` instead of expecting counters to rewind.

**Required** for bounded-lifetime clocks (per game level, per route, per
component mount) -- without it, every `createClock()`/`dispose()` cycle leaks
one slot from the lite-signal default registry.

### clock.simTime / ticks / capacity / activeCount

```ts
clock.simTime;        // current sim-time (read-only)
clock.ticks;          // tick counter, incremented per advance()
clock.capacity;       // current pool capacity (changes if growable)
clock.activeCount;    // number of currently-active lanes
```

Plain getters. Not signals -- if you need to react to changes, use
`clock.frame()`.

### clock.stats

```ts
clock.stats(): ClockStats;          // allocating convenience form
clock.stats(out): ClockStats;       // fills `out` in place -- zero allocation
```

Seven counter fields: `poolUsed`, `poolFree`, `peakActive` (high-water
active-lane count, monotone), `totalTicks`, `totalCompletions` (completed
CYCLES -- a multi-cycle advance counts them all, callback-less lanes count
too), `capacity`, `timeScale`. With `out` present it must be a non-null
object (else `TypeError`); the sink is filled and returned with zero
allocation (gated in torture t6's churn window), so it is safe in a HUD loop.
Without `out` a fresh object is allocated -- the documented convenience form.
stats stays readable after `dispose()`: counters and timeScale freeze, and
the pool reads as empty (dispose retires every lane). Feeds `lite-devtools`.

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

### LiteClockReentrancyError

```ts
class LiteClockReentrancyError extends Error {
    readonly name: "LiteClockReentrancyError";
}
```

Thrown by `clock.advance()` / `clock.advanceTo()` when re-entered during a tick
(from an `onComplete` callback, an effect tracking `frame()`, or a
`frame.subscribe` subscriber). The tick is atomic; schedule follow-up advances
for the next frame.

### LiteClockDisposedError

```ts
class LiteClockDisposedError extends Error {
    readonly name: "LiteClockDisposedError";
}
```

Thrown by the mutation surface of a disposed clock -- `advance()`,
`advanceTo()`, `lane()`, `attachRAF()`, `attachInterval()`, and
`frame.subscribe()`. The disposed check runs BEFORE the re-entrancy check, so a
dead clock always throws `LiteClockDisposedError`, never
`LiteClockReentrancyError`. Reads never throw and never return `undefined`.
`dispose()` is terminal; create a new clock with `createClock()`.

---

## Edge cases pinned down

### `dt=0` still ticks

`clock.advance(0)` increments `ticks` and force-propagates the frame signal
even though `simTime` didn't change. This matters when you want subscribers
to observe the "I am paused" tick (e.g. UI showing "PAUSED" overlay).

### `lane.start()` after completion is a no-op

Once `flags & DONE` is set, `start()` won't reactivate the lane. To replay,
call `restart()` (1.3.0) -- or `seek()` below the duration and `start()`.
This is intentional -- the alternative (reset on start) makes lane handles
ambiguous and breaks `done()` semantics; `seek` clears DONE explicitly,
which keeps the ambiguity out of `start()`.

### Reverse only affects reporting

The engine advances `elapsed` forward always. `reverse()` flips what
`position()`, `t()`, and `positionPeek()`/`tPeek()` return. **Completion still
fires when forward elapsed reaches duration** -- a reversed lane "rewinds to
start" and completes at `t === 0`. As of 1.3.0, `pingPong` builds on exactly
this: each completed cycle flips the same REVERSE flag, so the reported
trajectory is a triangle wave while the engine still only ever advances
forward. A user `reverse()` on a pingPong lane composes -- both toggle the
one flag.

### Pool reuse is LIFO

The free list is a stack: the most recently disposed slot is reused first.
This isn't observable through the public API (lane IDs are internal), but
it does mean cache locality is naturally maintained -- a hot slot stays hot.
Because a disposed slot is reused immediately, a `Uint32` generation tag per
slot makes a stale handle ABA-proof: it can never be mistaken for a live handle
to the same slot's new tenant (see invariant 6 and `lane.dispose`).

### `dispose()` is terminal, not a reset

`clock.dispose()` freezes `simTime`/`ticks` and fails the mutation surface
closed with `LiteClockDisposedError` (see invariant 7 and `clock.dispose`). A
`dispose()` from a callback/effect firing mid-tick is legal: the in-flight tick
completes, then the next mutation throws. To replay a timeline, create a new
clock -- there is no rewind.

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
