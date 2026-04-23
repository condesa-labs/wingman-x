#!/usr/bin/env node
/**
 * Monorepo version bumper — single source of truth.
 *
 * The root `package.json` carries the authoritative version. All
 * workspace `package.json` files are synced to it on every bump so a
 * cross-cutting change (Chrome extension + companion daemon) ships
 * with one coherent version number.
 *
 * Extension manifest (`packages/extension/src/manifest.json`) is NOT
 * written here — `copy-assets.ts` injects the current package.json
 * version into the built manifest at `dist/manifest.json` at build
 * time. That keeps the source file stable and avoids a second write
 * target that could drift.
 *
 * Usage:
 *   node scripts/bump-version.mjs patch   # 0.1.0 -> 0.1.1
 *   node scripts/bump-version.mjs minor   # 0.1.0 -> 0.2.0
 *   node scripts/bump-version.mjs major   # 0.1.0 -> 1.0.0
 *   node scripts/bump-version.mjs sync    # no bump; propagate root -> workspaces
 *
 * The script is deliberately dependency-free (Node core only) so it
 * runs in any fresh checkout without `npm install`. It is idempotent
 * on sync: running `sync` twice leaves files identical.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MODES = new Set(["patch", "minor", "major", "sync"]);
const mode = process.argv[2];

if (!MODES.has(mode)) {
  console.error(
    `usage: bump-version.mjs <patch|minor|major|sync>\n  got: ${mode ?? "(none)"}`,
  );
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "package.json",
  "packages/daemon/package.json",
  "packages/extension/package.json",
  "packages/agent-kit/package.json",
  "packages/sample-kb/package.json",
].map((p) => resolve(repoRoot, p));

/**
 * Semver bump over `major.minor.patch`. Plain semver only — no
 * pre-release suffixes. If the daemon ever wants a `-rc.1` flow, add
 * it deliberately rather than silently corrupting pre-release tags.
 */
function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match === null) {
    throw new Error(
      `unsupported version ${version} -- bumper requires plain major.minor.patch`,
    );
  }
  const [, majorStr, minorStr, patchStr] = match;
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const patch = Number(patchStr);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const rootPath = targets[0];
const rootPkg = JSON.parse(readFileSync(rootPath, "utf8"));
const nextVersion = mode === "sync"
  ? rootPkg.version
  : bumpVersion(rootPkg.version, mode);

let writes = 0;
for (const file of targets) {
  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  if (pkg.version === nextVersion) continue;
  pkg.version = nextVersion;
  // Preserve trailing newline convention (prettier + npm both emit
  // one). JSON.stringify doesn't add it, so we append explicitly.
  const out = JSON.stringify(pkg, null, 2) + "\n";
  writeFileSync(file, out, "utf8");
  writes += 1;
}

console.log(
  mode === "sync"
    ? `[bump] synced ${writes} file(s) to ${nextVersion}`
    : `[bump] ${mode}: ${rootPkg.version} -> ${nextVersion} (${writes} file(s) updated)`,
);
