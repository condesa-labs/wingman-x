// Shared env loader. Entry points (daemon bin/dev.ts, agent-kit scripts/*.ts)
// import this module as their first side-effectful import so process.env is
// populated from the repo's .env files before any other code reads it.
//
// Hierarchy (highest priority wins):
//   1. Real process env (CI, shell overrides)
//   2. <repoRoot>/.env.local  (personal secondary overrides)
//   3. <repoRoot>/.env        (personal primary config)
//
// dotenv.config() does NOT overwrite already-set variables, so loading
// .env.local first lets it shadow .env, and both defer to real env.

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);

for (const file of [".env.local", ".env"]) {
  const path = join(repoRoot, file);
  if (existsSync(path)) config({ path });
}

const chromeProfileDir = process.env.CHROME_PROFILE_DIR;
if (chromeProfileDir) {
  process.env.CHROME_PROFILE_DIR = chromeProfileDir
    .replace(/^\$HOME(?=\/|$)/, homedir())
    .replace(/^~(?=\/|$)/, homedir());
}
