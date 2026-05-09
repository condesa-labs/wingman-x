#!/usr/bin/env tsx
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  buildLibraryMarkdown,
  collectMarkdownNotes,
  countMarkdownWords,
  TOPIC_FILENAMES,
  writeLibraryMarkdown,
  type Topic,
} from "../src/kb-seed-core.js";

const DEFAULT_VAULT = "~/dev/ObsidianCentral";
const DEFAULT_OUT = "packages/sample-kb/library";
const TOPICS: readonly Topic[] = ["ai", "investing", "productivity"];

interface Args {
  vault: string;
  out: string;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    vault: DEFAULT_VAULT,
    out: DEFAULT_OUT,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--vault") {
      const value = argv[i + 1];
      if (!value) throw new Error("--vault requires a path");
      args.vault = value;
      i += 1;
      continue;
    }
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new Error("--out requires a path");
      args.out = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return {
    vault: expandPath(args.vault),
    out: resolve(expandPath(args.out)),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const notes = await collectMarkdownNotes(args.vault, {
    log: (line) => process.stdout.write(`${line}\n`),
  });
  const markdown = buildLibraryMarkdown(notes);
  await writeLibraryMarkdown(args.out, markdown);

  for (const topic of TOPICS) {
    const words = countMarkdownWords(markdown[topic]);
    process.stdout.write(
      JSON.stringify({
        event: "kb_seed_written",
        topic,
        file: TOPIC_FILENAMES[topic],
        words,
      }),
    );
    process.stdout.write("\n");
  }
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message ?? String(err)}\n`);
  process.exitCode = 1;
});
