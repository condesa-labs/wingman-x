import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { configSchema, createAdapter } from "../src/index.js";

const sampleVaultPath = resolve(import.meta.dirname, "fixtures/sample-vault");

function writeVaultFiles(
  vaultPath: string,
  files: Record<string, string>,
  options: {
    wingmanRoot?: string;
    toneFile?: string;
    libraryFolder?: string;
    handlesFile?: string;
    handlesMarkdown?: string;
  } = {},
): void {
  const wingmanRoot = options.wingmanRoot ?? "WingmanX";
  const toneFile = options.toneFile ?? "VOICE.md";
  const libraryFolder = options.libraryFolder ?? "library";
  const handlesFile = options.handlesFile ?? "handles.md";
  const rootPath = join(vaultPath, wingmanRoot);
  const libraryPath = join(rootPath, libraryFolder);

  mkdirSync(libraryPath, { recursive: true });
  writeFileSync(join(rootPath, toneFile), "# Tone\n", "utf8");
  writeFileSync(join(rootPath, handlesFile), options.handlesMarkdown ?? "", "utf8");
  for (const [fileName, markdown] of Object.entries(files)) {
    writeFileSync(join(libraryPath, fileName), markdown, "utf8");
  }
}

describe("Obsidian vault reads", () => {
  it("resolves tone, library, and handles through vaultPath plus default wingmanRoot", async () => {
    const adapter = createAdapter(configSchema.parse({ vaultPath: sampleVaultPath }));

    await expect(adapter.getTone()).resolves.toEqual({
      markdown: expect.stringContaining("short, specific sentences"),
      meta: {
        source: join(sampleVaultPath, "WingmanX", "VOICE.md"),
      },
    });
    await expect(adapter.listLibrary()).resolves.toEqual([
      { id: "latency", title: "Latency Notes" },
      { id: "launch-notes", title: "Launch Notes" },
    ]);
    await expect(adapter.getLibraryEntry("launch-notes")).resolves.toMatchObject({
      id: "launch-notes",
      title: "Launch Notes",
      markdown: expect.stringContaining("grounded in the vault"),
    });
    await expect(adapter.getHandles()).resolves.toEqual({ tiers: [] });
  });

  it("honors configured root and file names when resolving vault paths", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-paths-"));
    try {
      writeVaultFiles(
        tempVault,
        {
          "Custom Note.md": "# Custom Note\n",
        },
        {
          wingmanRoot: "CustomWingman",
          toneFile: "TONE.md",
          libraryFolder: "notes",
          handlesFile: "people.md",
        },
      );
      const adapter = createAdapter(
        configSchema.parse({
          vaultPath: tempVault,
          wingmanRoot: "CustomWingman",
          toneFile: "TONE.md",
          libraryFolder: "notes",
          handlesFile: "people.md",
        }),
      );

      await expect(adapter.getTone()).resolves.toMatchObject({
        meta: {
          source: join(tempVault, "CustomWingman", "TONE.md"),
        },
      });
      await expect(adapter.listLibrary()).resolves.toEqual([
        { id: "custom-note", title: "Custom Note" },
      ]);
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("uses the derived id as the title when a library note has no heading", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-title-"));
    try {
      writeVaultFiles(tempVault, {
        "No Heading.md": "Body without a markdown heading.\n",
      });
      const adapter = createAdapter(configSchema.parse({ vaultPath: tempVault }));

      await expect(adapter.listLibrary()).resolves.toEqual([{ id: "no-heading", title: "no-heading" }]);
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("reports source read failures through healthCheck without throwing", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-missing-"));
    try {
      const adapter = createAdapter(configSchema.parse({ vaultPath: join(tempVault, "missing") }));

      await expect(adapter.healthCheck()).resolves.toMatchObject({
        ok: false,
        stats: {
          libraryCount: 0,
          handlesCount: 0,
          toneBytes: 0,
        },
        warnings: [],
        errors: [
          expect.stringContaining("SOURCE_UNAVAILABLE: Unable to read tone source"),
          expect.stringContaining("SOURCE_UNAVAILABLE: Unable to read library directory"),
          expect.stringContaining("SOURCE_UNAVAILABLE: Unable to read handles source"),
        ],
      });
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("returns NOT_FOUND for unknown library ids", async () => {
    const adapter = createAdapter(configSchema.parse({ vaultPath: sampleVaultPath }));

    await expect(adapter.getLibraryEntry("missing")).rejects.toMatchObject({
      name: "KBAdapterError",
      code: "NOT_FOUND",
    });
  });

  it("rejects source files that derive colliding ids with CONFIG_INVALID naming both paths", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-collision-"));
    try {
      const firstPath = join(tempVault, "WingmanX", "library", "Foo Bar.md");
      const secondPath = join(tempVault, "WingmanX", "library", "foo-bar.md");
      writeVaultFiles(tempVault, {
        "Foo Bar.md": "# First\n",
        "foo-bar.md": "# Second\n",
      });
      const adapter = createAdapter(configSchema.parse({ vaultPath: tempVault }));

      await expect(adapter.listLibrary()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      });
      await expect(adapter.listLibrary()).rejects.toThrow(firstPath);
      await expect(adapter.listLibrary()).rejects.toThrow(secondPath);
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });

  it("rejects source files that derive an empty id with CONFIG_INVALID naming the path", async () => {
    const tempVault = mkdtempSync(join(tmpdir(), "wingman-x-obsidian-empty-id-"));
    try {
      const sourcePath = join(tempVault, "WingmanX", "library", "___.md");
      writeVaultFiles(tempVault, {
        "___.md": "# Empty Id\n",
      });
      const adapter = createAdapter(configSchema.parse({ vaultPath: tempVault }));

      await expect(adapter.listLibrary()).rejects.toMatchObject({
        name: "KBAdapterError",
        code: "CONFIG_INVALID",
      });
      await expect(adapter.listLibrary()).rejects.toThrow(sourcePath);
    } finally {
      rmSync(tempVault, { recursive: true, force: true });
    }
  });
});
