# 0004 -- snapshot/hydrate binary format and attachFixed

Status: ADOPTED (K5, v1.4.0)
Date: 2026-09-06
Findings: none (earned surface; the number was reserved at K4)

## Context

The README sells lite-clock as "the deterministic foundation lite-rollback will
build on" and yet ships no way to capture or restore sim state, and no
fixed-step driver. K5 closes both: `snapshotSize()`/`snapshot(out)`/
`hydrate(buf)` (versioned binary, zero-allocation capture) and
`attachFixed(stepMs, opts?)` (an accumulator with a fail-closed spiral-of-death
guard). After K5 lite-clock is rollback-ready by construction. K5 is add-only:
the entire existing advance surface stays byte-for-byte diff-clean.

## Decision D1 -- snapshot scope: ALL replay-observable sim state, nothing else

Scalars (7, all stored f64 -- tickCount/totalCompletions are plain numbers that
exceed u32): simTime, timeScale, tickCount, totalCompletions, peakActive,
activeCount, freeTop.

Slabs (10, full capacity length each): startTimes, baseStartTimes, durations,
positions, flags, generations, activeList, activeIndex, freeList, cycleCounts.

NOT included, each with its reason on the record:

- onCompleteFns: functions are not serializable. hydrate() preserves the LIVE
  table by id, so restore + re-advance REFIRES completions that had fired in
  the rolled-back timeline. This is correct rollback semantics, and it is LOUD
  in the docs: onComplete side effects must be rollback-aware or idempotent --
  the consumer's contract.
- attach state (RAF/interval/fixed handles, accumulator, droppedMs): a driver
  is not sim state. droppedMs is real-time observability and survives hydrate
  untouched.
- the completion queue (completedIds/completedCycles/completedGens): it is
  invariantly EMPTY outside a tick, and D4 makes snapshot/hydrate illegal
  mid-tick, so there is never queue state to capture.
- disposed flag: hydrate onto a disposed clock throws (D4); a snapshot is only
  ever taken of a live clock's state shape.

timeScale rides the snapshot -- this is WHY K4 preceded K5.

### D1a -- the refire FIDELITY BOUNDARY (ADOPTED)

Refire fidelity is exact ONLY across a rollback window that contains no
lane()/dispose(). The mechanism: disposeLane clears onCompleteFns[id] and
allocLane overwrites it, and neither bumps a generation on the callback table's
behalf beyond the disposal bump. A snapshot captures generations byte-exact, so
a handle minted BEFORE a same-clock snapshot stays valid after hydrate. But if,
within the rolled-back window, a lane was disposed and its slot reallocated to a
new tenant, the callback table now holds the NEW tenant's function while the
restored generations match the OLD tenant -- refire would call the wrong
callback or none. lite-rollback's field model is fixed-topology (its ring slots
never change lane inventory mid-window), so this boundary is a non-issue for the
intended consumer. Documented LOUD; drill and mirror windows are structurally
lane()/dispose()-free by construction.

### The ghost-handle hazard (documented, not "fixed")

A handle minted AFTER a snapshot is captured but BEFORE hydrate addresses the
restored state inertly or actively depending only on the restored generation
byte. Because hydrate bumps NOTHING, a handle whose stamped generation matches
the restored generation byte drives the restored tenant; a handle to a slot
whose generation the restore rewound will read stale. This is observed behavior,
recorded here and pinned by the 18-snapshot ghost-handle test -- generation
mechanics are NOT changed to paper over it.

## Decision D2 -- format: versioned same-agent binary; bytes, not element views

Layout (packed, no padding -- all copies are byte-level):

- header, 4 x u32 (16 B): MAGIC 0x4C43534E ("LCSN"), SNAP_FORMAT = 1,
  capacity, ENDIAN_CANARY 0x01020304;
- scalars, 7 x f64 (56 B), D1 order;
- slabs, D1 order, each capacity x elementSize bytes.

### R1 -- confirmed layout table

| region  | field            | type | bytes            |
|---------|------------------|------|------------------|
| header  | MAGIC            | u32  | 4                |
| header  | SNAP_FORMAT      | u32  | 4                |
| header  | capacity         | u32  | 4                |
| header  | ENDIAN_CANARY    | u32  | 4                |
| scalar  | simTime          | f64  | 8                |
| scalar  | timeScale        | f64  | 8                |
| scalar  | tickCount        | f64  | 8                |
| scalar  | totalCompletions | f64  | 8                |
| scalar  | peakActive       | f64  | 8                |
| scalar  | activeCount      | f64  | 8                |
| scalar  | freeTop          | f64  | 8                |
| slab 0  | startTimes       | f64  | 8 * capacity     |
| slab 1  | baseStartTimes   | f64  | 8 * capacity     |
| slab 2  | durations        | f64  | 8 * capacity     |
| slab 3  | positions        | f64  | 8 * capacity     |
| slab 4  | flags            | u8   | 1 * capacity     |
| slab 5  | generations      | u32  | 4 * capacity     |
| slab 6  | activeList       | u16  | 2 * capacity     |
| slab 7  | activeIndex      | i32  | 4 * capacity     |
| slab 8  | freeList         | u16  | 2 * capacity     |
| slab 9  | cycleCounts      | u32  | 4 * capacity     |

