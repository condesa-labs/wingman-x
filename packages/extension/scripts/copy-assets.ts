/**
 * Copies static assets (manifest + popup HTML/CSS) from `src/` into
 * `dist/` after `tsc` emits the compiled JS. Mirrors the "tsc + manual
 * copy" approach chosen for CP03 per context.md.
 *
 * We keep this file outside `src/` so it does not participate in the
 * extension build itself — it's a one-shot build-time helper run via
 * `tsx`.
 */
import { readdirSync, statSync, mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, "..");
const srcDir = join(pkgRoot, "src");
const distDir = join(pkgRoot, "dist");

/**
 * Files to copy verbatim from `src/` to `dist/`. We flatten everything
 * to the root of `dist/` because the MV3 manifest references background
 * / popup as top-level paths (see manifest.json).
 */
const STATIC_ASSETS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "manifest.json", to: "manifest.json" },
  { from: "popup/popup.html", to: "popup.html" },
  { from: "popup/popup.css", to: "popup.css" },
];

// Flatten popup JS paths after tsc emits them (tsc keeps the src
// directory structure; we want popup.js at the dist root).
const FLATTEN_MAPPINGS: ReadonlyArray<{ from: string; to: string }> = [
  { from: "popup/popup.js", to: "popup.js" },
  { from: "popup/popup.js.map", to: "popup.js.map" },
];

function ensureDir(p: string): void {
  mkdirSync(p, { recursive: true });
}

function copyIfExists(fromAbs: string, toAbs: string): void {
  if (!existsSync(fromAbs)) {
    throw new Error(`expected build artifact at ${fromAbs}`);
  }
  ensureDir(dirname(toAbs));
  copyFileSync(fromAbs, toAbs);
}

function listJsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const results: string[] = [];
  for (const e of entries) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) {
      results.push(...listJsFiles(full));
    } else if (e.endsWith(".js") || e.endsWith(".js.map")) {
      results.push(full);
    }
  }
  return results;
}

function main(): void {
  if (!existsSync(distDir)) {
    throw new Error(`dist/ does not exist — did tsc run first? ${distDir}`);
  }

  // 1) Flatten popup/* JS files to dist root, then remove the empty dir.
  for (const m of FLATTEN_MAPPINGS) {
    const fromAbs = join(distDir, m.from);
    const toAbs = join(distDir, m.to);
    if (existsSync(fromAbs)) {
      copyFileSync(fromAbs, toAbs);
    }
  }
  // Remove the now-redundant popup/ directory from dist (if tsc emitted one).
  const distPopupDir = join(distDir, "popup");
  if (existsSync(distPopupDir)) {
    rmSync(distPopupDir, { recursive: true, force: true });
  }

  // 2) Copy static assets from src/ into dist/.
  for (const asset of STATIC_ASSETS) {
    copyIfExists(join(srcDir, asset.from), join(distDir, asset.to));
  }

  // 3) Report the final dist tree for operator visibility.
  const files = listJsFiles(distDir).map((f) => f.replace(pkgRoot + "/", ""));
  // eslint-disable-next-line no-console -- build-time one-shot log
  console.log(
    `[extension/build] dist ready at ${distDir.replace(pkgRoot + "/", "")}/\n  files: ${files.join(", ")}`,
  );
}

main();
