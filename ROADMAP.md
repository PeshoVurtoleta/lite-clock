# lite-clock -- enriched roadmap

Seven sessions for one package, plus a torture-suite spec. Supersedes the
previous ROADMAP.md (the speculative 1.1/1.2 candidate list).

**Why it grew.** The old roadmap's premise was "the 1.0 API is final, additions
land only after a real consumer pulls on them." That premise assumed the 1.0
foundations -- re-entrancy safety, handle no-ops, the Zero-GC gate -- were
verified. I pulled the package and ran the code. They are not. Thirteen
findings are listed in section 2 and **every one of them was reproduced**, not
inferred from reading. Four are S1 silent corruption, and `@zakkster/lite-clock@1.0.0`
is live on the registry right now.

The philosophy survives: no speculative surface, every addition earns its way
in. What changes is the order. The old roadmap deferred features while standing
on an unverified foundation; this one fixes the foundation first (K0-K3), then
admits the features whose triggers have actually fired (K4), then ships the one
capability that makes this package the only one of its kind (K5), and
reconciles the docs last (K6).

**What stays unique.** The identity is the SOA + one-frame-signal architecture:
N lanes cost one signal write per tick, lane state lives in flat TypedArrays,
`advance(dt)` is deterministic. No session below turns this into a tween
library, adds per-lane signals, or couples it to the microtask queue -- the
"Deferred indefinitely" list at the bottom survives almost intact. The A+ move
is not more surface; it is making the determinism claim load-bearing
(snapshot/hydrate + fixed-step) so `lite-rollback` and `lite-room` can stand
on it.

---

## 0. Metadata corrections (checked; mostly clean)

Verified against the registry and the repo on 2026-09-05:

| Check | Status |
| --- | --- |
| `@zakkster/lite-clock` published | 1.0.0 |
| `package.json` homepage/repository/bugs | all point at `PeshoVurtoleta/lite-clock` -- correct (no lite-arena-style cross-wiring) |
| `@zakkster/lite-gc-profiler` on registry | 1.16.0 |
| `@zakkster/lite-leak` on registry | 1.10.0 (needs `lite-signal >= 1.5.0`) |
| `@zakkster/lite-signal` on registry | 1.5.0 |
| llms.txt peer range | says `^1.2.0`; package.json says `^1.2.2` -- **drift** (C-10) |
| `VERSION` const in Clock.js | **missing** -- two-place sync, not three (C-10) |
| README install command | **missing entirely** (C-11) |

---

## 1. Shared law (holds across every session)

1. **`advance(dt)` is the only way sim-time moves.** Every other guarantee
   hangs off this. K4's `seek()` amends the wording ("sim-time only advances
   via advance(); lane-local edits are legal between ticks"), and that
   amendment gets a decision record, not a silent edit.
2. **The completion window is part of the hot path's contract.** Compaction ->
   frame propagation -> callback drain is one atomic tick. Anything user code
   can call during propagation or drain either works correctly or throws at
   the door. "Silently drops a queued callback" is not one of the options.
3. **A handle is a capability, not a pointer.** A stale handle must never
   observe or control a slot's next tenant. The docs already promise this
   ("silent no-ops"); the code must make it true.
4. **Fail closed on every unverified state.** A disposed clock that keeps
   accepting work is fail-open. An unknown config key is an error with a
   did-you-mean hint, never a silent ignore. `null` is not zero.
5. **Bytes in a hot body, not instructions.** Every guard added below is
   either provably outside `advance()`'s per-lane loop and the tracked-read
   path, or measured within noise by `assertOps` against the prior release --
   and the number goes in the decision record either way.
6. **Determinism is bit-exact, not approximate.** Same op sequence, same
   state, including across snapshot/hydrate and across dt-splits. Laws are
   asserted with `===` on Float64 values, never epsilon.
7. **Every gate must be provably able to fail.** Each torture tier ships a
   deliberately broken control that exits non-zero. A green gate that cannot
   go red is decoration (see the AR-02 lesson, section 3).

---

## 2. Verified findings