Header + scalars = 72 bytes. Per-lane byte cost across the ten slabs is
8+8+8+8+1+4+2+4+2+4 = 49. `snapshotSize() = 72 + 49 * capacity` -- a pure
function of the CURRENT capacity (a growable clock's growth changes it;
documented).

Mechanism (the zero-alloc claim): the clock owns (a) one persistent 72-byte
header buffer (the clock's own ArrayBuffer, aligned by construction) with
u32/f64/u8 views, filled then copied with one out.set(); (b) a cached
Uint8Array view over EVERY slab's buffer, (re)built only at cold sites
(construction, growth, materialization). snapshot(out) = fill header views, one
set() for the header, one set(slabU8, off) per present slab, one
out.fill(0, off, end) per null lazy slab (baseStartTimes/cycleCounts sections
are ZEROS when unmaterialized -- bit-identical to what materialization
produces). Zero allocation, ~12 calls total. Header scalars are written through
the persistent views in native endianness; hydrate re-reads the canary through
the same route and fails closed on mismatch.

REJECTED, on the record:

- structured-object snapshot: allocates per capture; a rollback consumer
  captures every frame, so per-frame allocation is the exact anti-pattern K5
  exists to avoid.
- Float64Array views over out.buffer: imposes an alignment contract on the
  caller that lite-rollback ring slots cannot honor (ring slots are
  arbitrary-offset subviews of one backing buffer, so an 8-byte-aligned view is
  not constructable there). Bytes are copied via cached u8 views instead.
- per-element DataView writes: defeats the memcpy that makes capture cheap.

snapshot(out): out must be a Uint8Array (TypeError otherwise);
out.byteLength < snapshotSize() throws RangeError naming both numbers; longer is
legal (ring strides may pad). Returns bytes written.

## Decision D3 -- hydrate target rules + the lazy-array trap

### R2 -- the guard ladder (state-first, matching advance())

hydrate(buf), IN ORDER, with NO mutation before all nine guards pass:

1. disposed -> LiteClockDisposedError (state first, matching advance(); a dead
   clock always answers Disposed, whatever the argument).
2. advancing (mid-tick) -> LiteClockReentrancyError (D4).
3. buf not a Uint8Array -> TypeError (shape after state).
4. byteLength < 72 -> RangeError (cannot even read the header).
5. MAGIC mismatch -> TypeError (foreign or corrupt bytes).
6. SNAP_FORMAT mismatch -> TypeError.
7. ENDIAN_CANARY mismatch -> TypeError.
8. header capacity !== clock capacity -> RangeError naming both (fail closed --
   growth mid-rollback is not a thing).
9. byteLength < snapshotSize() -> RangeError.

snapshot(out) has the two-guard prefix of the same ladder: advancing ->
LiteClockReentrancyError (no disposed guard -- snapshot is read surface), then
shape, then size.

Then restore: scalars from the header region, every slab via its cached u8 view.

The header copy-in is a view-free 72-byte loop into the persistent header buffer
(then the header views read the canary/capacity/scalars back out). The wrapper
count per hydrate is exactly 10 -- one buf.subarray per slab.

Body bytes are trusted once the header passes: a buffer with a valid header but
garbage BODY bytes restores garbage (GIGO). This is the same-agent contract --
there is no body checksum, because per-byte verification would defeat the memcpy
that makes per-frame capture cheap. It is memory-safe by construction: every
typed-array access is bounds-checked (an OOB read yields undefined, an OOB
write is a silent no-op) and the pool's index write-sites truncate. A consumer
that needs corruption detection layers lite-rollback's checksum() on top.

### THE TRAP (audit this first)

A virgin clock has FOUR null lazy arrays (baseStartTimes, cycleCounts,
completedCycles, completedGens). A hydrated state can contain allocated cycling
lanes, so the next advance/startLane/seekLane would write those arrays. hydrate
therefore MATERIALIZES all four if null, BEFORE slab restore (one-time cold
allocation; K4 proved materialized-zeros == null behaviorally), then calls
rebuildViews() so the cached table points at the freshly materialized buffers.
The queue pair (completedCycles/completedGens) is materialized even though the
queue is not in the snapshot -- the next completion writes it. K4's mode-bit
write-site guards are untouched (hydrate writes whole arrays, not per-slot).

Handle identity is the point: handles minted before a same-clock snapshot stay
valid after hydrate because generations are restored byte-exact and the callback
table never moved. hydrate bumps NOTHING.

### R4 -- wrapper policy

hydrate copy-in uses buf.subarray per slab (exactly 10 short-lived view
wrappers, minor-GC fodder only). snapshot is the per-frame call and is strictly
zero-alloc; hydrate is the restore path and its 10 wrappers are documented. A
view-free slab copy would be a 49*capacity byte loop on the drill path, which is
worse; the t6 rollback window gates BOTH capture and restore in one window at
maxMajor 0.

Legal-and-documented: hydrate with a driver attached (next driver tick advances
the restored state); hydrate as a cross-clock transfer onto a same-capacity
virgin clock (state moves, handle objects do not).

## Decision D4 -- the atomic-tick law extends to snapshot/hydrate

Both throw LiteClockReentrancyError when `advancing` is true (from an
onComplete, an effect tracking frame(), or a subscriber). Mid-tick state is
half-built (compaction in flight, queue non-empty) -- capturing it would bake a
lie into the buffer, restoring into it would corrupt the tick. snapshotSize()
and snapshot() remain READABLE on a disposed clock (read-surface law, like
stats; the frozen state is still a fact); hydrate is mutation and throws
LiteClockDisposedError -- checked BEFORE the re-entrancy guard, matching the K2
ordering law.

## Decision D5 -- attachFixed(stepMs, opts?)

The accumulator every consumer writes wrong once, with a fail-closed drop.

Validation order: disposed -> LiteClockDisposedError; stepMs must be a finite
number > 0 -> RangeError otherwise; opts under the config law:
KNOWN_FIXED_KEYS = ["maxSubSteps"], unknown key -> TypeError with the
did-you-mean hint, maxSubSteps when present must be an integer >= 1 (TypeError on
non-number shape, RangeError on bad value; the growable precedent), default 8
(~133 ms of catch-up at a 16 ms stepMs).

rAF-driven like attachRAF (throws where rAF is unavailable; tests shim it). Each
attach replaces any prior attach; detach() cancels.

### R3 -- the accumulator arithmetic

Per frame: acc += realDt; n = min(floor(acc / stepMs), maxSubSteps); call the
PUBLIC advance(stepMs) n times (sim quantum is stepMs * timeScale -- the K4
attachRAF rider extends here); then acc = acc - n * stepMs (ONE multiply, never
repeated subtraction). The substep loop breaks on disposed/!running (an
onComplete may dispose the clock mid-drain; advance() would otherwise throw out
of a rAF frame). After the capped drain, if acc >= stepMs (tab suspend) the
excess WHOLE QUANTA are dropped, never fed:
d = acc - (acc % stepMs); droppedMs += d; acc = acc % stepMs. droppedMs is exact
by this arithmetic and the tests pin it with a DYADIC stepMs (16) so the values
are bit-exact. The sub-quantum remainder ALWAYS carries (that is the determinism
point). droppedMs is a new closure number, reported by stats (D6), NOT in the
snapshot (driver state), never reset. Boundary, on the record: a frame whose
callback disposes the clock mid-drain breaks the substep loop but still runs
that frame's drop accounting once -- the increment reflects genuinely dropped
real time, and droppedMs is stable from the next frame on (fixedTick returns
at the !running check).

## Decision D6 -- stats gains droppedMs (field 8, appended)

Both the fill form and the fresh-object form gain it; docs list it last. The
only sanctioned existing-test edits this session are the 17-stats shape pins
(header comment, FIELDS array, title 7 -> 8, one added assert.equal(
s.droppedMs, 0)).

## Cross-check -- the LiteRollback contrast

LiteRollback (v1.2.1, in-tree) is the intended consumer. Its wire codec is a
hand-written little-endian layout with NO typed-array element views: it IS a wire
format, so it commits to a fixed byte order across agents. K5's snapshot is the
OPPOSITE contract by design: it is native-endian with a canary guard because it
is NOT a wire format -- same-agent restore only. A clock snapshot rides a
lite-rollback Uint8 field of length snapshotSize(); those ring slots are
arbitrary-offset subviews of one backing buffer, which is exactly why D2 forbids
Float64Array views over the caller's buffer (alignment cannot be assumed) and
copies bytes via cached u8 views instead. Cross-peer / cross-machine restore is
lite-room's future contract, not this one.
