import type { KBAdapter } from "@wingman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/omitted" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = {
    id: "omitted-options",
    title: "Omitted Options",
    tags: ["optional"],
  };
  const content = {
    ...entry,
    markdown: "# Omitted Options\n\nThis adapter leaves optional methods undefined.",
  };

  return {
    schemaVersion: "1",
    name: "optional-omitted",
    version: "0.1.0",
    displayName: "Optional Omitted",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 1, handlesCount: 0, toneBytes: 20 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return {
        markdown: "Keep the message calm and concrete.",
        meta: { source: "fixture" },
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
      return { tiers: [] };
    },
  };
}
