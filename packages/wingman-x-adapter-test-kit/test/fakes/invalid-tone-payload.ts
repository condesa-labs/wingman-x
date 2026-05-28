import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/invalid-tone-payload" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "invalid-tone", title: "Invalid Tone" };
  return {
    schemaVersion: "1",
    name: "invalid-tone-payload",
    version: "0.1.0",
    displayName: "Invalid Tone Payload",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 1, handlesCount: 0, toneBytes: 10 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return { markdown: "Tone" } as never;
    },
    async listLibrary() {
      return [entry];
    },
    async getLibraryEntry() {
      return { ...entry, markdown: "# Invalid Tone" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
