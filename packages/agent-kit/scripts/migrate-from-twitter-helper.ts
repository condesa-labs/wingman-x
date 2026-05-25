#!/usr/bin/env tsx
import { migrateTwitterHelperKB } from "../src/migrate-core.js";

interface Args {
  source?: string;
  target?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      if (!value) throw new Error("--source requires a path");
      args.source = value;
      i += 1;
      continue;
    }
    if (arg === "--target") {
      const value = argv[i + 1];
      if (!value) throw new Error("--target requires a path");
      args.target = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await migrateTwitterHelperKB({
    sourceDir: args.source,
    targetDir: args.target,
    log: (line) => process.stdout.write(`${line}\n`),
    warn: (line) => process.stderr.write(`${line}\n`),
  });
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
  process.exitCode = 1;
});
