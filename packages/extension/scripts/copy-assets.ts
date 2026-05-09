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
  // D2b: notification icon referenced by chrome.notifications.create iconUrl.
  { from: "notification-icon.png", to: "notification-icon.png" },
];

// Flatten popup JS paths after tsc emits them (tsc keeps the src
// directory structure; we want popup.js at the dist root). CP08
// introduces three ESM sibling modules (candidate-card, daemon-client,
// truncate) — the popup.html loads popup.js as a module, so relative
// imports must resolve to files that live next to popup.js. We flatten
// ALL .js files under dist/popup/ rather than keeping an explicit list,
// so future popup modules don't require a copy-assets patch.
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
 * Dependency order (CP07):
 *   1. parse-tweet-url   — pure helpers, no deps
 *   2. position-store    — pure helpers, no deps
 *   3. drag              — depends on position-store
 *   4. fill-reply        — pure DOM helpers, no deps
 *   5. toast             — pure DOM helpers, no deps
 *   6. widget-state      — pure state machine, no deps
 *   7. actions           — depends on fill-reply, toast, dock (circular
 *                          at module level; safe because all cross-file
 *                          calls happen at click-time, after the IIFE
 *                          has declared every symbol)
 *   8. card              — depends on drag, position-store, actions,
 *                          toast (circular w/ actions — same as dock)
 *   9. dock              — depends on drag, position-store, actions,
 *                          toast (circular w/ actions, see above)
 *  10. transitions       — depends on widget-state, dock, card,
 *                          position-store
 *  11. content-script    — depends on dock, card, parse-tweet-url,
 *                          transitions
 */
/**
 * Entry format: `<filename>.js` OR `../<filename>.js` for files that
 * live at `dist/` root rather than `dist/content/` (e.g. `daemon-shape`,
 * shared between popup and content-script). The `../` form is
 * resolved relative to `dist/content/` at read time.
 */
const CONTENT_BUNDLE_ORDER: readonly string[] = [
  "../daemon-shape.js", // shared shape guards used by content-script.ts
  "parse-tweet-url.js",
  "position-store.js",
  "drag.js",
  "fill-reply.js",
  "toast.js",
  "widget-state.js",
  "actions.js",
  "card.js",
  "dock.js",
  "transitions.js",
  "content-script.js",
];

const VIRAL_BRIDGE_BUNDLE_ORDER: readonly string[] = [
  "../daemon-shape.js",
  "../candidates-fetch.js",
  "../daemon-client.js",
  "viral-bridge.js",
];

const MAIN_WORLD_BUNDLE_ORDER: readonly string[] = [
  "viral-hook-extract.js",
  "viral-hook.js",
];

