import { KBAdapterError, type KBAdapter } from "@winman-x/kb-contract";
import { z } from "zod";

export const configSchema = z.object({
  root: z.string(),
});

export const fixtures = {
  config: { root: "/tmp/non-enum-error-code" },
};

export function createAdapter(_config: z.infer<typeof configSchema>): KBAdapter {
  const entry = { id: "error-code", title: "Error Code" };
  return {
    schemaVersion: "1",
    name: "non-enum-error-code",
    version: "0.1.0",
    displayName: "Non Enum Error Code",
    async healthCheck() {
      throw new KBAdapterError("NOT_A_DOCUMENTED_CODE" as never, "non-enum-error-code", "bad");
    },
    async getTone() {
      return { markdown: "Tone", meta: {} };
    },
    async listLibrary() {
      return [entry];
    },
    async getLibraryEntry() {
      return { ...entry, markdown: "# Error Code" };
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
