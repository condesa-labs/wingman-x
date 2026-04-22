/**
 * Copies static assets (manifest + popup HTML/CSS) from `src/` into
 * `dist/` after `tsc` emits the compiled JS. Mirrors the "tsc + manual
 * copy" approach chosen for CP03 per context.md.
 *
 * We keep this file outside `src/` so it does not participate in the
 * extension build itself — it's a one-shot build-time helper run via
 * `tsx`.
 */
import {
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  // CP05: content-script stylesheet, referenced by manifest.content_scripts[].css
  { from: "content/content.css", to: "content.css" },
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

/**
 * Bundle the multi-file content script into a single classic JS file.
 *
 * MV3 content scripts declared in `manifest.content_scripts[].js` run as
 * classic scripts by default. ESM `import` / `export` statements are NOT
 * supported in classic-script execution, so tsc's per-file output under
 * `dist/content/*.js` cannot be listed directly in the manifest.
 *
 * The `content_scripts[].type: "module"` option exists (Chrome 112+) but
 * has rougher ergonomics than bundling and is unnecessary for a handful
 * of files. We concat them in dependency order and strip `import` /
 * `export` tokens, producing a single classic script that runs
 * identically to the module-form version.
 *
 * Dependency order (CP06):
 *   1. parse-tweet-url   — pure helpers, no deps
 *   2. position-store    — pure helpers, no deps
 *   3. drag              — depends on position-store
 *   4. fill-reply        — pure DOM helpers, no deps
 *   5. toast             — pure DOM helpers, no deps
 *   6. actions           — depends on fill-reply, toast, dock (circular
 *                          at module level; safe because all cross-file
 *                          calls happen at click-time, after the IIFE
 *                          has declared every symbol)
 *   7. dock              — depends on drag, position-store, actions,
 *                          toast (circular w/ actions, see above)
 *   8. content-script    — depends on dock + parse-tweet-url
 */
const CONTENT_BUNDLE_ORDER: readonly string[] = [
  "parse-tweet-url.js",
  "position-store.js",
  "drag.js",
  "fill-reply.js",
  "toast.js",
  "actions.js",
  "dock.js",
  "content-script.js",
];

function bundleContentScript(): void {
  const distContentDir = join(distDir, "content");
  const outPath = join(distDir, "content.js");

  const missing = CONTENT_BUNDLE_ORDER.filter(
    (name) => !existsSync(join(distContentDir, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `expected content-script build artifacts under ${distContentDir} but missing: ${missing.join(", ")}`,
    );
  }

  const parts = CONTENT_BUNDLE_ORDER.map((name) => {
    // Strip `export ` prefixes so top-level function / const /
    // interface declarations become plain top-level identifiers usable
    // by later files in the concat.
    const src = readFileSync(join(distContentDir, name), "utf8")
      .replace(/^export\s+/gm, "")
      // Strip any ESM `import ... from "./foo.js";` lines — the
      // identifiers resolve at runtime from earlier files in this
      // concat.
      .replace(/^import\s+[^;]+;\s*$/gm, "");
    return `// ---- ${name} ----\n${src}`;
  });

  const bundle = [
    "// Auto-generated by scripts/copy-assets.ts — do not edit.",
    `// Source: packages/extension/src/content/{${CONTENT_BUNDLE_ORDER.map((n) => n.replace(/\.js$/, "")).join(",")}}.ts`,
    "(() => {",
    ...parts,
    "})();",
    "",
  ].join("\n");

  writeFileSync(outPath, bundle, "utf8");

  // Remove the dist/content/ subtree — its contents are now inlined in
  // dist/content.js, which is what the manifest references.
  rmSync(distContentDir, { recursive: true, force: true });
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

  // 2) Bundle the content script (two-file source → single classic JS).
  bundleContentScript();

  // 3) Copy static assets from src/ into dist/.
  for (const asset of STATIC_ASSETS) {
    copyIfExists(join(srcDir, asset.from), join(distDir, asset.to));
  }

  // 4) Report the final dist tree for operator visibility.
  const files = listJsFiles(distDir).map((f) => f.replace(pkgRoot + "/", ""));
  // eslint-disable-next-line no-console -- build-time one-shot log
  console.log(
    `[extension/build] dist ready at ${distDir.replace(pkgRoot + "/", "")}/\n  files: ${files.join(", ")}`,
  );
}

main();
