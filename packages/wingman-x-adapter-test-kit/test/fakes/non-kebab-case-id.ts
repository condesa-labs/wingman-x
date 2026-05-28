import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/non-kebab-case-id" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "Invalid_Id", title: "Invalid Id" };
  return {
    schemaVersion: "1",
    name: "non-kebab-id",
    version: "0.1.0",
    displayName: "Non Kebab Id",
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
      return { ...entry, markdown: "# Invalid Id" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
