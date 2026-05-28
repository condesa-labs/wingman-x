import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/wrong-schema-version" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "schema-version", title: "Schema Version" };
  return {
    schemaVersion: "2" as "1",
    name: "wrong-schema-version",
    version: "0.1.0",
    displayName: "Wrong Schema Version",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 1, handlesCount: 0, toneBytes: 10 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return { markdown: "Tone", meta: {} };
    },
    async listLibrary() {
      return [entry];
    },
    async getLibraryEntry() {
      return { ...entry, markdown: "# Schema Version" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
