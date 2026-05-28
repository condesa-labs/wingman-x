import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/unstable-list-library" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  let callCount = 0;

  return {
    schemaVersion: "1",
    name: "unstable-list-library",
    version: "0.1.0",
    displayName: "Unstable List Library",
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
      callCount += 1;
      return [{ id: "unstable-entry", title: `Unstable Entry ${callCount}` }];
    },
    async getLibraryEntry() {
      return { id: "unstable-entry", title: "Unstable Entry", markdown: "# Unstable Entry" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
