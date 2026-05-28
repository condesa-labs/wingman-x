import { isDeepStrictEqual } from "node:util";
import {
  HandleSetSchema,
  HealthReportSchema,
  KBAdapterError,
  LibraryContentSchema,
  LibraryEntrySchema,
  ToneResultSchema,
  type KBAdapter,
} from "@winman-x/kb-contract";
import { describe, it } from "vitest";
import { z } from "zod";

export interface ConformanceFixtures<C = unknown> {
  readonly config: C;
}

export interface RunConformanceTestsOptions<C = unknown> {
  readonly createAdapter?: unknown;
  readonly configSchema?: unknown;
  readonly fixtures: ConformanceFixtures<C>;
  readonly suiteName?: string;
}

type ConfigSchema<C> = {
  parse(value: unknown): C;
  safeParse(value: unknown): unknown;
};

type AdapterMethod<T> = () => T | Promise<T>;

const documentedErrorCodes = new Set([
  "CONFIG_INVALID",
  "SOURCE_UNAVAILABLE",
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "UNKNOWN",
]);

const LibraryEntryArraySchema = z.array(LibraryEntrySchema);

export async function assertAdapterConformance<C>(
  options: RunConformanceTestsOptions<C>,
): Promise<void> {
  const adapter = createAdapterForConformance(options);
  assertAdapterMetadata(adapter);
  assertRequiredMethods(adapter);
  assertOptionalMethods(adapter);

  parsePayload(
    "healthCheck() result",
    "HealthReportSchema",
    HealthReportSchema,
    await invokeAdapterOperation("healthCheck()", () => adapter.healthCheck()),
  );

  parsePayload(
    "getTone() result",
    "ToneResultSchema",
    ToneResultSchema,
    await invokeAdapterOperation("getTone()", () => adapter.getTone()),
  );

  const libraryEntries = parsePayload(
    "listLibrary() result",
    "z.array(LibraryEntrySchema)",
    LibraryEntryArraySchema,
    await invokeAdapterOperation("listLibrary()", () => adapter.listLibrary()),
  );
  assertUniqueLibraryIds(libraryEntries);

  const firstLibraryContents = new Map<string, unknown>();
  for (const entry of libraryEntries) {
    const content = parsePayload(
      `getLibraryEntry(${JSON.stringify(entry.id)}) result`,
      "LibraryContentSchema",
      LibraryContentSchema,
      await invokeAdapterOperation(`getLibraryEntry(${JSON.stringify(entry.id)})`, () =>
        adapter.getLibraryEntry(entry.id),
      ),
    );
    firstLibraryContents.set(entry.id, content);
  }

  parsePayload(
    "getHandles() result",
    "HandleSetSchema",
    HandleSetSchema,
    await invokeAdapterOperation("getHandles()", () => adapter.getHandles()),
  );

  const repeatedLibraryEntries = parsePayload(
    "repeated listLibrary() result",
    "z.array(LibraryEntrySchema)",
    LibraryEntryArraySchema,
    await invokeAdapterOperation("listLibrary() repeat", () => adapter.listLibrary()),
  );
  assertStableResult("listLibrary()", libraryEntries, repeatedLibraryEntries);

  for (const entry of libraryEntries) {
    const repeatedContent = parsePayload(
      `repeated getLibraryEntry(${JSON.stringify(entry.id)}) result`,
      "LibraryContentSchema",
      LibraryContentSchema,
      await invokeAdapterOperation(`getLibraryEntry(${JSON.stringify(entry.id)}) repeat`, () =>
        adapter.getLibraryEntry(entry.id),
      ),
    );
    assertStableResult(
      `getLibraryEntry(${JSON.stringify(entry.id)})`,
      firstLibraryContents.get(entry.id),
      repeatedContent,
    );
  }

  await assertOptionalCapabilities(adapter);
}

export function runConformanceTests<C>(options: RunConformanceTestsOptions<C>): void {
  describe(options.suiteName ?? "WingmanX adapter conformance", () => {
    it("exports a usable createAdapter and configSchema entrypoint", () => {
      createAdapterForConformance(options);
    });

    it("satisfies the v1 adapter contract", async () => {
      await assertAdapterConformance(options);
    });
  });
}

function createAdapterForConformance<C>(options: RunConformanceTestsOptions<C>): KBAdapter {
  assertFunction(options.createAdapter, "createAdapter export");
  assertConfigSchema<C>(options.configSchema);

  let parsedConfig: C;
  try {
    parsedConfig = options.configSchema.parse(options.fixtures.config);
  } catch (cause) {
    throw new Error("configSchema export must parse fixtures.config", { cause });
  }

  const adapter = options.createAdapter(parsedConfig);
  assertRecord(adapter, "createAdapter return value");
  return adapter as unknown as KBAdapter;
}