Reproduced against `main` (identical to published 1.0.0) on 2026-09-05, Node 26,
`lite-signal` 1.5.0. Severity: **S1** = silent corruption or loss, **S2** =
broken documented guarantee, **S3** = hygiene/contract gap.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **C-01** | **S1** | **Re-entrant `advance()` silently drops queued completion callbacks, forever.** The drain loop's bound is the shared `completedCount`, which a nested `advance()` resets to 0. Reproduced from an `onComplete` callback AND from a `frame.subscribe` subscriber firing during propagation. The dropped lane reports `done() === true` and its callback never fires on any later tick. README invariant #4 ("Re-entrant safe... may call `clock.advance()`") and llms.txt say the opposite. | 2 lanes complete same tick; first callback calls `advance(1)` -> fired `["A"]`, B lost. Subscriber variant: `bFired=false`. Loss permanent after +200ms of ticks. |
| **C-02** | **S1** | **Pool growth during the drain corrupts the callback queue.** Re-entrant `lane()` on a growable clock replaces `completedIds` with a fresh zeroed Uint16Array while the drain is iterating it; remaining iterations read id 0. | capacity 2, growable; 2 lanes complete same tick; first callback allocates a third lane -> fired `["A","A"]` -- A twice, B never. |
| **C-03** | **S1** | **Slot reuse during the drain fires the new tenant's callback at t=0.** A callback that disposes a queued sibling and allocates a new lane gets the same id back (LIFO free list); the drain then fires the NEW lane's `onComplete` on its creation tick. | A's callback disposes queued B, creates C with a callback -> fired `["A","C"]` with `C.t() === 0` at the same simTime. |
| **C-04** | **S1** | **Stale-handle ABA: a disposed handle fully controls the slot's next tenant.** After dispose + realloc (which is immediate -- the free list is LIFO), the old handle's `dispose()` kills the new lane, `pause()/start()/reverse()` drive it, and reads mirror it. The documented "subsequent calls on the disposed handle are silent no-ops" is false the moment the slot is reused. | lane A id0, `a.dispose()`, lane B reuses id0, B running at t=0.5; stale `a.dispose()` -> `activeCount` 1 -> 0, B dead. Stale `a.tPeek()` tracks the tenant: 0.500. |
| **C-05** | S2 | **The growable ceiling is unreachable.** Docs/d.ts/llms.txt: "doubles up to 65534". Growth throws when `oldCap * 2 > 65534`, so a default clock stops at **32768**; only an initial capacity of exactly 32767 can ever reach 65534. | `createClock({growable: true})`, alloc until throw -> `LiteClockCapacityError` after 32768; `clock.capacity === 32768`. |
| **C-06** | S2 | **Zombie clock: the full API keeps "working" after `dispose()`, with reactivity silently dead.** `lane()` allocates, `advance()` runs, `onComplete` FIRES -- but tracked reads no longer track (effects never re-run) and `frame()` returns `undefined` where d.ts says `number`. The only reason this is not cross-signal corruption is lite-signal's own `birthGen` guard on recycled nodes (verified in Signal.js source) -- lite-clock contributes nothing to its own safety here. | dispose, then `lane({onComplete})` + `advance(10)` -> callback fired, `simTime` advanced, effect re-runs 0, `frame() === undefined`. |
| **C-07** | S2 | **Config fails open.** `createClock({capacty: 4})` is accepted silently (capacity stays 1024). `lane({duration, onComplte: fn})` is accepted silently -- the animation runs and the callback never fires. `growable: 1` is silently treated as `false` (only `=== true` enables). Suite law: unknown key -> error with did-you-mean. | all three probed as written. |
| **C-08** | S2 | **`dispose()` contract drift.** d.ts: dispose "resets simTime/ticks counters". It does not -- both survive. Together with C-06 the dispose story is: partial reset, live API, dead reactivity, wrong types. | `advance(5); advance(3); dispose()` -> `simTime === 8`, `ticks === 2`. |
| **C-09** | S2 | **The Zero-GC gate cannot prove the Zero-GC claim.** There is no `test/torture.mjs`, no `lite-leak`, no `lite-gc-profiler` -- the pipeline's mandatory gate is absent. What exists is hand-rolled `heapUsed` deltas with budgets of 128-256 KB: 10K ticks under a 256 KB budget tolerates ~26 B/op of steady allocation, so a fully allocating hot path could ship green. No `maxMajor: 0` gate exists anywhere. | read `test/10-gc.test.mjs`, `package.json` devDeps. |
| **C-10** | S3 | **Three-place version-sync law broken.** No `VERSION` const in Clock.js; llms.txt carries no version line and pins the peer at `^1.2.0` vs package.json's `^1.2.2`. | grep. |
| **C-11** | S3 | **README is off-blueprint and its numbers are unstamped.** No install command anywhere in README (llms.txt has one). Missing the LiteSepforge spine sections: positioning H2 with inline install + quick start, `<details>` core deep-dive, `<details>` Zero-GC design notes with allocation table, "Design decisions worth knowing". Bench table prints numbers with no version/machine provenance -- this machine measures `active-lanes-1k` at 356.83M ops/s vs the README's 117.94M; both are "true" and neither says where it came from. | compare README to `LiteSepforge/README.md`; run `npm run bench`. |
| **C-12** | S3 | **Dead guard in the hottest read.** `t()`/`tPeek()` branch on `if (dur <= 0) return 0` -- unreachable: `lane()` validates `duration > 0` and `disposeLane` never zeroes `durations`. Bytes in a hot body. | code walk + the C-04 probe shows disposed slots retain their duration. |
| **C-13** | S3 | **Green tests sit exactly over the holes** (the AR-02 pattern). `06-completion.test.mjs` proves "callback can start another lane mid-drain" -- the safe subset -- while the docs promise "callbacks may call ANY clock method, including advance()". No test calls `advance()` from a callback, triggers growth from a callback, or disposes a queued sibling. The suite is green over C-01, C-02, and C-03 simultaneously. | read `test/06-completion.test.mjs` test list vs README invariant #4. |

**C-01/02/03 are one bug in three costumes:** the completion queue
(`completedIds` + `completedCount`) is singly-buffered shared state, and the
drain trusts it across a propagation phase that can re-enter the clock. K1
fixes the class, not the costumes.

### The one invariant that catches most of these at once

```
count(flags[i] & ALLOC) + freeTop === capacity              (slot conservation)
forall i in [0, activeCount): activeIndex[activeList[i]] === i
(flags[id] & ACTIVE) !== 0  <=>  activeIndex[id] !== NO_INDEX
```

C-02, C-03, and any future free-list or compaction bug violate at least one
line immediately. O(capacity) to check, so it lives in a test-only
`_invariant()` hook and runs between torture phases -- never in the hot path.
K0 builds it; every later session leans on it.

---

## 3. The torture suite (`test/torture.mjs`) -- spec

One harness, ten tiers. This is the DONE-WHEN gate every session leans on:
built once in K0, extended in place by each later session. Runs as
`node --expose-gc test/torture.mjs`, prints exactly "ok", exit 0/1.

### Layout

```
test/
  torture.mjs           # entry: tiers in order, prints "ok", exit 0/1
  torture/
    harness.mjs         # scratch pools, zero-alloc asserts, seeded PRNG, gc wrappers
    t0-laws.mjs         # metamorphic determinism laws
    t1-degenerate.mjs   # nasty scalar inputs, pinned per-op
    t2-reentrancy.mjs   # the re-entrancy matrix (lite-clock's aliasing matrix)
    t3-adversarial.mjs  # sequences crafted to break compaction/drain/growth
    t4-handles.mjs      # stale-handle and dead-clock abuse
    t5-fuzz.mjs         # differential fuzz vs a naive per-lane oracle
    t6-alloc.mjs        # lite-gc-profiler gate: maxMajor 0 + structural asserts
    t7-soak.mjs         # lite-leak churn + the conservation invariant
    t8-cross.mjs        # lite-signal contract conformance + lite-ease smoke
    t9-controls.mjs     # every gate above, deliberately broken, must fail
```

`test/` never enters `files[]`. `npm pack --dry-run` proves it. The existing
`test/01..11` behavior suites stay -- the torture suite is the gate, not a
replacement for the unit tier. `10-gc.test.mjs` survives as a fast smoke;
the *authoritative* memory gate moves to t6/t7.

### Harness rules

- All clocks, lanes, scratch buffers, and callback-log arrays allocated
  **once**, outside every loop. A template literal per iteration is an
  allocation and will fail your own gate; build messages only on failure.
- Seeded xorshift32 PRNG. On any failure print the seed and op index;
  `TORTURE_SEED=... node --expose-gc test/torture.mjs` replays it.
- lite-gc-profiler: **one measurement in flight at a time**; tiers run
  sequentially, never nested. `await` a settle tick before reading
  `summary()` or the gate reads an empty window and false-PASSes.
- lite-leak held-value contract: neither the `cleanup` closure nor the `tag`
  may close over the tracked clock/lane -- capture detached primitives only.
- Never resolve an unexpected `inconclusive` with `allowInconclusive`.
- Read `../lite-gc-profiler/llms.txt` and `../lite-leak/llms.txt` for the
  exact current surfaces before wiring -- do not write gate calls from memory.

### t0 -- metamorphic determinism laws

Checked over the fuzz corpus, asserted with `===` (these are exact by
construction -- positions derive from `simTime - startTimes`, so dt-splits
introduce zero float error):

- **dt-split invariance**: `advance(a); advance(b)` produces bit-identical
  lane positions, flags, and completion sets to `advance(a + b)` (tick counts
  and propagation counts differ; that is documented, and the law says so).
- `advanceTo(t)` is identical to `advance(t - simTime)`.
- **Replay determinism**: the same op sequence on two fresh clocks yields
  identical `simTime`, positions, `t()`, `done()`, and callback firing order.
