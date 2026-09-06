// 18-snapshot.test.mjs
// snapshotSize / snapshot(out) / hydrate(buf) -- the versioned binary capture
// and restore surface (decisions/0004-snapshot.md, D1-D4). Guard ladders are
// pinned by error class AND message fragment. Includes the D1a fidelity-
// boundary test (a lane disposed inside the window does not refire) and the
// ghost-handle test (a handle minted after capture addresses restored state
// inertly -- observed behavior, documented not "fixed").

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createClock,
    LiteClockReentrancyError,
    LiteClockDisposedError
} from "../Clock.js";

// ---- snapshotSize -----------------------------------------------------------
test("snapshot: snapshotSize is 72 + 49*capacity", () => {
    assert.equal(createClock({ capacity: 8 }).snapshotSize(), 72 + 49 * 8);
    assert.equal(createClock({ capacity: 1024 }).snapshotSize(), 72 + 49 * 1024);
});

test("snapshot: snapshotSize tracks growth", () => {
    const c = createClock({ capacity: 2, growable: true });
    assert.equal(c.snapshotSize(), 72 + 49 * 2);
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });
    c.lane({ duration: 10 });                     // forces growth to 4
    assert.equal(c.capacity, 4);
    assert.equal(c.snapshotSize(), 72 + 49 * 4);
});

// ---- snapshot guards --------------------------------------------------------
test("snapshot: non-Uint8Array out throws TypeError", () => {
    const c = createClock({ capacity: 4 });
    assert.throws(() => c.snapshot({}),
        (e) => e instanceof TypeError && /out must be a Uint8Array/.test(e.message));
    assert.throws(() => c.snapshot(new ArrayBuffer(1000)),
        (e) => e instanceof TypeError && /out must be a Uint8Array/.test(e.message));
    assert.throws(() => c.snapshot(null),
        (e) => e instanceof TypeError && /out must be a Uint8Array/.test(e.message));
});

test("snapshot: short out throws RangeError naming both sizes", () => {
    const c = createClock({ capacity: 4 });
    const need = c.snapshotSize();
    assert.throws(() => c.snapshot(new Uint8Array(need - 1)),
        (e) => e instanceof RangeError
            && e.message.indexOf(String(need)) !== -1
            && e.message.indexOf(String(need - 1)) !== -1);
});

test("snapshot: longer out is legal and returns bytes written", () => {
    const c = createClock({ capacity: 4 });
    const need = c.snapshotSize();
    assert.equal(c.snapshot(new Uint8Array(need + 128)), need);
});

test("snapshot: throws LiteClockReentrancyError mid-tick", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    let thrown = null;
    const l = c.lane({ duration: 10, onComplete: () => {
        try { c.snapshot(buf); } catch (e) { thrown = e; }
    } });
    l.start();
    c.advance(10);
    assert.ok(thrown instanceof LiteClockReentrancyError, "mid-tick snapshot must throw");
});

test("snapshot: readable on a disposed clock (read surface)", () => {
    const c = createClock({ capacity: 4 });
    const l = c.lane({ duration: 10 }); l.start();
    c.advance(4);
    const before = new Uint8Array(c.snapshotSize());
    c.snapshot(before);
    c.dispose();
    assert.equal(c.snapshotSize(), 72 + 49 * 4);
    const after = new Uint8Array(c.snapshotSize());
    assert.equal(c.snapshot(after), 72 + 49 * 4);   // no throw
});

// ---- hydrate guards ---------------------------------------------------------
test("hydrate: non-Uint8Array buf throws TypeError", () => {
    const c = createClock({ capacity: 4 });
    assert.throws(() => c.hydrate({}),
        (e) => e instanceof TypeError && /buf must be a Uint8Array/.test(e.message));
});

test("hydrate: disposed clock throws LiteClockDisposedError (state guard first)", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    c.dispose();
    // Disposed is checked BEFORE any header validation: a garbage buffer on a
    // disposed clock still throws Disposed, never a shape error.
    assert.throws(() => c.hydrate(buf), LiteClockDisposedError);
    assert.throws(() => c.hydrate(new Uint8Array(4)), LiteClockDisposedError);
});

test("hydrate: mid-tick throws LiteClockReentrancyError", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    let thrown = null;
    const l = c.lane({ duration: 10, onComplete: () => {
        try { c.hydrate(buf); } catch (e) { thrown = e; }
    } });
    l.start();
    c.advance(10);
    assert.ok(thrown instanceof LiteClockReentrancyError, "mid-tick hydrate must throw");
});

test("hydrate: buffer under 72 bytes throws RangeError (cannot read header)", () => {
    const c = createClock({ capacity: 4 });
    assert.throws(() => c.hydrate(new Uint8Array(71)),
        (e) => e instanceof RangeError && /too small for header/.test(e.message));
});

test("hydrate: bad magic throws TypeError", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    buf[0] = buf[0] ^ 0xFF;                       // corrupt the magic
    assert.throws(() => c.hydrate(buf),
        (e) => e instanceof TypeError && /bad magic/.test(e.message));
});

test("hydrate: unsupported format throws TypeError", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    buf[4] = 99;                                  // format word (u32 at offset 4) low byte
    assert.throws(() => c.hydrate(buf),
        (e) => e instanceof TypeError && /unsupported snapshot format/.test(e.message));
});

test("hydrate: endian canary mismatch throws TypeError", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    buf[12] = buf[12] ^ 0xFF;                     // canary word (u32 at offset 12)
    assert.throws(() => c.hydrate(buf),
        (e) => e instanceof TypeError && /endian canary/.test(e.message));
});