function assertAdapterMetadata(adapter: KBAdapter): void {
  if (adapter.schemaVersion !== "1") {
    throw new Error(`adapter.schemaVersion must be "1"; received ${JSON.stringify(adapter.schemaVersion)}`);
  }
}

function assertRequiredMethods(adapter: KBAdapter): void {
  const candidate = adapter as unknown as Record<string, unknown>;
  assertFunction(candidate.healthCheck, "adapter.healthCheck");
  assertFunction(candidate.getTone, "adapter.getTone");
  assertFunction(candidate.listLibrary, "adapter.listLibrary");
  assertFunction(candidate.getLibraryEntry, "adapter.getLibraryEntry");
  assertFunction(candidate.getHandles, "adapter.getHandles");
}

function assertOptionalMethods(adapter: KBAdapter): void {
  const candidate = adapter as unknown as Record<string, unknown>;
  assertOptionalFunction(candidate.bootstrapTone, "adapter.bootstrapTone");
  assertOptionalFunction(candidate.searchLibrary, "adapter.searchLibrary");
  assertOptionalFunction(candidate.watch, "adapter.watch");
}

async function assertOptionalCapabilities(adapter: KBAdapter): Promise<void> {
  const bootstrapTone = adapter.bootstrapTone;
  if (bootstrapTone !== undefined) {
    parsePayload(
      "bootstrapTone() result",
      "ToneResultSchema",
      ToneResultSchema,
      await invokeAdapterOperation("bootstrapTone()", () => bootstrapTone.call(adapter)),
    );
  }

  const searchLibrary = adapter.searchLibrary;
  if (searchLibrary !== undefined) {
    parsePayload(
      "searchLibrary() result",
      "z.array(LibraryEntrySchema)",
      LibraryEntryArraySchema,
      await invokeAdapterOperation("searchLibrary()", () => searchLibrary.call(adapter, "", 5)),
    );
  }

  const watch = adapter.watch;
  if (watch !== undefined) {
    const events = await invokeAdapterOperation("watch()", () => watch.call(adapter));
    assertAsyncIterable(events, "watch() result");
  }
}

async function invokeAdapterOperation<T>(label: string, operation: AdapterMethod<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    validateKBAdapterError(error, label);
    throw error;
  }
}

function parsePayload<T>(
  label: string,
  schemaName: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new Error(`${label} must pass ${schemaName}.parse(...)`, { cause });
  }
}

function assertUniqueLibraryIds(entries: ReadonlyArray<{ id: string }>): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) {
      throw new Error(`duplicate LibraryEntry.id detected: ${entry.id}`);
    }
    seen.add(entry.id);
  }
}

function assertStableResult(label: string, first: unknown, second: unknown): void {
  if (!isDeepStrictEqual(first, second)) {
    throw new Error(`${label} must return stable identical results across repeated calls`);
  }
}

function validateKBAdapterError(error: unknown, label: string): void {
  if (!isKBAdapterErrorCandidate(error)) {
    return;
  }

  const record = error as Record<string, unknown>;
  if (record.name !== "KBAdapterError") {
    throw new Error(`${label} threw KBAdapterError with invalid name ${JSON.stringify(record.name)}`);
  }

  if (typeof record.code !== "string" || !documentedErrorCodes.has(record.code)) {
    throw new Error(
      `${label} threw KBAdapterError with undocumented enum code ${JSON.stringify(record.code)}`,
    );
  }
}

function isKBAdapterErrorCandidate(error: unknown): boolean {
  if (error instanceof KBAdapterError) {
    return true;
  }

  return (
    isRecord(error) &&
    (error.name === "KBAdapterError" ||
      (isRecord(error.constructor) && error.constructor.name === "KBAdapterError"))
  );
}

function assertConfigSchema<C>(value: unknown): asserts value is ConfigSchema<C> {
  if (
    !isRecord(value) ||
    typeof value.parse !== "function" ||
    typeof value.safeParse !== "function"
  ) {
    throw new Error("configSchema export must be a Zod schema with parse and safeParse");
  }
}

function assertFunction(value: unknown, label: string): asserts value is (...args: unknown[]) => unknown {
  if (typeof value !== "function") {
    throw new Error(`${label} must be a function`);
  }
}

function assertOptionalFunction(
  value: unknown,
  label: string,
): asserts value is undefined | ((...args: unknown[]) => unknown) {
  if (value !== undefined && typeof value !== "function") {
    throw new Error(`${label} must be a function when present`);
  }
}

function assertAsyncIterable(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value[Symbol.asyncIterator] !== "function") {
    throw new Error(`${label} must be an AsyncIterable`);
  }
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
