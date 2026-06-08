import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseHandles } from "@wingman-x/kb-contract";
import { afterEach, describe, expect, it } from "vitest";
import { migrateTwitterHelperKB } from "../src/migrate-core.js";

const fixtureRoot = resolve("test/fixtures/twitter-helper-kb");
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function copyFixture(name: string): string {
  const root = makeTempRoot(`migrate-${name}-`);
  const source = join(root, basename(name));
  cpSync(join(fixtureRoot, name), source, {
    recursive: true,
    preserveTimestamps: true,
  });
  return source;
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};

  function visit(dir: string, prefix = ""): void {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        snapshot[relativePath] = readFileSync(fullPath).toString("base64");
      }
    }
  }

  visit(root);
  return snapshot;
}

function readUtf8(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("migrateTwitterHelperKB", () => {
  it("migrates tone, library frontmatter, and legacy selected handles without changing the source", async () => {
    const source = copyFixture("with-handles");
    const target = join(makeTempRoot("migrate-target-"), "kb");
    const beforeSource = snapshotTree(source);
    const logs: string[] = [];
    const warnings: string[] = [];
    const principlesPath = join(source, "library", "principles.md");
    const principlesMtimeIso = statSync(principlesPath).mtime.toISOString();

    const result = await migrateTwitterHelperKB({
      sourceDir: source,
      targetDir: target,
      log: (line) => logs.push(line),
      warn: (line) => warnings.push(line),
    });

    expect(result).toMatchObject({
      status: "migrated",
      sourceDir: source,
      targetDir: target,
      libraryFiles: 2,
    });
    expect(warnings).toEqual([]);
    expect(logs.some((line) => line.includes("migration complete"))).toBe(true);

    expect(readFileSync(join(target, "tone.md"))).toEqual(
      readFileSync(join(source, "tone.md")),
    );
    expect(readUtf8(join(target, "library", "principles.md"))).toBe(
      [
        "---",
        "tags: []",
        'summary: ""',
        `updated_at: ${principlesMtimeIso}`,
        'source_note: ""',
        "---",
        "# Principles",
        "",
        "Prefer concrete claims over vague enthusiasm.",
        "",
      ].join("\n"),
    );
    expect(readUtf8(join(target, "library", "reply craft.md"))).toContain(
      "# Reply Craft",
    );

    expect(parseHandles(readUtf8(join(target, "handles.md")), "test")).toEqual({
      tiers: [
        {
          tier: 1,
          label: "Core handles",
          policy: "every-run",
          handles: [{ handle: "sama" }, { handle: "karpathy" }],
        },
        {
          tier: 2,
          label: "Rotation handles",
          policy: "sampled",
          handles: [{ handle: "nearcyan" }],
        },
        {
          tier: 3,
          label: "Manual handles",
          policy: "manual",
          handles: [{ handle: "manual_pick" }],
        },
      ],
    });
    expect(snapshotTree(source)).toEqual(beforeSource);
  });

  it("creates an empty handles.md and warns when selected-handles.txt is missing", async () => {
    const source = copyFixture("without-handles");
    const target = join(makeTempRoot("migrate-target-"), "kb");
    const warnings: string[] = [];

    await migrateTwitterHelperKB({
      sourceDir: source,
      targetDir: target,
      warn: (line) => warnings.push(line),
    });

    const handlesMarkdown = readUtf8(join(target, "handles.md"));
    expect(parseHandles(handlesMarkdown, "test")).toEqual({ tiers: [] });
    expect(warnings.join("\n")).toContain("selected-handles.txt");
  });

  it("skips with a message when the target already exists and leaves target bytes unchanged", async () => {
    const source = copyFixture("with-handles");
    const target = join(makeTempRoot("migrate-target-"), "kb");
    const logs: string[] = [];

    await migrateTwitterHelperKB({
      sourceDir: source,
      targetDir: target,
      log: (line) => logs.push(line),
    });
    const beforeSecondRun = snapshotTree(target);

    const result = await migrateTwitterHelperKB({
      sourceDir: source,
      targetDir: target,
      log: (line) => logs.push(line),
    });

    expect(result.status).toBe("skipped");
    expect(logs.some((line) => line.includes("migration skipped"))).toBe(true);
    expect(snapshotTree(target)).toEqual(beforeSecondRun);
  });

  it("aborts invalid UTF-8 library input without partial target output or replacement characters", async () => {
    const source = copyFixture("invalid-utf8");
    const target = join(makeTempRoot("migrate-target-"), "kb");
    const logs: string[] = [];
    const warnings: string[] = [];

    await expect(
      migrateTwitterHelperKB({
        sourceDir: source,
        targetDir: target,
        log: (line) => logs.push(line),
        warn: (line) => warnings.push(line),
      }),
    ).rejects.toThrow(/invalid UTF-8/);

    expect(existsSync(target)).toBe(false);
    expect(`${logs.join("\n")}\n${warnings.join("\n")}`).not.toContain("\uFFFD");
  });
});

describe("migrate-from-twitter-helper script", () => {
  it("migrates a fixture through the tsx wrapper", () => {
    const source = copyFixture("with-handles");
    const target = join(makeTempRoot("migrate-target-"), "kb");
    const run = spawnSync(
      "npx",
      [
        "tsx",
        "scripts/migrate-from-twitter-helper.ts",
        "--source",
        source,
        "--target",
        target,
      ],
      {
        cwd: resolve("."),
        encoding: "utf8",
      },
    );

    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(run.stdout).toContain("migration complete");
    expect(parseHandles(readUtf8(join(target, "handles.md")), "test").tiers).toHaveLength(3);
  });
});