test("hydrate: capacity mismatch throws RangeError naming both", () => {
    const a = createClock({ capacity: 4 });
    const b = createClock({ capacity: 8 });
    const buf = new Uint8Array(a.snapshotSize());
    a.snapshot(buf);
    assert.throws(() => b.hydrate(buf),
        (e) => e instanceof RangeError
            && e.message.indexOf("4") !== -1 && e.message.indexOf("8") !== -1
            && /capacity mismatch/.test(e.message));
});

test("hydrate: buffer short for its own capacity throws RangeError", () => {
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    // Truncate below snapshotSize but above the header: header parses, size fails.
    const short = buf.subarray(0, c.snapshotSize() - 1);
    assert.throws(() => c.hydrate(short),
        (e) => e instanceof RangeError && /too small/.test(e.message));
});

// ---- round-trip law ---------------------------------------------------------
test("snapshot/hydrate: round-trip then re-advance is bit-identical", () => {
    const c = createClock({ capacity: 16 });
    const a = c.lane({ duration: 10 }); a.start();
    const b = c.lane({ duration: 7, loop: true }); b.start();
    const p = c.lane({ duration: 8, pingPong: true }); p.start();
    c.advance(3.5);

    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);

    // Drive the live clock forward, capturing the "future" trajectory.
    c.advance(9);
    c.advance(4.25);
    const future = new Uint8Array(c.snapshotSize());
    c.snapshot(future);

    // Roll back, replay the SAME dts.
    c.hydrate(buf);
    c.advance(9);
    c.advance(4.25);
    const replay = new Uint8Array(c.snapshotSize());
    c.snapshot(replay);

    assert.deepEqual([...replay], [...future], "re-advance after hydrate must be bit-identical");
});

test("snapshot/hydrate: cross-clock virgin tracks the source bit-exactly", () => {
    const a = createClock({ capacity: 16 });
    const la = a.lane({ duration: 10, loop: true }); la.start();
    a.advance(23);
    const buf = new Uint8Array(a.snapshotSize());
    a.snapshot(buf);

    const b = createClock({ capacity: 16 });      // virgin, no cycling lane yet
    b.hydrate(buf);
    const bBuf = new Uint8Array(b.snapshotSize());
    b.snapshot(bBuf);
    assert.deepEqual([...bBuf], [...buf], "virgin hydrate must reproduce the source bytes");

    a.advance(11.5);
    b.advance(11.5);
    a.snapshot(buf); b.snapshot(bBuf);
    assert.deepEqual([...bBuf], [...buf], "identical ops keep the pair byte-equal");
});

test("snapshot/hydrate: handle minted before capture stays valid after hydrate", () => {
    const c = createClock({ capacity: 8 });
    const h = c.lane({ duration: 100 }); h.start();
    c.advance(30);
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    c.advance(50);                                // h now at 80
    assert.equal(h.positionPeek(), 80);
    c.hydrate(buf);
    // Generation restored byte-exact, callback table never moved: same handle.
    assert.equal(h.positionPeek(), 30, "handle addresses restored state");
    c.advance(50);
    assert.equal(h.positionPeek(), 80, "handle drives restored state on re-advance");
});

// ---- D1a: the refire fidelity boundary --------------------------------------
test("snapshot/hydrate D1a: a lane disposed inside the window does NOT refire", () => {
    // Refire fidelity holds only across windows containing no lane()/dispose().
    // Disposing a lane clears its onCompleteFns entry, which the snapshot does
    // not carry; after hydrate the slot's completion cannot refire. This is the
    // documented boundary, pinned as observed behavior.
    let fires = 0;
    const c = createClock({ capacity: 4 });
    const l = c.lane({ duration: 10, onComplete: () => { fires = fires + 1; } });
    l.start();
    c.advance(3);                                 // armed, not complete
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    l.dispose();                                  // clears onCompleteFns[id]
    c.hydrate(buf);                               // restores state, NOT the callback
    c.advance(10);                                // would complete the restored lane
    assert.equal(fires, 0, "callback cleared by the in-window dispose does not refire");
});

test("snapshot/hydrate D1a: refire DOES occur when the window has no dispose", () => {
    let fires = 0;
    const c = createClock({ capacity: 4 });
    const l = c.lane({ duration: 10, onComplete: () => { fires = fires + 1; } });
    l.start();
    c.advance(3);
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);
    c.advance(10);                               // completes: fires -> 1
    assert.equal(fires, 1);
    c.hydrate(buf);                              // roll back before completion
    c.advance(10);                              // completes again: refire
    assert.equal(fires, 2, "callback in a dispose-free window refires on replay");
});

// ---- the ghost-handle hazard (observed behavior, documented) ----------------
test("snapshot/hydrate: a handle minted after capture addresses restored state", () => {
    // A handle minted AFTER a snapshot but BEFORE hydrate is a ghost: hydrate
    // bumps no generation, so its behavior depends only on the restored
    // generation byte. Observed behavior, recorded -- NOT patched.
    const c = createClock({ capacity: 4 });
    const buf = new Uint8Array(c.snapshotSize());
    c.snapshot(buf);                             // capture the virgin clock
    const ghost = c.lane({ duration: 50 });     // minted after capture
    ghost.start();
    c.advance(20);
    assert.equal(ghost.positionPeek(), 20);
    c.hydrate(buf);                             // restore the pre-ghost state
    // The ghost's slot was free at capture: restore rewinds it to an inert
    // (unallocated, position 0) shape. The handle reads restored state inertly.
    assert.equal(ghost.positionPeek(), 0, "ghost handle addresses restored (inert) state");
});