- `pause(); start()` at the same simTime is an identity on position.
- `reverse(); reverse()` is an identity everywhere.
- `dispose(); lane({...})` conserves the invariant of section 2.
- Completion fires exactly at `elapsed >= duration`, and a lane completing at
  exactly `t === duration` reports `position === duration`, `t === 1`.
- (From K4 on) loop-lane overshoot carry preserves dt-split invariance.
- (From K5 on) `snapshot(); hydrate(); advance(d)` is bit-identical to
  `advance(d)` without the round-trip.

### t1 -- degenerate values

Cross every entry point with: `0`, `-0`, `Number.EPSILON`, subnormals,
`Number.MAX_VALUE`, `Infinity`, `-Infinity`, `NaN`, negative values, huge dt
that completes everything at once, `capacity` in {1, 2, 32767, 65534},
duration in {subnormal, 1e9, MAX_VALUE}. Pin the actual answer for each --
throws are pinned by error class AND message content (the message names the
escape hatches; that is contract).

### t2 -- the re-entrancy matrix (this is where C-01/02/03 live)

The completion window has three re-entry surfaces; every clock method gets a
named cell in each:

| Called from -> | onComplete drain | effect tracking `frame()` | `frame.subscribe` fire |
| --- | --- | --- | --- |
| `advance` / `advanceTo` | **BROKEN (C-01)** -> policy: throw | **BROKEN (C-01)** -> throw | **BROKEN (C-01)** -> throw |
| `lane()` (no growth) | works -- pin it | pin | pin |
| `lane()` (triggers growth) | **BROKEN (C-02)** | **BROKEN (C-02)** | **BROKEN (C-02)** |
| `dispose(own lane)` | works -- pin | pin | pin |
| `dispose(queued sibling)` | skips callback -- pin as contract | pin | pin |
| `dispose(sibling) + realloc` | **BROKEN (C-03)** | **BROKEN (C-03)** | **BROKEN (C-03)** |
| `pause` / `start` / `reverse` | pin | pin | pin |
| `clock.dispose()` | decide + pin | decide + pin | decide + pin |
| `attachInterval` / `detach` | pin | pin | pin |

Every cell gets a named test. Broken cells are fixed by K1 and their tests
prove fail-before/pass-after in the K1 CHANGELOG. NOTE: lite-signal fires a
`subscribe` callback immediately at subscribe time (verified; pinned in t8) --
re-entry tests must trigger on the second fire, not the first, or they test
nothing (this exact mistake produced a false "safe" result during the probe
work for this document).

### t3 -- adversarial sequences

- 10K lanes completing in one tick (drain at scale, callback log order pinned).
- LIFO churn storm: dispose/realloc the same slot 100K times inside callbacks.
- Growth at the exact boundary: 32767 -> 65534, and the 65535th lane.
- Interleaved pause/dispose/complete on adjacent activeList slots (compaction
  swap correctness -- the `removeFromActive` swap is the sharp edge).
- Callback chains that re-arm a new lane each tick for 10K ticks.
- `advance(dt)` alternating between huge (completes everything) and 0.
- The invariant of section 2 asserted after every sequence.

### t4 -- handle and lifecycle abuse

Stale handle (post-dispose, post-reuse, post-clock-dispose) x every method and
read; double dispose; `dispose` interleaved with `pause`; every clock method
on a disposed clock; `attachRAF` on Node (throws -- pin); `attachInterval`
replace semantics; handles created before growth read correctly after growth.
Each cell gets a decided policy: **throw**, **documented no-op**, or
**documented inert value**. "Silently controls someone else's lane" is not
one of the three. C-04/C-06/C-08 fixes land in K2; register cells as failing
todo in K0.

### t5 -- differential fuzz against an oracle

Ground truth: a naive per-lane object implementation (plain `{start, dur,
pos, active, done, reversed, cb}` array, O(N) advance). Drive 100K mixed ops
(advance / advanceTo / lane / start / pause / reverse / dispose / read) from
the seeded PRNG against both. After every advance, compare `simTime`, every
live lane's `position/t/done`, and the callback logs. Any divergence prints
seed + op index + a minimal replay. This is the tier that finds the bug
nobody thought to name.

### t6 -- the zero-alloc gate

```js
// shape only -- read ../lite-gc-profiler/llms.txt for the current surface
const summary = await measureOps(runMixedHotLoop, { stabilize: 'deep' });
const verdict = checkNoGc(summary, {
  maxMajor: 0,
  maxPauseMs: 4,
  maxArrayBuffersGrowth: 0,   // growth is opt-in; a non-growable clock's
                              // buffers must be byte-stable under any load
});
```

Plus direct structural assertions no heap gate can substitute for:

```js
assert.equal(clock.capacity, CAP_BEFORE);           // non-growable never grows
// via the K0 debug hook: activeList/positions buffer identity stable
```

Hot loops gated: `advance` with 1K active lanes; tracked read trio under one
effect; alloc/dispose churn (handle allocation is the known, documented
exception -- gate its rate, not its existence); completion fan-out.

### t7 -- soak and conservation

lite-leak tracker with the owner-cascade and async-retention kernels:
4096 create/dispose clock cycles (the 11-dispose-leak scenario, now under the
tracker instead of hand-rolled registry counting); 4096 lane churn cycles per
clock. After each cycle: `tracker.size() === 0`, the section-2 invariant, and
`activeCount === 0`. Sample heap across cycles, not within one.

### t8 -- cross-package conformance

- lite-signal contract: `dispose()` returns the frame node (4096 cycles, no
  `CapacityError`); tracked reads re-run effects exactly once per advance;
  `subscribe` fires immediately on subscribe (pinned -- lite-clock's t2 tests
  and consumers depend on knowing this); a disposed clock's set is inert
  (lite-signal `birthGen` behavior pinned so an upstream change screams here
  instead of corrupting silently).
- lite-ease composition smoke: `ease(lane.t())` inside an effect, zero alloc.
- Read `../lite-signal/llms.txt` for the current surface first; do not assume.

### t9 -- controls (the gate must be able to fail)

For every gate above, a deliberately broken variant that must exit non-zero:
an allocating advance wrapper against t6; a corrupted oracle against t5; the
C-01 reproducer against a build with the K1 guard commented out (kept behind
an env flag); a leaking cleanup closure against t7; a wrong-order callback log
against t3. If a control passes, the gate is decorative.

---

## 4. Session order

```
K0 -> K1 -> K2 -> K3 -> K4 -> K5 -> K6
     drain   handles  config  earned  keystone docs
```

Strictly linear. K1 blocks everything (nothing may be built on a drain that
drops callbacks). K2 needs K1's tick guard to define stale-handle behavior
inside the completion window. K3 is independent of K2 in code but sequenced
for release cadence. K4 before K5 because `timeScale` must exist before the
snapshot format freezes (a snapshot that omits it is a format break later).
K6 last because every earlier session moves the surface it documents.

