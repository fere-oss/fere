#!/usr/bin/env node
/**
 * Build a Claude Desktop Extension bundle (.mcpb) for Fere's MCP server.
 *
 * Output: dist/fere.mcpb
 *
 * Layout inside the bundle (zipped):
 *   manifest.json         — DXT manifest pointing at server/index.js
 *   server/index.js       — bin/fere-mcp.js bundled with esbuild (one file,
 *                           all deps inlined — no node_modules tree needed)
 *
 * Users install by double-clicking the .mcpb in Claude Desktop, which writes
 * the MCP server entry into Claude's config and unpacks the bundle to its
 * own user-data dir. The shim still requires Fere itself to be running —
 * discovery happens via ~/.fere/mcp.lock.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PKG = require(path.join(ROOT, "package.json"));
const SHIM = path.join(ROOT, "bin", "fere-mcp.js");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "mcpb-stage");
const OUT = path.join(DIST, "fere.mcpb");

function log(msg) {
  process.stdout.write(`[mcpb] ${msg}\n`);
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function bundleShim(entry, outFile) {
  // Use the local esbuild binary to bundle the shim into a single CJS file
  // that ships inside the .mcpb. external:none — everything inlined.
  const esbuild = path.join(ROOT, "node_modules", ".bin", "esbuild");
  if (!fs.existsSync(esbuild)) {
    throw new Error(
      "esbuild not found. Run `npm install` to restore dev dependencies.",
    );
  }
  execFileSync(
    esbuild,
    [
      entry,
      "--bundle",
      "--platform=node",
      "--target=node18",
      "--format=cjs",
      `--outfile=${outFile}`,
      "--minify=false", // keep readable for debugging
      "--legal-comments=none",
    ],
    { stdio: "inherit" },
  );
}

function writeManifest(serverEntryRel) {
  const author =
    typeof PKG.author === "string"
      ? { name: PKG.author }
      : PKG.author || { name: "Fere" };
  // package.json's `homepage` is set to "./" for Create React App's public
  // path — that's not a valid URL for the DXT manifest, which only accepts
  // http(s). Fall back to the GitHub repo when the value isn't a real URL.
  const isHttpUrl = (s) =>
    typeof s === "string" && /^https?:\/\//.test(s);
  const homepage = isHttpUrl(PKG.homepage)
    ? PKG.homepage
    : "https://github.com/RahulThennarasu/fere-macOS";
  const repositoryUrl =
    PKG.repository &&
    (typeof PKG.repository === "string"
      ? isHttpUrl(PKG.repository)
        ? PKG.repository
        : null
      : isHttpUrl(PKG.repository.url)
        ? PKG.repository.url
        : null);
  const manifest = {
    dxt_version: "0.1",
    name: "fere",
    display_name: "Fere",
    version: PKG.version,
    description:
      "Live runtime context from your local Fere desktop app — services, ports, findings, routes, container logs.",
    long_description:
      "Fere watches your local development environment in real time. This extension lets Claude Desktop pull live runtime data from a running Fere app via MCP. Services, port mappings, health, findings, API routes, external API calls, and container logs become available as MCP tools. Requires the Fere desktop app to be installed and running on the same machine — discovery is via ~/.fere/mcp.lock.",
    author,
    homepage,
    ...(repositoryUrl ? { repository: { type: "git", url: repositoryUrl } } : {}),
    license: PKG.license || "MIT",
    keywords: ["mcp", "fere", "runtime", "observability", "local-dev"],
    server: {
      type: "node",
      entry_point: serverEntryRel,
      mcp_config: {
        command: "node",
        args: ["${__dirname}/" + serverEntryRel],
      },
    },
    compatibility: {
      claude_desktop: ">=0.10.0",
      platforms: ["darwin"],
      runtimes: { node: ">=18" },
    },
  };
  return manifest;
}

function zipDir(srcDir, outFile) {
  // -X strips macOS-extra metadata; -r recursive; quiet by default to keep
  // build output focused.
  rmrf(outFile);
  const result = spawnSync(
    "zip",
    ["-rqX", outFile, "."],
    { cwd: srcDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `zip exited with status ${result.status}. Is the system zip available?`,
    );
  }
}

function fileSizeKB(file) {
  return Math.round(fs.statSync(file).size / 1024);
}

function main() {
  if (!fs.existsSync(SHIM)) {
    throw new Error(`shim not found: ${SHIM}`);
  }

  log(`building fere.mcpb v${PKG.version}`);

  rmrf(STAGE);
  fs.mkdirSync(path.join(STAGE, "server"), { recursive: true });
  fs.mkdirSync(DIST, { recursive: true });

  const serverEntryRel = "server/index.js";
  const serverEntryAbs = path.join(STAGE, serverEntryRel);

  log("bundling shim with esbuild");
  bundleShim(SHIM, serverEntryAbs);

  log("writing manifest.json");
  fs.writeFileSync(
    path.join(STAGE, "manifest.json"),
    JSON.stringify(writeManifest(serverEntryRel), null, 2) + "\n",
  );

  log("packing .mcpb");
  zipDir(STAGE, OUT);

  rmrf(STAGE);

  log(`done → ${path.relative(ROOT, OUT)} (${fileSizeKB(OUT)} KB)`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`[mcpb] error: ${err.message}\n`);
  process.exit(1);
}
