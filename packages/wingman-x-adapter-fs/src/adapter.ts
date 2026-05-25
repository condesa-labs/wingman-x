import type { KBAdapter } from "@wingman-x/kb-contract";

import type { FsConfig } from "./config.js";

export function createAdapter(_config: FsConfig): KBAdapter {
  return {
    schemaVersion: "1",
    name: "adapter-fs",
    version: "0.1.0",
    displayName: "Filesystem",
    async healthCheck() {
      return {
        ok: false,
        stats: { libraryCount: 0, handlesCount: 0, toneBytes: 0 },
        warnings: [],
        errors: ["not implemented"],
      };
    },
    async getTone() {
      throw new Error("not implemented");
    },
    async listLibrary() {
      return [];
    },
    async getLibraryEntry() {
      throw new Error("not implemented");
    },
    async searchLibrary() {
      return [];
    },
    async getHandles() {
      return { tiers: [] };
    },
  };
}