---

## 5. The briefs

===============================================================================
# K0 -- lite-clock v1.0.1 -- the torture harness + version sync
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.0.1
status: shipped (2026-09-05 -- folded into the 1.0.2 publish; no separate 1.0.1 on npm)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-signal", "@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [C-09, C-10, C-13]
blocks: [K1]
---

# lite-clock -- stand up the gate everything else leans on

PURPOSE
  The pipeline law says every module change is proven by
  `node --expose-gc test/torture.mjs`. The file does not exist. The memory
  tests that do exist gate "retention < 256 KB", a budget porous enough to
  pass a ~26 B/op steady leak. Build the real gate, register the known
  failures, change no behavior.

TASKS
  - devDeps: `@zakkster/lite-gc-profiler` ^1.16.0, `@zakkster/lite-leak`
    ^1.10.0, bump `@zakkster/lite-signal` devDep to ^1.5.0 (lite-leak floor;
    the published peer range `^1.2.2` is unchanged).
  - Build `test/torture.mjs` + `test/torture/harness.mjs` per section 3.
    Wire t0, t1, t6, t7, t9 now; register t2/t3/t4/t5/t8 as named tiers with
    the C-01..C-08 reproductions from section 2 in `todo` state -- visible,
    replayable, not yet gating.
  - Add the section-2 invariant as a test-only hook: a non-enumerable
    `_invariant()` on the instance returning `null` or a string naming the
    first violated line. Documented in a code comment as unstable/test-only;
    excluded from d.ts and llms.txt.
  - `scripts.torture: "node --expose-gc test/torture.mjs"`; add it to
    `verify`.
  - `VERSION` const exported from Clock.js; version line added to llms.txt;
    llms.txt peer range corrected to `^1.2.2`. Three-place sync starts here
    and never breaks again.
  - Keep `10-gc.test.mjs` as fast smoke with a comment naming t6/t7 as the
    authoritative gate.

ASSERTIONS
  - `npm test` green (existing 84 + any moved tests), `npm run torture`
    prints exactly "ok", exit 0 -- with the C-xx tiers in todo, not failing.
  - t9 controls: an allocating op loop fails t6; a leaking closure fails t7.
  - summary() read only after an awaited settle tick.
  - `npm pack --dry-run` excludes test/ and includes CHANGELOG.md, llms.txt.
  - `node -e "import('...Clock.js').then(m => console.log(m.VERSION))"`
    prints 1.0.1; package.json and llms.txt agree.

NON-GOALS
  No behavior change, no fixes. Findings become visible and replayable here;
  they get fixed in K1/K2/K3.

DONE WHEN
  torture prints "ok"; controls fail; invariant hook in place; the eight
  behavioral findings registered as replayable todo reproductions;
  three-place version sync live
```

===============================================================================
# K1 -- lite-clock v1.0.2 -- drain integrity (the three S1 costumes)
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.0.2
status: shipped (2026-09-05 -- published to npm as 1.0.2)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: [C-01, C-02, C-03, C-13]
depends_on: [K0]
blocks: [K2]
---

# lite-clock -- the completion window must be atomic

PURPOSE
  Three reproduced ways to corrupt the callback drain, all silent, all live
  on npm: a nested advance() resets the queue bound and queued callbacks are
  dropped forever (C-01); growth swaps the queue buffer mid-iteration and
  the wrong callbacks fire (C-02); LIFO reuse during the drain fires a
  brand-new lane's callback at t=0 (C-03). One root cause: the drain trusts
  singly-buffered shared state across a phase that re-enters user code.

THE DECISION (record to decisions/0001-reentrancy.md BEFORE coding)
  Re-entrant `advance()`/`advanceTo()` -- from a callback, an effect, or a
  subscriber -- either:
  A. **THROWS** at the entry guard: "advance() re-entered during a tick;
     schedule follow-up advances for the next frame." Fail closed, zero
     ambiguity, one boolean check in the cold validation zone. Removes a
     documented capability -- which never worked; it silently corrupted.
  B. **DEFERS**: queue the dt, apply after the drain. Preserves the letter of
     the docs at the cost of new state, subtle ordering semantics, and an
     unbounded re-entry loop hazard.
  Recommendation: A. The README recipe patterns (chain a new lane from
  onComplete) stay legal; only nested time-advancement dies, and it was
  never coherent. Precedent: B1 in the aabb/bvh roadmap enforced documented
  boundaries with throws at patch level.

TASKS
  - Entry guard: `advancing` flag set after dt validation, cleared when the
    tick fully completes. Re-entry throws. The clear must survive a throwing
    effect (decide try/finally vs explicit; the wrap is entry/exit cold code,
    not the per-lane loop -- measure and record).
  - Drain hardening, independent of the guard (defense in depth):
      * Capture `const ids = completedIds, n = completedCount` into locals
        BEFORE `frameSig.set()` -- effects can trigger growth, and the drain
        must iterate the buffer that was filled, not the swapped one (C-02).
      * Re-check `(flags[id] & FLAG_DONE) !== 0` before firing -- a slot
        disposed-and-reallocated during propagation or drain is no longer
        DONE and must be skipped (C-03). Two loads per completed lane, on
        the completion arm only.
  - Fill torture t2 completely (every cell of the section-3 matrix named)
    and t3's callback-driven sequences.
  - Rewrite the C-13 false-confidence coverage: the "callback re-entry"
    tests must exercise advance-from-callback (throws), growth-from-callback
    (correct callbacks fire), and dispose-sibling+realloc (new tenant never
    misfires). Each named test FAILS against 1.0.1 and PASSES after -- prove
    both directions; a regression test that never failed is decoration.
  - README invariant #4 and llms.txt re-entrancy paragraph rewritten to the
    decided contract in the same commit as the code.

HOT PATH
  The per-lane compaction loop takes zero new instructions. The guard is one
  boolean write + one check in the entry/exit cold zones. The DONE re-check
  is on the completion arm (runs once per completed lane, not per lane per
  tick). `assertOps` on idle-advance and active-lanes-1k within noise of
  1.0.1 -- numbers recorded in the CHANGELOG.

ASSERTIONS
  - Every t2 matrix cell green under its decided policy.
  - The three probe shapes from section 2 pinned by name, fail-before /
    pass-after both proven.
  - t5 fuzz extended with callback-driven ops: 100K ops, zero divergence
    from the oracle, callback logs identical.
  - A dropped-callback detector in t3: after any adversarial sequence, every
    lane with `done() === true` and a registered callback has fired exactly
    once.
  - torture "ok"; t9 control (guard disabled via env flag) fails t2.

NON-GOALS
  No handle generations (K2). No config validation (K3). No new features.

DONE WHEN
  one decision record; three findings with named fail-before/pass-after
  tests; t2 matrix complete; hot path measured unchanged
```

