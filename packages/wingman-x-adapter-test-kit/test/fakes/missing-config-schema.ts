import type { KBAdapter } from "@winman-x/kb-contract";

export const fixtures = {
  config: { root: "/tmp/missing-config-schema" },
};

export function createAdapter(_config: { root: string }): KBAdapter {
  const entry = { id: "missing-config-schema", title: "Missing Config Schema" };
  return {
    schemaVersion: "1",
    name: "missing-config-schema",
    version: "0.1.0",
    displayName: "Missing Config Schema",
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
      return { ...entry, markdown: "# Missing Config Schema" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
