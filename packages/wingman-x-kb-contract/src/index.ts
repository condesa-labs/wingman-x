export type { AdapterModule, KBAdapter } from "./contract.js";
export { KBAdapterError } from "./errors.js";
export type { KBAdapterErrorCode } from "./errors.js";
export { parseHandles, serializeHandles } from "./handles-grammar.js";
export {
  BootstrapOptionsSchema,
  HandleSchema,
  HandleSetSchema,
  HandleTierSchema,
  HealthReportSchema,
  KBEventSchema,
  LibraryContentSchema,
  LibraryEntrySchema,
  ToneResultSchema,
  WingmanXConfigSchema,
} from "./schemas.js";
export type {
  BootstrapOptions,
  Handle,
  HandleSet,
  HandleTier,
  HealthReport,
  KBEvent,
  LibraryContent,
  LibraryEntry,
  ToneResult,
  WingmanXConfig,
} from "./schemas.js";
export { slugify } from "./slug.js";
