// test/torture/t9-controls.mjs -- the gate must be able to fail (GATING).
// Parent run only (torture.mjs skips this tier when TORTURE_CONTROL is set).
// Spawns each deliberately broken control as a child process and asserts a
// non-zero exit. A control that passes means its gate is decorative.

import { spawnControl, assert } from "./harness.mjs";

function tail(s, n) {
    if (!s) return "";
    const t = s.trimEnd();
    if (t.length <= n) return t;
    return t.slice(t.length - n);
}

export async function run() {
    const alloc = spawnControl("alloc");
    assert(alloc.status !== 0, function () {
        return "t9 control 'alloc' exited 0 (gate is decorative)\n"
            + "  stdout: " + tail(alloc.stdout, 400) + "\n"
            + "  stderr: " + tail(alloc.stderr, 400);
    });

    const leak = spawnControl("leak");
    assert(leak.status !== 0, function () {
        return "t9 control 'leak' exited 0 (gate is decorative)\n"
            + "  stdout: " + tail(leak.stdout, 400) + "\n"
            + "  stderr: " + tail(leak.stderr, 400);
    });

    const stale = spawnControl("stale");
    assert(stale.status !== 0, function () {
        return "t9 control 'stale' exited 0 (gate is decorative)\n"
            + "  stdout: " + tail(stale.stdout, 400) + "\n"
            + "  stderr: " + tail(stale.stderr, 400);
    });

    const config = spawnControl("config");
    assert(config.status !== 0, function () {
        return "t9 control 'config' exited 0 (gate is decorative)\n"
            + "  stdout: " + tail(config.stdout, 400) + "\n"
            + "  stderr: " + tail(config.stderr, 400);
    });

    const naiveCarry = spawnControl("naive-carry");
    assert(naiveCarry.status !== 0, function () {
        return "t9 control 'naive-carry' exited 0 (gate is decorative)\n"
            + "  stdout: " + tail(naiveCarry.stdout, 400) + "\n"
            + "  stderr: " + tail(naiveCarry.stderr, 400);
    });

    console.log("t9 controls: pass (alloc exit=" + alloc.status
        + " leak exit=" + leak.status + " stale exit=" + stale.status
        + " config exit=" + config.status + " naive-carry exit=" + naiveCarry.status + ")");
}
