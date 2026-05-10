#!/usr/bin/env node
/**
 * Resolve test files for the node-side suite and spawn `node --test` with
 * explicit paths.
 *
 * Why: package.json's previous `node --test 'electron/services/**\/*.test.js'`
 * relied on either shell glob expansion or the native --test glob support
 * that landed in Node 22. CI (GitHub Actions, Node 20) has neither — the
 * literal `**` was passed through and Node failed with "Could not find …".
 * This script does the resolution itself so the suite runs on Node 18+.
 */

"use strict";

const { readdirSync, statSync } = require("fs");
const { join, relative } = require("path");
const { spawnSync } = require("child_process");

const ROOT = join(__dirname, "..");
const SEARCH_DIRS = ["electron/services"];
const EXPLICIT_FILES = ["electron/security.test.js"];

function findTestFiles(rootRel) {
  const start = join(ROOT, rootRel);
  const out = [];
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith(".test.js")) {
        out.push(relative(ROOT, full));
      }
    }
  }
  walk(start);
  return out;
}

function main() {
  const files = [];
  for (const dir of SEARCH_DIRS) files.push(...findTestFiles(dir));
  for (const f of EXPLICIT_FILES) files.push(f);

  if (files.length === 0) {
    process.stderr.write("[test:node] no test files found\n");
    process.exit(1);
  }

  files.sort();

  const result = spawnSync(
    process.execPath,
    ["--test", ...files],
    { cwd: ROOT, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

main();
