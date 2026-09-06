// test/20-docs-drift.test.mjs
//
// Docs-drift guard: the README and llms.txt must agree with the LIVE surface,
// in BOTH directions, and stay agreeing as the code moves. Enumeration is
// REFLECTIVE -- names are read from a real createClock() instance, a real lane
// handle, and the module's named exports, never from a hardcoded list (a
// hardcoded list rots exactly like the docs it is supposed to police).
//
// Node-safe: createClock + lane() need no rAF. The clock is disposed as soon
// as its surface is enumerated (the names are plain strings from then on).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import * as mod from "../Clock.js";

// ---------------------------------------------------------------------------
// Repo root + doc sources
// ---------------------------------------------------------------------------

const rootUrl = new URL("../", import.meta.url);
const rootDir = fileURLToPath(rootUrl);

const README = readFileSync(new URL("README.md", rootUrl), "utf8");
const LLMS = readFileSync(new URL("llms.txt", rootUrl), "utf8");
const PKG = JSON.parse(readFileSync(new URL("package.json", rootUrl), "utf8"));

// ---------------------------------------------------------------------------
// Reflective live surface
// ---------------------------------------------------------------------------

const clock = mod.createClock();
const lane = clock.lane({ duration: 100 });

// Instance public keys: own enumerable, minus the private `_`-prefixed hooks
// (the LaneHandle wiring closures are enumerable own keys; `_invariant` is
// non-enumerable and drops out by construction).
const instanceKeys = Object.keys(clock).filter((k) => k[0] !== "_");

// Lane members live on the prototype, not as own keys.
const laneNames = Object.getOwnPropertyNames(Object.getPrototypeOf(lane)).filter(
    (k) => k !== "constructor" && k[0] !== "_"
);

// Module exports. The name-coverage tests police the callable API surface
// (the factory + the error classes); VERSION is a string-valued metadata
// export and is policed by the three-place version test below, not by member
// coverage -- so exclude it reflectively by value type, never by name.
const exportFns = Object.keys(mod).filter((k) => typeof mod[k] === "function");

// Names every doc must mention somewhere.
const surfaceNames = [...new Set([...instanceKeys, ...laneNames, ...exportFns])];

// Live token sets for the docs -> surface direction.
const memberSet = new Set([...instanceKeys, ...laneNames]);
const exportSet = new Set(exportFns);

clock.dispose();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wordPresent(haystack, name) {
    return new RegExp("\\b" + name + "\\b").test(haystack);
}

// README API-reference block: text from the `## API reference` heading up to
// the next `## ` heading.
function apiSection(md) {
    const lines = md.split("\n");
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^## API reference\s*$/.test(lines[i])) {
            start = i;
            break;
        }
    }
    assert.notEqual(start, -1, "README must have a `## API reference` heading");
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^## /.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines.slice(start, end).join("\n");
}

// Strip backticks, a leading `clock.`/`lane.` qualifier, and any signature or
// type tail; return the leading identifier or "".
function memberToken(part) {
    let s = part.trim().replace(/`/g, "").trim();
    s = s.replace(/^(clock|lane)\./, "");
    const m = s.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    return m ? m[0] : "";
}

// ---------------------------------------------------------------------------
// 1. surface -> README (API-reference section)
// ---------------------------------------------------------------------------

test("every live public name appears in the README API reference", () => {
    const api = apiSection(README);
    for (const name of surfaceNames) {
        assert.ok(
            wordPresent(api, name),
            "README API reference is missing live member: " + name
        );
    }
});

// ---------------------------------------------------------------------------
// 2. surface -> llms.txt (whole file)
// ---------------------------------------------------------------------------

test("every live public name appears in llms.txt", () => {
    for (const name of surfaceNames) {
        assert.ok(
            wordPresent(LLMS, name),
            "llms.txt is missing live member: " + name
        );
    }
});

// ---------------------------------------------------------------------------
// 3. README docs -> surface
// ---------------------------------------------------------------------------

test("every clock./lane. and error heading in the README API maps to the live surface", () => {
    const api = apiSection(README);
    for (const raw of api.split("\n")) {
        const line = raw.trim();
        if (!/^### /.test(line)) continue;
        const heading = line.replace(/^### /, "").replace(/`/g, "").trim();

        if (/^(clock|lane)\./.test(heading)) {
            for (const part of heading.split("/")) {
                const tok = memberToken(part);
                if (!tok) continue;
                assert.ok(
                    memberSet.has(tok),
                    "README documents a non-existent member: " + tok
                );
            }
        } else {
            const err = heading.match(/^LiteClock[A-Za-z]*Error/);
            if (err) {
                assert.ok(
                    exportSet.has(err[0]),
                    "README documents a non-existent export: " + err[0]
                );
            }
        }
    }
});

// ---------------------------------------------------------------------------
// 4. llms.txt docs -> surface
// ---------------------------------------------------------------------------

test("every clock./lane. heading in llms.txt maps to the live surface", () => {
    for (const raw of LLMS.split("\n")) {
        const line = raw.trim();
        if (!/^### `?(clock|lane)\./.test(line)) continue;
        const heading = line.replace(/^### /, "").replace(/`/g, "").trim();
        for (const part of heading.split("/")) {
            const tok = memberToken(part);
            if (!tok) continue;
            assert.ok(
                memberSet.has(tok),
                "llms.txt documents a non-existent member: " + tok
            );
        }
    }
});

// ---------------------------------------------------------------------------
// 5. three-place version equality
// ---------------------------------------------------------------------------

test("VERSION, package.json, and the llms.txt version line agree", () => {
    const m = LLMS.match(/^Version:\s*(\S+)/m);
    assert.ok(m, "llms.txt must carry a `Version: X` line");
    assert.equal(typeof mod.VERSION, "string");
    assert.equal(mod.VERSION, PKG.version, "VERSION vs package.json version");
    assert.equal(m[1], PKG.version, "llms.txt version vs package.json version");
});

// ---------------------------------------------------------------------------
// 6. every relative link in README + llms.txt resolves on disk
// ---------------------------------------------------------------------------

test("every relative link in README and llms.txt resolves to a real file", () => {
    const targets = [];
    const collect = (text) => {
        for (const m of text.matchAll(/\]\(([^)]+)\)/g)) targets.push(m[1]);
        for (const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm)) targets.push(m[1]);
    };
    collect(README);
    collect(LLMS);

    for (const raw of targets) {
        if (/^(https?:|#|mailto:)/.test(raw)) continue;
        const target = raw.split("#")[0];
        if (!target) continue;
        const abs = resolve(rootDir, target);
        assert.ok(existsSync(abs), "unresolved relative link: " + raw);
    }
});
