// 12-version-sync.test.mjs
// Permanent enforcement of the three-place version sync K0 established:
// Clock.js VERSION === package.json "version" === llms.txt's "Version:" line.
// Also pins the _invariant() test hook's contract: non-enumerable, a
// function, null on a fresh clock and after churn -- so a future refactor
// cannot silently widen the public surface or break slot conservation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClock, VERSION } from "../Clock.js";

const PKG_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const LLMS_PATH = fileURLToPath(new URL("../llms.txt", import.meta.url));

function readPackageVersion() {
    const raw = readFileSync(PKG_PATH, "utf8");
    const pkg = JSON.parse(raw);
    return pkg.version;
}

function readLlmsVersion() {
    const raw = readFileSync(LLMS_PATH, "utf8");
    const match = raw.match(/^Version:\s*(\S+)\s*$/m);
    assert.ok(match, "llms.txt must contain a 'Version: x.y.z' line");
    return match[1];
}

test("version-sync: Clock.js VERSION matches package.json version", () => {
    assert.equal(VERSION, readPackageVersion());
});

test("version-sync: Clock.js VERSION matches llms.txt Version line", () => {
    assert.equal(VERSION, readLlmsVersion());
});

test("version-sync: package.json version matches llms.txt Version line", () => {
    assert.equal(readPackageVersion(), readLlmsVersion());
});

test("version-sync: VERSION is a non-empty semver-shaped string", () => {
    assert.equal(typeof VERSION, "string");
    assert.ok(VERSION.length > 0);
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("_invariant: exists, is a function, and is not enumerable", () => {
    const c = createClock();
    assert.equal(typeof c._invariant, "function");
    assert.ok(!Object.keys(c).includes("_invariant"));
    assert.ok(!Object.prototype.propertyIsEnumerable.call(c, "_invariant"));
});

test("_invariant: returns null on a fresh clock", () => {
    const c = createClock();
    assert.equal(c._invariant(), null);
});

test("_invariant: returns null after a churn of mixed lane operations", () => {
    const c = createClock({ capacity: 32 });
    const lanes = [];
    let step = 0;

    while (step < 100) {
        const op = step % 5;
        if (op === 0) {
            const l = c.lane({ duration: 10 + (step % 7) });
            lanes.push(l);
        } else if (op === 1 && lanes.length > 0) {
            lanes[lanes.length - 1].start();
        } else if (op === 2) {
            c.advance(1.5);
        } else if (op === 3 && lanes.length > 0) {
            const l = lanes.pop();
            l.dispose();
        } else if (op === 4 && lanes.length > 0) {
            lanes[0].reverse();
        }
        assert.equal(c._invariant(), null, "invariant violated at step " + step);
        step = step + 1;
    }

    for (const l of lanes) l.dispose();
    assert.equal(c._invariant(), null);
});
