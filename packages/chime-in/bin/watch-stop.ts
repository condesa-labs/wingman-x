#!/usr/bin/env tsx
/** `npm run watch:stop` — stop the background watcher started by `npm run scan` or `npm run watch`. */
import "../../../scripts/load-env.mjs";
import { loadConfig } from "../src/config.js";
import { chimePaths } from "../src/paths.js";
import { stopWatcher } from "../src/cli/watcher-process.js";

const paths = chimePaths(loadConfig().chimeDir);
const r = stopWatcher(paths);
if (r.stopped) process.stdout.write(`watcher (pid ${r.pid}) stopped\n`);
else if (r.pid !== null) process.stdout.write(`could not signal watcher pid ${r.pid}\n`);
else process.stdout.write("no watcher running\n");
