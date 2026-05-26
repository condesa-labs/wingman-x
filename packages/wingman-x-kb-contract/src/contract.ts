/* v8 ignore file -- type-only public contract */
import type { z } from "zod";

import type {
  BootstrapOptions,
  HandleSet,
  HealthReport,
  KBEvent,
  LibraryContent,
  LibraryEntry,
  ToneResult,
} from "./schemas.js";

export interface KBAdapter {
  readonly schemaVersion: "1";
  readonly name: string;
  readonly version: string;
  readonly displayName: string;

  healthCheck(): Promise<HealthReport>;

  getTone(): Promise<ToneResult>;
  bootstrapTone?(opts?: BootstrapOptions): Promise<ToneResult>;

  listLibrary(): Promise<LibraryEntry[]>;
  getLibraryEntry(id: string): Promise<LibraryContent>;
  searchLibrary?(query: string, topK: number): Promise<LibraryEntry[]>;

  getHandles(): Promise<HandleSet>;

  watch?(): AsyncIterable<KBEvent>;
}

export interface AdapterModule<C = unknown> {
  createAdapter: (config: C) => KBAdapter;
  configSchema: z.ZodType<C>;
}