===============================================================================
# K2 -- lite-clock v1.1.0 -- handle generations + a clock that dies honestly
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.1.0
status: implemented (pipeline complete 2026-09-05; awaiting /release 1.1.0)
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [C-04, C-06, C-08, C-12]
depends_on: [K1]
blocks: [K3]
---

# lite-clock -- a stale handle must never touch the next tenant

PURPOSE
  The docs promise disposed-handle calls are "silent no-ops". Reality: the
  free list is LIFO, the slot is reused immediately, and the stale handle
  then controls and observes an unrelated lane (C-04). Separately, a
  disposed clock keeps accepting lanes and firing callbacks while its
  reactivity is silently dead (C-06), and dispose() does not do what d.ts
  says it does (C-08). The old roadmap deferred "handle pooling with
  ABA-generation tags" pending consumer pull. The consumer-pull framing is
  dead: the generation half is a live correctness bug, today. (The pooling
  half stays deferred -- see the ledger at the bottom.)

THE DECISIONS (record to decisions/0002-handle-lifecycle.md BEFORE coding)
  1. Generation width: `Uint32Array` (4 bytes/slot; 4 KB at default
     capacity). A Uint16 wrap at 65536 disposals per slot is ~18 minutes of
     60 fps single-slot churn -- the lite-arena AR-01 lesson says do not
     leave a corruption zone in the handle space. Uint32 pushes wrap past
     2 years of continuous churn. Slot retirement (arena-style) is REJECTED
     here: an animation pool must not shrink; record why.
  2. Stale-handle policy: methods become TRUE no-ops (docs already promise
     this); tracked and peek reads return inert terminals (position 0, t 0,
     done false) WITHOUT touching the frame signal (a dead read must not
     create a live dependency). Alternative (throw on stale) rejected for
     the default: animation teardown races are routine, not exceptional --
     but revisit under a future checked mode; record the rejection.
  3. Dead-clock policy: after `dispose()`, the mutation surface fails
     closed -- `advance`, `advanceTo`, `lane`, `attachRAF`, `attachInterval`
     THROW (name the error class in the decision; likely a
     LiteClockDisposedError sibling of the capacity error). `detach()` and
     `dispose()` stay idempotent no-ops. `frame()` and reads: inert, never
     `undefined` (d.ts says number; keep it true -- return last simTime).
  4. C-08: d.ts is corrected to reality (dispose is terminal; counters
     freeze; nothing rewinds), not the code to the d.ts -- a dead clock's
     counters are inert either way and the honest sentence is shorter.

TASKS
  - `generations: Uint32Array(capacity)` in the SOA block; stamped into the
    handle at `lane()`, bumped in `disposeLane` and for every slot in
    `clockDispose`. Growth copies + zero-fills like the other arrays.
  - Every LaneHandle method and read validates
    `c._generations[id] === this._gen` first; mismatch takes the decided
    inert path. This is a hot-path change: one Uint32 load + compare per
    tracked read. Measure lane-reads-tracked with `assertOps` against 1.0.2;
    the number goes in the CHANGELOG. If it is not within noise, the read
    order (generation check before vs after the frameSig read) gets tuned
    and re-measured before acceptance.
  - `disposed` flag on the clock; the decided throw surface; d.ts + llms.txt
    + README dispose sections rewritten to match in the same commit.
  - C-12 rides along: delete the unreachable `dur <= 0` branch from `t()` /
    `tPeek()` -- with a t1 pin proving durations are always > 0 for any
    readable handle, so the deletion is safe forever.
  - Fill torture t4 completely: the full stale-handle x method matrix, the
    dead-clock x method matrix, double-dispose, growth-then-stale-read.
  - t7 extends: churn one slot 100K times, assert a handle from cycle N
    never observes cycle N+1's lane.

HOT PATH
  advance()'s per-lane loop is untouched (generations are not read there --
  activeList entries are live by construction; state why in a comment).
  The read path gains exactly one load + branch; measured, recorded.

ASSERTIONS
  - The C-04 probe shape, fail-before/pass-after: stale dispose leaves the
    tenant running; stale reads return inert values; `activeCount`
    untouched.
  - The C-06 probe shape: `lane()` on a disposed clock throws the named
    error; `advance()` throws; `frame()` returns a number always.
  - Every t4 cell green under its decided policy; no cell reads "silently
    affects another lane".
  - `assertOps` lane-reads-tracked within noise (or the tuned number
    recorded and justified in the decision file).
  - torture "ok"; t9 control (generation check disabled) fails t4.

NON-GOALS
  No handle POOLING (still deferred -- alloc-churn is measured at 26M
  cycles/s, not a bottleneck). No checked-mode flag yet. No config work.

DONE WHEN
  two lifecycle decision records; the documented no-op promise is true;
  a dead clock fails closed; read-path cost measured and recorded
```

===============================================================================
# K3 -- lite-clock v1.2.0 -- config law + the growth ceiling made true
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [C-05, C-07]
depends_on: [K2]
blocks: [K4]
---

# lite-clock -- a typo'd option must scream, and 65534 must mean 65534

PURPOSE
  `createClock({capacty: 4})` silently hands back a 1024-capacity clock.
  `lane({duration, onComplte: fn})` silently never fires the callback --
  the animation runs, the chain breaks, nothing says why. `growable: 1` is
  silently `false`. And the documented growth ceiling of 65534 is
  unreachable: doubling throws past 32768 from the default start. The suite
  law is explicit: an unknown option key is an error with a did-you-mean
  hint, never a silent ignore; fail closed on every unverified state.

TASKS
  - Known-key validation for `createClock` config (`capacity`, `growable`)
    and `lane` opts (`duration`, `onComplete`; K4 will extend the list).
    Unknown key -> TypeError naming the key and the nearest known key
    ("unknown option 'onComplte' -- did you mean 'onComplete'?"). Nearest =
    lowest edit distance over the known list; the list is 2-6 entries, so a
    hand-rolled O(n*m) distance in the cold path is fine. Zero cost after
    construction.
  - Type-strict values: `growable` must be exactly boolean when present
    (TypeError otherwise) -- the `=== true` permissiveness dies.
  - C-05: `ensureCapacity` clamps -- `newCap = min(oldCap * 2, 65534)` --
    so growth lands exactly on the ceiling instead of throwing one doubling
    short. The throw remains only when already AT 65534.
  - Pin the full t1 config cross: every bad capacity/duration/dt value with
    its error class and message fragment.
  - CHANGELOG: a loud Changed section -- code that passed junk keys now
    throws. That code was already broken silently; now it is broken loudly,
    which is the upgrade.

HOT PATH
  All of this is construction-time cold path. advance() and the read path
  diff-identical to 1.1.0 -- prove by diff, no measurement debate needed.

ASSERTIONS
  - The three C-07 probe shapes throw with did-you-mean messages.
  - Growable from default: capacity trajectory 1024 -> ... -> 32768 ->
    65534; the 65535th lane throws LiteClockCapacityError(65534); docs
    sentence "doubles up to 65534" is now literally true.
  - Growth to exactly 65534 preserves the section-2 invariant and all
    existing lanes' positions bit-for-bit.
  - torture "ok"; t9 control (validator bypassed) fails t1.

NON-GOALS
  No new options. No behavior change for valid configs.

DONE WHEN
  every documented option validated closed; the ceiling reachable and
  pinned; cold-path-only proven by diff
```

