// test/torture/harness.mjs -- shared torture-suite helpers.
// Scratch pools, seeded PRNG, zero-alloc asserts (messages built ONLY on
// failure), gc settle, gc-profiler measurement, and the control spawner.
// No allocation inside the hot assert helpers on the success path.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GcProfiler, checkNoGc } from "@zakkster/lite-gc-profiler";

export { GcProfiler, checkNoGc };

// ---------------------------------------------------------------------------
// Seeded xorshift32 PRNG (TORTURE_SEED replays a run)
// ---------------------------------------------------------------------------

const DEFAULT_SEED = 0x9e3779b9;

export const SEED = (function () {
    const env = process.env.TORTURE_SEED;
    if (env === undefined || env === "") return DEFAULT_SEED >>> 0;
    const n = Number(env);
    return (Number.isFinite(n) && (n >>> 0) !== 0) ? (n >>> 0) : (DEFAULT_SEED >>> 0);
})();

// Returns a stateful next() producing uint32 values.
export function makeRng(seed) {
    let s = (seed >>> 0) || 1;
    return function next() {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s >>> 0;
    };
}

export function rngInt(next, n) {
    return (next() % n) >>> 0;
}

// ---------------------------------------------------------------------------
// settle -- await a macrotask tick so async GC entries land before summary()
// ---------------------------------------------------------------------------

export function settle(ms = 50) {
    return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Asserts. The failure message is only constructed when the check fails.
// ---------------------------------------------------------------------------

export class AssertionError extends Error {
    constructor(msg) { super(msg); this.name = "AssertionError"; }
}

export function assert(cond, makeMsg) {
    if (!cond) {
        throw new AssertionError(typeof makeMsg === "function" ? makeMsg() : String(makeMsg));
    }
}

export function assertEq(a, b, makeMsg) {
    if (a !== b) {
        const head = typeof makeMsg === "function" ? makeMsg() : String(makeMsg);
        throw new AssertionError(head + " -- expected === : a=" + String(a) + " b=" + String(b));
    }
}

export function assertThrows(fn, Ctor, msgFragment, makeMsg) {
    let threw = null;
    try { fn(); } catch (e) { threw = e; }
    if (threw === null) {
        const head = typeof makeMsg === "function" ? makeMsg() : String(makeMsg);
        throw new AssertionError(head + " -- expected throw, none thrown");
    }
    if (Ctor && !(threw instanceof Ctor)) {
        const head = typeof makeMsg === "function" ? makeMsg() : String(makeMsg);
        throw new AssertionError(head + " -- wrong error class: got " + (threw && threw.name) + ": " + (threw && threw.message));
    }
    if (msgFragment && String(threw.message).indexOf(msgFragment) === -1) {
        const head = typeof makeMsg === "function" ? makeMsg() : String(makeMsg);
        throw new AssertionError(head + " -- message missing '" + msgFragment + "': " + threw.message);
    }
    return threw;
}

export function assertNoThrow(fn, makeMsg) {
    try { fn(); } catch (e) {
        const head = typeof makeMsg === "function" ? makeMsg() : String(makeMsg);
        throw new AssertionError(head + " -- unexpected throw: " + (e && e.message));
    }
}

// ---------------------------------------------------------------------------
// gc-profiler measurement helpers
// ---------------------------------------------------------------------------

// Fold one heap sample. When settleAb is true, force the ArrayBuffers channel
// to a settled state (two forced collections) and pass a memoryUsage reading so
// maxArrayBuffersGrowth is checkable. NOTE: forceSettle() issues global.gc()
// -- a MAJOR collection -- so a window that settles ArrayBuffers cannot ALSO
// satisfy maxMajor: 0. The two budgets are gated in separate sequential
// measurements (see t6).
export function heapSample(gc, settleAb) {
    if (settleAb) {
        gc.forceSettle();
        const mu = process.memoryUsage();
        gc.sampleHeap(performance.now(), mu.heapUsed, mu);
    } else {
        gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
}

// Run one measured window: establish a clean old-gen baseline, start a fresh
// profiler, run fill(gc), await a settle tick, read summary(), stop. The
// pre-window collections run BEFORE start() so they are excluded by start()'s
// hard cutoff -- they clear garbage left by earlier tiers that would otherwise
// surface as an unrelated major inside this window. Exactly one measurement is
// ever in flight.
export async function measure(fill) {
    if (typeof globalThis.gc === "function") { globalThis.gc(); globalThis.gc(); }
    await settle(20);
    const gc = new GcProfiler().start();
    fill(gc);
    await settle(50);
    const s = gc.summary();
    gc.stop();
    return s;
}

// Assert a checkNoGc verdict is pass; inconclusive is a failure in the gate.
export function assertPass(summary, rules, label) {
    const report = checkNoGc(summary, rules);
    if (report.verdict !== "pass") {
        let detail = label + " -- verdict=" + report.verdict;
        if (report.reason) detail += " reason=" + report.reason;
        if (report.violations && report.violations.length > 0) {
            for (const v of report.violations) {
                detail += " | " + v.metric + " limit=" + v.limit + " actual=" + v.actual;
            }
        }
        throw new AssertionError(detail);
    }
    return report;
}

// ---------------------------------------------------------------------------
// Control spawner -- re-invoke this same entry with TORTURE_CONTROL set
// ---------------------------------------------------------------------------

const ENTRY = fileURLToPath(new URL("../torture.mjs", import.meta.url));

export function spawnControl(name) {
    const res = spawnSync(
        process.execPath,
        ["--expose-gc", ENTRY],
        {
            env: Object.assign({}, process.env, { TORTURE_CONTROL: name }),
            stdio: "pipe",
            encoding: "utf8"
        }
    );
    return {
        status: res.status,
        stdout: res.stdout || "",
        stderr: res.stderr || ""
    };
}

// ---------------------------------------------------------------------------
// todo-tier reporting: run a finding recipe, print one line, never fail.
// ---------------------------------------------------------------------------

// recipe() returns { reproduces: boolean, observed: string }.
// If the observed outcome no longer matches the finding, print the promote hint.
export function reportTodo(id, recipe) {
    let line;
    try {
        const r = recipe();
        if (r.reproduces) {
            line = "todo " + id + ": " + r.observed;
        } else {
            line = "todo " + id + ": NO LONGER REPRODUCES -- promote to gating assert (" + r.observed + ")";
        }
    } catch (e) {
        // A throw where the recipe expected a value is itself an observed
        // outcome change; surface it without failing the tier.
        line = "todo " + id + ": NO LONGER REPRODUCES -- recipe threw: " + (e && e.message);
    }
    console.log(line);
}
