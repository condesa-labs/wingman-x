import type { KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/missing-health-check" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const adapter = {
    schemaVersion: "1",
    name: "missing-health-check",
    version: "0.1.0",
    displayName: "Missing Health Check",
    async getTone() {
      return { markdown: "Tone", meta: {} };
    },
    async listLibrary() {
      return [{ id: "missing-health", title: "Missing Health" }];
    },
    async getLibraryEntry() {
      return { id: "missing-health", title: "Missing Health", markdown: "# Missing Health" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };

  return adapter as unknown as KBAdapter;
}