===============================================================================
# K4 -- lite-clock v1.3.0 -- the earned surface (triggers have fired)
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler"]
findings: []
depends_on: [K3]
blocks: [K5]
---

# lite-clock -- the four features every timeline consumer re-implements

PURPOSE
  The old roadmap gated these on consumer pull, and the gates have opened:
  the CHANGELOG itself promised timeScale as "easy to add in 1.1"; loop /
  ping-pong was deferred on a cost analysis this document overturns below;
  and scrubbing (seek) is the one thing every timeline consumer -- devtools,
  keyframe editors, replay UIs -- hand-rolls badly via dispose/realloc
  churn. This is the "add surface without touching an invariant" session:
  every t0 law must still hold bit-for-bit.

WHY THE LOOP COST ANALYSIS WAS WRONG (and what that unlocks)
  The old roadmap rejected loop modes because "adding a branch doubles the
  completion path's branch count... paying on the 95% who don't loop". But
  the branch lands on the COMPLETION ARM -- it runs once per completed lane
  per tick, not once per active lane per tick. The survivor path (the actual
  hot 95%) takes zero new instructions. The claim is falsifiable and the
  brief demands the measurement; if active-lanes-1k regresses beyond noise,
  the feature reverts to deferred with the number recorded.

TASKS
  - `clock.timeScale` (get/set property): finite, >= 0; 0 is a legal freeze
    (advance becomes a dt=0 tick -- propagates, completes nothing). Negative
    / NaN / Infinity throw. Applied as `dt * timeScale` AFTER validation of
    the raw dt. Determinism: timeScale is state -- same sequence of sets +
    advances replays identically (t0 law extended; snapshot in K5 must
    carry it, which is why K4 precedes K5).
  - `lane.seek(position)`: clamp to [0, duration]; sets position and
    startTime coherently; clears DONE when seeking below duration; does NOT
    fire onComplete (only advance() completes -- seek is an edit, not time).
    Requires amending law #1's wording; the amendment and its reasoning go
    to decisions/0003-seek.md. A DONE lane seeked back becomes resumable
    (paused at the seeked position; explicit start() to run).
  - `lane.restart()`: seek(0) + start() in one call, on any non-disposed
    lane. Kills the dispose/realloc churn pattern the docs currently
    recommend for replay.
  - `lane({loop: true})` / `lane({pingPong: true})` (mutually exclusive --
    both set throws per K3 law): on completion, instead of DONE, carry the
    overshoot (`startTimes[id] = simTime - (elapsed - dur)`) and stay
    active; pingPong additionally flips the REVERSE flag. Overshoot carry is
    what preserves dt-split invariance -- a naive reset-to-zero fails t0 and
    is the reason this needs the torture suite before it ships. onComplete
    fires once per completed cycle (documented).
  - `clock.stats(out?)`: fills a caller object (zero-alloc path) or
    allocates a fresh one when absent (documented as the allocating
    convenience form): poolUsed, poolFree, peakActive, totalTicks,
    totalCompletions, capacity, timeScale. Feeds lite-devtools.
  - K3's known-key lists extended (`loop`, `pingPong`); d.ts, llms.txt,
    README, CHANGELOG in the same commit.

HOT PATH
  Survivor path: zero new instructions -- prove by diff. Completion arm:
  the loop/pingPong branch, measured via completion-fanout-100 and
  active-lanes-1k against 1.2.0; both numbers in the CHANGELOG. timeScale:
  one multiply in the entry cold zone. seek/restart/stats: cold.

ASSERTIONS
  - t0 extended: dt-split invariance holds for looping and ping-pong lanes
    across cycle boundaries (the overshoot-carry law), bit-exact.
  - A pingPong lane's t() trajectory over two cycles matches the closed-form
    triangle wave exactly at every fuzzed dt partition.
  - seek: t0 identity `seek(p)` then reads == a fresh lane advanced to p
    (modulo DONE history); seek never fires callbacks; seek(duration) does
    not complete the lane, the next advance(0)... decide and pin (edge:
    seeked-to-exactly-duration -- completion requires elapsed >= duration
    via advance; a dt=0 tick after seek(duration) completes it. Pin
    whichever the implementation chooses, on the record).
  - timeScale=0.5 over 2x the dts == timeScale=1 over 1x, bit-exact.
  - stats(out) allocates nothing (t6-gated); stats() documented otherwise.
  - Fuzz oracle extended with all four features; 100K ops, zero divergence.
  - torture "ok"; t9 control (naive loop reset instead of carry) fails t0.

NON-GOALS
  No easing (lite-ease). No tween DSL. No per-lane timeScale (the 1.0
  question that deferred clock-wide timeScale is answered: clock-wide ships,
  per-lane stays on the ledger until a consumer names a use lite-ease cannot
  cover). No priorities.

DONE WHEN
  four features shipped, oracle-verified, t0-preserving; the loop cost
  measurement recorded; the seek law amendment on the record
