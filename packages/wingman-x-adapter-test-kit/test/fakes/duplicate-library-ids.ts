import type { KBAdapter } from "@wingman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/duplicate-library-ids" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const first = { id: "duplicate-entry", title: "First Duplicate" };
  const second = { id: "duplicate-entry", title: "Second Duplicate" };
  return {
    schemaVersion: "1",
    name: "duplicate-library-ids",
    version: "0.1.0",
    displayName: "Duplicate Library Ids",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 2, handlesCount: 0, toneBytes: 10 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return { markdown: "Tone", meta: {} };
    },
    async listLibrary() {
      return [first, second];
    },
    async getLibraryEntry() {
      return { ...first, markdown: "# Duplicate Entry" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
