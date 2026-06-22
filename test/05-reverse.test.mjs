// 05-reverse.test.mjs
// Reverse mode: position() and t() report inverted progress; internal elapsed
// time tracking is unchanged. Completion semantics follow the underlying
// forward elapsed (lane completes when elapsed >= duration, regardless of
// reverse flag).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createClock } from "../Clock.js";

test("reverse: flips position reporting (duration - elapsed)", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(30);
    assert.equal(l.positionPeek(), 30);
    l.reverse();
    assert.equal(l.positionPeek(), 70);
});

test("reverse: flips t() (1 - ratio)", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(40);
    assert.equal(l.tPeek(), 0.4);
    l.reverse();
    assert.equal(l.tPeek(), 0.6);
});

test("reverse: toggles on each call", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(30);
    l.reverse();
    assert.equal(l.tPeek(), 0.7);
    l.reverse();
    assert.equal(l.tPeek(), 0.3);
    l.reverse();
    assert.equal(l.tPeek(), 0.7);
});

test("reverse: lane completion uses forward elapsed, not reverse-reported t", () => {
    // The underlying engine advances elapsed forward regardless of the reverse
    // flag. The lane completes when elapsed >= duration. Reverse only affects
    // what position()/t() report to readers.
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.reverse();   // pre-mark reversed
    l.start();
    c.advance(50);
    assert.equal(l.donePeek(), false);
    assert.equal(l.tPeek(), 0.5);     // 1 - 0.5 = 0.5
    c.advance(50);
    assert.equal(l.donePeek(), true);
    assert.equal(l.tPeek(), 0);       // 1 - 1 = 0 (lane "rewound to start")
    assert.equal(l.positionPeek(), 0);
});

test("reverse: pre-start reverse persists through start", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.reverse();
    l.start();
    c.advance(25);
    assert.equal(l.tPeek(), 0.75);    // 1 - 0.25
});

test("reverse: combined with pause/resume", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.start();
    c.advance(30);
    l.pause();
    l.reverse();
    assert.equal(l.tPeek(), 0.7);
    l.start();
    c.advance(20);
    // elapsed is now 50, reversed t = 1 - 0.5 = 0.5
    assert.equal(l.tPeek(), 0.5);
});

test("reverse: on a disposed lane is a silent no-op", () => {
    const c = createClock();
    const l = c.lane({ duration: 100 });
    l.dispose();
    l.reverse();  // no throw
});