```

===============================================================================
# K5 -- lite-clock v1.4.0 -- the determinism keystone (snapshot + fixed step)
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.4.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-rollback (design input)"]
findings: []
depends_on: [K4]
blocks: [K6]
---

# lite-clock -- make the determinism claim load-bearing

PURPOSE
  The README sells "deterministic simulation for free... the foundation
  lite-rollback will build on", and then ships nothing a rollback system can
  hold: no way to capture state, no way to restore it, and the two shipped
  drivers (attachRAF, attachInterval) feed variable real-time dt -- which is
  precisely how production apps silently lose the determinism the tests
  prove. This session closes both gaps. It is the package's reason to exist
  at A+ tier: after it, lite-clock is the only zero-GC timeline engine that
  is rollback-ready by construction, which no mainstream ticker (GSAP's,
  anime's, raf loops) offers. The old roadmap deferred snapshot on
  "lite-rollback must freeze its checkpoint format first" -- inverted
  dependency: the timeline primitive defines its state; the rollback layer
  composes primitives. Ship the primitive, minimal and versioned.

THE DECISIONS (record to decisions/0004-snapshot.md BEFORE coding)
  1. Scope of a snapshot: simTime, tickCount, timeScale, capacity, and the
     full SOA slabs (startTimes, durations, positions, flags, generations,
     activeList, activeCount, activeIndex, freeList, freeTop). NOT included:
     onComplete functions (not serializable), attach state (a driver is not
     sim state). hydrate() onto the same clock preserves the live callback
     table by id -- so a restore + re-advance REFIRES completions that had
     fired in the rolled-back timeline. That is correct rollback semantics
     and it is loud in the docs: side effects in onComplete must be
     rollback-aware or idempotent; that is the consumer's contract.
  2. Format: same-agent binary layout (a versioned SNAP_FORMAT header +
     capacity + little-endian slabs), documented as NOT a wire format --
     lite-room's cross-peer needs are a future, separate contract. Record
     the rejection of "structured object snapshot" (allocates per capture;
     rollback captures every frame).
  3. hydrate() target rules: same capacity required (throw otherwise --
     fail closed; growth mid-rollback is not a thing), clock must not be
     disposed, mid-tick hydrate illegal (K1 guard extends to it).

TASKS
  - `clock.snapshotSize(): number` -- exact byte length for this capacity.
  - `clock.snapshot(out: Uint8Array): number` -- writes into the caller's
    buffer, returns bytes written; zero allocation; throws on short buffer.
  - `clock.hydrate(buf: Uint8Array): void` -- validates header + capacity,
    restores every slab, bumps NO generations beyond what the buffer holds
    (handles minted before snapshot stay valid after hydrate -- that
    identity is the point).
  - `clock.attachFixed(stepMs, opts?)` -- rAF-driven accumulator: real
    frame time accrues; advance() is called in exact `stepMs` quanta;
    remainder carries. `opts.maxSubSteps` (default recorded in the decision)
    clamps catch-up after a tab-suspend -- excess time is DROPPED and
    counted (stats() gains droppedMs), never fed to the sim: a
    spiral-of-death guard that fails closed. Replaces the hand-rolled
    accumulator every deterministic consumer writes wrong once.
  - t0 law: `snapshot -> hydrate -> advance(seq)` bit-identical to
    `advance(seq)` uninterrupted -- fuzzed over 10K random capture points.
  - Rollback drill in t3: capture every "frame" for 600 frames, roll back
    1-60 frames at random, re-advance with the same dts, assert bit-equal
    trajectories and identical callback refire logs.
  - Cross-check the shape against `../lite-rollback` design notes if they
    exist in-tree; read, do not assume.

HOT PATH
  snapshot() is TypedArray.set() slab copies into a caller buffer -- no
  iteration in JS where a set() can do it. It will be called per-frame by
  rollback consumers: t6 gates it at zero allocation and the per-call cost
  is measured and published in the README's bench table. attachFixed's
  accumulator is entry-zone arithmetic; the inner advance loop is the
  existing advance.

ASSERTIONS
  - Round-trip bit-exactness across every t5 fuzz seed and every capture
    point; generations, freeList order, and activeList order byte-equal.
  - snapshot() into a preallocated buffer: t6 maxMajor 0 over 10K captures.
  - hydrate() wrong-capacity / short-buffer / bad-header / mid-tick all
    throw, pinned.
  - attachFixed: driving with adversarial real-time deltas (0ms, 3ms, 200ms,
    5000ms suspend) produces the same sim trajectory as manual fixed
    advance() calls, minus the documented dropped time; droppedMs exact.
  - The rollback drill passes 1000 randomized runs.
  - torture "ok"; t9 control (a snapshot that omits freeTop) fails the
    round-trip law.

NON-GOALS
  No wire format, no cross-machine guarantees, no SharedArrayBuffer, no
  worker story (ledger). No automatic rollback -- that is lite-rollback's
  job; this is its floor.

DONE WHEN
  a rollback consumer can capture/restore every frame with zero allocation
  and bit-exact replay; fixed-step driving ships; the format decision and
  its rejections are on the record
```

===============================================================================
# K6 -- lite-clock v1.4.1 -- docs to the blueprint spine
===============================================================================

```markdown
---
package: "@zakkster/lite-clock"
version_target: 1.4.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: []
findings: [C-10, C-11]
depends_on: [K5]
---

# lite-clock -- the front page catches up to the package

PURPOSE
  The README has no install command, deviates from the LiteSepforge spine,
  and quotes bench numbers with no provenance (this document measured 3x the
  README's headline on the same scenario -- both true, neither stamped).
  After K1-K5 the surface has five new capabilities and three corrected
  contracts. Reconcile once, at the end, and install a drift guard so it
  cannot quietly rot again.

WHY IT COMES LAST
  Same reason as R4 in the aabb/bvh/arena roadmap: rewriting docs before the
  surface stops moving means writing them twice. The lies that bite users
  today (re-entrancy invariant #4, "silent no-ops", growth ceiling) were
  already corrected in K1/K2/K3's own commits -- law: the doc sentence
  changes in the same commit as the behavior. K6 is structure, not triage.

TASKS
  - README restructured to the LiteSepforge blueprint spine, in order:
    title + one-line blockquote tagline; badges; positioning H2 ("The
    timeline engine the signal graph was missing" or better) with INLINE
    install command + runnable quick-start; TOC; Why this exists; What you
    get; a <details> deep-dive on the tick pipeline (the existing mermaid
    sequence survives inside it); API reference (signatures + a constants
    table: DEFAULT_CAPACITY, MAX_LANES, SNAP_FORMAT); Composability (a full
    end-to-end pipeline: statechart entry -> lane -> ease -> DOM write ->
    rollback capture, runnable); <details> Zero-GC design notes with an
    allocation table (what allocates: handle per lane(), stats() no-arg
    form; what never does: advance, reads, snapshot-into-buffer) + the
    gated numbers; Design decisions worth knowing (the decision records,
    linked); Testing (tier table incl. torture + counts by command, or
    groups if counts churn); What this is not; Ecosystem; License.
    ASCII-only throughout.
  - Bench provenance: bench.mjs prints a stamp line (package version, node
    version, platform/arch) and the README table quotes it verbatim,
    re-measured on the release commit.
  - llms.txt: full API reconciliation (timeScale, seek, restart, loop,
    pingPong, stats, snapshotSize, snapshot, hydrate, attachFixed, the
    disposed-clock throw surface, the stale-handle inert contract, the
    re-entrancy contract); version line; peer range.
  - Docs-drift guard test: every method/property on the public instance and
    LaneHandle appears in llms.txt AND in the README API reference; every
    relative link in README/llms.txt resolves; VERSION === package.json
    version === the llms.txt version line. Both directions, in CI via
    `npm test`.
  - CHANGELOG: full 1.0.1 -> 1.4.1 history verified against the git log.
  - Demo audit under the demo-audit law (separate skill; the oscilloscope
    demo is 1.5K lines of frame-loop code the GC torture cannot see):
    hot-path allocation scan, forced-reflow scan, cached selector check,
    telemetry throttle check. Fix what it finds; the demo showcases the
    new surface (timeScale slider, seek scrubber, snapshot/rollback button
    -- the demo IS the keystone pitch).
  - `files[]` audit: demo/ stays out; ROADMAP.md ships (it already does).

ASSERTIONS
  - Drift guard green in both directions; a deliberately removed llms.txt
    entry fails it (t9-style control, run once and reverted).
  - Every claim in the README that names a number carries a stamp.
  - `npm pack --dry-run`: contents exactly the documented files.
  - A cold read of README alone suffices to: install, run the quick start,
    find the re-entrancy contract, find the rollback recipe.

NON-GOALS
  No behavior change of any kind -- the diff outside docs/demo/test is
  empty.

DONE WHEN
  README/llms.txt/d.ts/code agree and a guard enforces it; provenance on
  every number; the demo demonstrates the 1.4 surface
```