function stripModuleSyntax(src: string): string {
  return src
    .replace(/^export\s+/gm, "")
    .replace(/^import\s+[\s\S]*?;\s*$/gm, "");
}

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
    // by later files in the concat. Also strip ESM import lines —
    // the identifiers resolve at runtime from earlier files in this
    // concat. Use a multi-line regex that handles wrapped import
    // statements spanning multiple lines (tsc emits these when the
    // imported name list is long).
    const src = stripModuleSyntax(readFileSync(join(distContentDir, name), "utf8"));
    // Display name in the banner (strip any ../ prefix).
    const display = name.replace(/^\.\.\//, "");
    return `// ---- ${display} ----\n${src}`;
  });

  const sourceList = CONTENT_BUNDLE_ORDER.map((n) =>
    n.replace(/^\.\.\//, "").replace(/\.js$/, ""),
  ).join(",");
  const bundle = [
    "// Auto-generated by scripts/copy-assets.ts — do not edit.",
    `// Sources: packages/extension/src/{content/{parse-tweet-url,...,content-script},daemon-shape}.ts`,
    `// Bundle order (logical): ${sourceList}`,
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

function bundleViralBridgeScript(): void {
  const distContentDir = join(distDir, "content");
  const outPath = join(distDir, "viral-bridge.js");
  const missing = VIRAL_BRIDGE_BUNDLE_ORDER.filter(
    (name) => !existsSync(join(distContentDir, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `expected viral-bridge build artifacts under ${distContentDir} but missing: ${missing.join(", ")}`,
    );
  }

  const parts = VIRAL_BRIDGE_BUNDLE_ORDER.map((name) => {
    const src = stripModuleSyntax(readFileSync(join(distContentDir, name), "utf8"));
    const display = name.replace(/^\.\.\//, "");
    return `// ---- ${display} ----\n${src}`;
  });

  const bundle = [
    "// Auto-generated by scripts/copy-assets.ts - do not edit.",
    `// Bundle order (logical): ${VIRAL_BRIDGE_BUNDLE_ORDER.map((n) => n.replace(/^\.\.\//, "").replace(/\.js$/, "")).join(",")}`,
    "(() => {",
    ...parts,
    "})();",
    "",
  ].join("\n");

  writeFileSync(outPath, bundle, "utf8");
}

function bundleMainWorldScript(): void {
  const distContentDir = join(distDir, "content");
  const outPath = join(distDir, "viral-hook.js");
  const missing = MAIN_WORLD_BUNDLE_ORDER.filter(
    (name) => !existsSync(join(distContentDir, name)),
  );
  if (missing.length > 0) {
    throw new Error(
      `expected main-world build artifacts under ${distContentDir} but missing: ${missing.join(", ")}`,
    );
  }

  const parts = MAIN_WORLD_BUNDLE_ORDER.map((name) => {
    const src = stripModuleSyntax(readFileSync(join(distContentDir, name), "utf8"));
    return `// ---- ${name} ----\n${src}`;
  });

  const bundle = [
    "// Auto-generated by scripts/copy-assets.ts — do not edit.",
    `// Bundle order (logical): ${MAIN_WORLD_BUNDLE_ORDER.map((n) => n.replace(/\.js$/, "")).join(",")}`,
    "(() => {",
    ...parts,
    "})();",
    "",
  ].join("\n");

  writeFileSync(outPath, bundle, "utf8");
}

/**
 * Read the root `package.json` version and write it into
 * `dist/manifest.json`. Fails loudly on missing inputs so a broken
 * version setup never ships as a silently-stale manifest.
 */
function syncManifestVersion(): void {
  const rootPkgPath = resolve(pkgRoot, "..", "..", "package.json");
  const manifestPath = join(distDir, "manifest.json");
  if (!existsSync(rootPkgPath)) {
    throw new Error(`root package.json not found at ${rootPkgPath}`);
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`dist manifest.json not found at ${manifestPath}`);
  }
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8")) as {
    version?: unknown;
  };
  if (typeof rootPkg.version !== "string") {
    throw new Error(
      `root package.json has no string version field — got ${typeof rootPkg.version}`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
    string,
    unknown
  >;
  manifest.version = rootPkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console -- build-time one-shot log
  console.log(`[extension/build] manifest version -> ${rootPkg.version}`);
}

function main(): void {
  if (!existsSync(distDir)) {
    throw new Error(`dist/ does not exist — did tsc run first? ${distDir}`);
  }

  // 1) Flatten popup/* JS files to dist root, then remove the empty dir.
  //    - `FLATTEN_MAPPINGS` covers the entrypoint (popup.js + .map).
  //    - Every other .js / .js.map under dist/popup/ is copied verbatim
  //      so ESM relative imports (`./truncate.js`, `./daemon-client.js`,
  //      `./candidate-card.js`) resolve next to the entrypoint.
  //    - After flatten we rewrite `../daemon-shape.js` → `./daemon-shape.js`
  //      in the flattened popup files. The source lives at `src/` root
  //      (shared with content-script), so from `src/popup/*` it's a
  //      parent-relative import; once the popup JS is flattened to
  //      `dist/` root, the parent-relative path escapes the dist tree
  //      and breaks the runtime resolution.
  for (const m of FLATTEN_MAPPINGS) {
    const fromAbs = join(distDir, m.from);
    const toAbs = join(distDir, m.to);
    if (existsSync(fromAbs)) {
      copyFileSync(fromAbs, toAbs);
    }
  }
  const distPopupDir = join(distDir, "popup");
  if (existsSync(distPopupDir)) {
    for (const entry of readdirSync(distPopupDir)) {
      // The entrypoint is already flattened above; skip to avoid redundant copy.
      if (entry === "popup.js" || entry === "popup.js.map") continue;
      if (!entry.endsWith(".js") && !entry.endsWith(".js.map")) continue;
      copyFileSync(join(distPopupDir, entry), join(distDir, entry));
    }
    rmSync(distPopupDir, { recursive: true, force: true });
  }

  // 1b) Rewrite parent-relative imports that targeted `src/` root files
  //     (e.g. `daemon-shape.js`, `candidate-filter.js`) — after flatten
  //     those files are siblings, so the import must be current-directory
  //     relative. We generalise to any `../<name>.js` because every
  //     popup source that reaches out to `src/` root lands at `dist/`
  //     root after flatten; keeping the list explicit would require a
  //     copy-assets patch every time popup imports a new shared module.
  const PARENT_JS_IMPORT_RE =
    /from\s+"\.\.\/([A-Za-z0-9_-]+\.js)"/g;
  for (const entry of readdirSync(distDir)) {
    if (!entry.endsWith(".js")) continue;
    const abs = join(distDir, entry);
    const original = readFileSync(abs, "utf8");
    const rewritten = original.replace(PARENT_JS_IMPORT_RE, 'from "./$1"');
    if (rewritten !== original) {
      writeFileSync(abs, rewritten, "utf8");
    }
  }

  // 2) Bundle the content script (two-file source → single classic JS).
  bundleMainWorldScript();
  bundleViralBridgeScript();
  bundleContentScript();

  // 3) Copy static assets from src/ into dist/.
  for (const asset of STATIC_ASSETS) {
    copyIfExists(join(srcDir, asset.from), join(distDir, asset.to));
  }

  // 3b) Inject the root package.json version into dist/manifest.json.
  //     The source `src/manifest.json` stays pinned at 0.1.0 to avoid
  //     two competing version sources; the built artefact is what
  //     Chrome loads, so that is where the version must be current.
  //     `scripts/bump-version.mjs` is the sole writer of root
  //     package.json version, so this injection is always synced.
  syncManifestVersion();

  // 4) Report the final dist tree for operator visibility.
  const files = listJsFiles(distDir).map((f) => f.replace(pkgRoot + "/", ""));
  // eslint-disable-next-line no-console -- build-time one-shot log
  console.log(
    `[extension/build] dist ready at ${distDir.replace(pkgRoot + "/", "")}/\n  files: ${files.join(", ")}`,
  );
}

main();
