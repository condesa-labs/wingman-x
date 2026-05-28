import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/noop" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = {
    id: "noop-capabilities",
    title: "No-op Capabilities",
  };
  const tone = {
    markdown: "Prefer helpful specifics over flourish.",
    meta: { tags: ["noop"] },
  };
  const content = {
    ...entry,
    markdown: "# No-op Capabilities\n\nOptional methods are present but empty.",
  };

  return {
    schemaVersion: "1",
    name: "optional-noop",
    version: "0.1.0",
    displayName: "Optional No-op",
    async healthCheck() {
      return {
        ok: true,
        stats: { libraryCount: 1, handlesCount: 0, toneBytes: 36 },
        warnings: [],
        errors: [],
      };
    },
    async getTone() {
      return tone;
    },
    async bootstrapTone() {
      return tone;
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
    async searchLibrary() {
      return [];
    },
    async getHandles() {
      return { tiers: [] };
    },
    async *watch() {
      return;
    },
  };
}