---

## 6. How to run it

In order, K0 -> K6. `status: planned -> shipped` after each `/release`.
Author the brief in the package as BRIEF.md, then planner -> coder ->
reviewer -> qa, then `/release`. Reviewer REJECTED goes back to coder.
Every session ends with `node --expose-gc test/torture.mjs` printing "ok".

The budget frontmatter is identical everywhere: `maxMajor 0`, `maxPauseMs 4`,
`alloc_bytes_per_op 0`, `leak_cycles 4096`. The package has exactly one
identity -- N lanes, one signal write, zero steady-state allocation,
deterministic time -- and no number in that list ever moves.

### If you only do a subset

1. **K1 -- shipped (1.0.2, 2026-09-05, together with K0).** Three silent S1 corruptions in the completion path of a
   package that is on the registry now. The README's own recommended recipe
   ("Lane completion -> next action" chains lane() from onComplete) is one
   sibling-dispose away from C-03, and any consumer wiring a game loop where
   a completion triggers a state change that advances time hits C-01 on day
   one. K0 first regardless -- K1's DONE-WHEN needs the gate.
2. **K2 today -- the honesty session.** The stale-handle promise is printed in
   three documents and false in one probe. Everything the docs say about
   dispose is wrong somewhere.
3. **K5 is the headline.** It converts the package's marketing sentence into
   its actual moat. If the suite ever demos "rollback netcode in 30 lines,
   zero GC", this is the session that made it possible.
4. **K4 before K5, always** -- timeScale must be inside the snapshot format
   or the format breaks at its second release.
5. **K6 pays for itself** the first time another package's session reads
   llms.txt instead of hallucinating a signature.

### The habit this roadmap is built around

Every finding in section 2 came from running the code, not reading it. The
three worst (C-01, C-02, C-03) hide behind a test file whose names promise
exactly the safety they do not test -- `06-completion.test.mjs` proves
"callback can start another lane mid-drain" (true, safe subset) while the
README generalizes it to "may call ANY clock method, including advance()"
(false, corrupting). Coverage is not exercise. When the reviewer subagent
reads a test, the question is never "does this test the feature" -- it is
"would this test fail if the feature were broken". And one meta-lesson from
this document's own probe work: the first subscriber-re-entry probe returned
a false "safe" because lite-signal fires subscribe callbacks immediately at
subscribe time -- the re-entry ran before the tick, not inside it. Verify
the verifier: instrument the ordering before trusting a green probe.

---

## 7. The A+ ledger -- what is missing, named

Grading the package against what the suite's own mature packages prove
(lite-arena's harness discipline, LiteSepforge's docs spine, the pipeline
law), plus what "top tier" means for a timeline engine specifically:

| Dimension | Today | A+ bar | Closed by |
| --- | --- | --- | --- |
| Correctness under re-entrancy | 3 reproduced S1s in the completion window | full t2 matrix green, every cell a named policy | K1 |
| Handle safety | stale handles control strangers (S1) | generation-tagged, promise-true no-ops | K2 |
| Lifecycle honesty | zombie clock, d.ts fiction | fail-closed dead clock, docs = behavior | K2 |
| Config law | typos silently ignored | did-you-mean throws, type-strict | K3 |
| The gate | 256 KB hand-rolled budgets, no torture.mjs | maxMajor 0 + lite-leak + controls that can fail | K0 |
| Determinism, proven | claimed; tested only on the happy path | t0 laws bit-exact, fuzz-vs-oracle, replay drill | K0/K1/K5 |
| Determinism, usable | drivers feed wall-clock dt | attachFixed accumulator, spiral guard | K5 |
| The moat | "foundation for rollback" (prose) | zero-alloc snapshot/hydrate, rollback drill green | K5 |
| Timeline table-stakes | no timeScale/seek/loop | shipped, t0-preserving, cost-measured | K4 |
| Docs | no install cmd, unstamped numbers, off-spine | LiteSepforge spine + drift guard + provenance | K6 |
| Version hygiene | 2-place sync, llms.txt drift | 3-place, guarded | K0/K6 |
| Demo | exists, unaudited | demo-audit clean, demos the moat | K6 |

What is explicitly NOT on the A+ path, because it would dilute the identity:
easing, tween chaining, per-lane signals, promises, priorities, workers.
The uniqueness is the architecture (one signal, flat arrays, deterministic
time) -- A+ is that architecture made trustworthy (K0-K3), complete (K4),
and irreplaceable (K5), not made bigger.

---

## 8. Still deferred (the surviving ledger)

Updated from the 1.0 roadmap; each entry keeps its trigger.

- **Handle pooling** (the other half of the old "Handle pooling" item; the
  generation half became K2). Reuse LaneHandle objects across lane() calls.
  Trigger unchanged: profiling from a real consumer showing handle churn in
  the top-5 GC roots. Current measure: 26M alloc/dispose cycles/s -- not
  the bottleneck.
- **Per-lane timeScale.** Clock-wide ships in K4. Trigger: a consumer names
  a use that composing lite-ease over t() cannot express.
- **Epoch-based dependency tracking** (only re-run effects whose lanes
  changed). Unchanged: realistic only past ~100K effects+lanes; the
  bookkeeping taxes the hot loop that exists to be untaxed.
- **AbortSignal integration / onDispose hooks.** Trigger unchanged: real
  consumer cancellation patterns. Revisit after K2's lifecycle work settles
  what dispose means.
- **Wire-format snapshots** (cross-peer, lite-room). K5's format is
  same-agent by decision; a wire contract is a new negotiation.
- **Checked mode** (`{checked: true}`: stale reads throw, invariant checked
  per tick). Natural follow-on to K2; trigger: first consumer bug report
  that inert-stale-reads made harder to find, not easier.

### Deferred indefinitely (unchanged from 1.0, still right)

- **Async lane completion (promises).** Allocation per lane, microtask
  coupling. Wrap it yourself upstream.
- **Built-in easing.** lite-ease exists; `t()` is its input.
- **Per-lane signals.** The architecture's whole point is their absence.
- **Tween chaining DSL / spring physics.** A tween library composes ON this;
  it does not live IN this.
- **Multi-threading.** One clock per worker; shared-state stories belong to
  the packages that need them.

---

## How to request a roadmap item

Open an issue at the GitHub tracker. Bring the use case, the proposed API
shape, and profiling or benchmark data showing the current API is the
bottleneck. Speculative requests without a real consumer stay on this
document. Findings-style reports (a reproduction of the current API doing
the wrong thing) skip the queue -- section 2 is the precedent.

MIT (c) Zahary Shinikchiev
