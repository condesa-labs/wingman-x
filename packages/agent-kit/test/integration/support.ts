import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect } from "vitest";
import type { KBLoader } from "../../src/kb-loader.js";

const originalStateDir = process.env.WINGMAN_X_STATE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.WINGMAN_X_STATE_DIR;
  } else {
    process.env.WINGMAN_X_STATE_DIR = originalStateDir;
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

export function createIsolatedStateDir(prefix: string): string {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(stateDir);
  process.env.WINGMAN_X_STATE_DIR = stateDir;
  return stateDir;
}

export function copyIntegrationFixture(name: string, destination: string): void {
  cpSync(resolve("test/integration/fixtures", name), destination, {
    recursive: true,
  });
}

export function writeWingmanConfig(stateDir: string, value: unknown): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "config.json"),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

export function expectCacheDirUnderState(
  loader: KBLoader,
  stateDir: string,
  adapterName: string,
): string {
  const expectedCacheDir = join(stateDir, "cache", adapterName);
  expect(process.env.WINGMAN_X_STATE_DIR).toBe(stateDir);
  expect(loader.status().cacheDir).toBe(expectedCacheDir);
  return expectedCacheDir;
}
