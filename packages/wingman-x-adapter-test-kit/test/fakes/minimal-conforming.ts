import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/minimal" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = {
    id: "starter-note",
    title: "Starter Note",
    summary: "A stable library entry.",
  };
  const content = {
    ...entry,
    markdown: "# Starter Note\n\nUse direct, useful language.",
  };

  return {
    schemaVersion: "1",
    name: "minimal-conforming",
    version: "0.1.0",
    displayName: "Minimal Conforming",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 1, handlesCount: 1, toneBytes: 30 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return {
        markdown: "Write with useful detail and concise phrasing.",
        meta: { language: "en", updatedAt: "2026-05-25T00:00:00.000Z" },
      };
    },
    async listLibrary() {
      return [entry];
    },
    async getLibraryEntry(id: string) {
      if (id !== entry.id) {
        throw new Error(`Unknown entry ${id}`);
      }
      return content;
    },
    async getHandles() {
      return {
        tiers: [{ tier: 1, label: "Core", handles: [{ handle: "alice_dev" }] }],
      };
    },
  };
}
