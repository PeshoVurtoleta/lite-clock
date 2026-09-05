// test/torture.mjs -- node --expose-gc test/torture.mjs
// The authoritative memory + determinism gate for @zakkster/lite-clock.
// All ten tiers (t0-t9) gate: every finding C-01..C-08 plus C-05/C-07 is now a
// hard assertion, no todo reproductions remain. Prints exactly "ok" on success
// and exits 0; on any gating failure prints the details and exits 1. Seeded
// xorshift32 PRNG; TORTURE_SEED replays a run.

import { SEED } from "./torture/harness.mjs";

if (typeof globalThis.gc !== "function") {
    console.error("torture: global.gc is unavailable -- run with `node --expose-gc test/torture.mjs`");
    process.exit(1);
}

const control = process.env.TORTURE_CONTROL;

if (control !== undefined && control !== "") {
    // Control mode: run ONLY the named tier's broken variant and exit with its
    // status. The control functions manage their own exit code.
    if (control === "alloc") {
        const m = await import("./torture/t6-alloc.mjs");
        await m.runControlAlloc();
    } else if (control === "leak") {
        const m = await import("./torture/t7-soak.mjs");
        await m.runControlLeak();
    } else if (control === "stale") {
        const m = await import("./torture/t4-handles.mjs");
        await m.runControlStale();
    } else if (control === "config") {
        const m = await import("./torture/t1-degenerate.mjs");
        await m.runControlConfig();
    } else {
        console.error("torture: unknown TORTURE_CONTROL '" + control + "'");
        process.exit(1);
    }
    // A control that did not self-exit means it never tripped its gate.
    process.exit(0);
}

console.log("torture: seed=" + SEED + " (TORTURE_SEED=" + SEED + " to replay)");

// Gating tiers run in order; todo tiers print their C-xx lines inline.
const TIERS = [
    { name: "t0", file: "./torture/t0-laws.mjs", gating: true },
    { name: "t1", file: "./torture/t1-degenerate.mjs", gating: true },
    { name: "t2", file: "./torture/t2-reentrancy.mjs", gating: true },
    { name: "t3", file: "./torture/t3-adversarial.mjs", gating: true },
    { name: "t4", file: "./torture/t4-handles.mjs", gating: true },
    { name: "t5", file: "./torture/t5-fuzz.mjs", gating: true },
    { name: "t8", file: "./torture/t8-cross.mjs", gating: true },
    { name: "t6", file: "./torture/t6-alloc.mjs", gating: true },
    { name: "t7", file: "./torture/t7-soak.mjs", gating: true },
    { name: "t9", file: "./torture/t9-controls.mjs", gating: true }
];

let failed = false;

for (const tier of TIERS) {
    let mod;
    try {
        mod = await import(tier.file);
    } catch (e) {
        console.error(tier.name + " FAIL -- import error: " + (e && e.stack || e));
        failed = true;
        continue;
    }
    try {
        await mod.run();
        if (!tier.gating) console.log(tier.name + " todo: reproductions replayed");
    } catch (e) {
        console.error(tier.name + " FAIL -- " + (e && e.message ? e.message : String(e)));
        if (e && e.stack) console.error(e.stack);
        failed = true;
        if (tier.gating) break;   // stop at the first gating failure
    }
}

if (failed) {
    console.error("torture: GATE FAILED (seed=" + SEED + ")");
    process.exit(1);
}

console.log("ok");
process.exit(0);
