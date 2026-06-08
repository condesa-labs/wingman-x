import type { KBAdapter } from "@wingman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/invalid-library-content-payload" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "invalid-content", title: "Invalid Content" };
  return {
    schemaVersion: "1",
    name: "invalid-library-content-payload",
    version: "0.1.0",
    displayName: "Invalid Library Content Payload",
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
      return { id: "invalid-content", title: "Invalid Content" } as never;
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
