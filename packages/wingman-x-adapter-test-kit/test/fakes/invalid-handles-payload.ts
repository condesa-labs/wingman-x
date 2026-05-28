import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/invalid-handles-payload" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "invalid-handles", title: "Invalid Handles" };
  return {
    schemaVersion: "1",
    name: "invalid-handles-payload",
    version: "0.1.0",
    displayName: "Invalid Handles Payload",
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
      return { ...entry, markdown: "# Invalid Handles" };
    },
    async getHandles() {
      return { tiers: [{ tier: 4, label: "Bad", handles: [] }] } as never;
    },
  };
}
