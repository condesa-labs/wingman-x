import { z } from "zod";

/**
 * Provider-agnostic LLM surface. Every stage calls `complete()` with a
 * system prompt, a user prompt, and a zod schema for the JSON it expects
 * back. Providers must return the parsed, schema-valid object.
 *
 * `tier` maps to a concrete model per provider:
 *   cheap  — theme classification (many calls, easy task)
 *   strong — expertise + contribution scoring (the important filters)
 *   draft  — reply drafting and regeneration
 */
export type ModelTier = "cheap" | "strong" | "draft";

export interface CompletionRequest<T> {
  tier: ModelTier;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Short label for logs, e.g. "theme:batch-3" or "draft:1790…". */
  label?: string;
  maxTokens?: number;
}

export interface LLMUsage {
  calls: number;
  failures: number;
  byTier: Record<ModelTier, number>;
  costUsd: number;
  elapsedMs: number;
}

export interface LLMProvider {
  readonly name: string;
  complete<T>(req: CompletionRequest<T>): Promise<T>;
  usage(): LLMUsage;
  describeModels(): Record<ModelTier, string>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly kind: "timeout" | "spawn" | "http" | "invalid_json" | "schema" | "empty" | "unknown",
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

export function emptyUsage(): LLMUsage {
  return { calls: 0, failures: 0, byTier: { cheap: 0, strong: 0, draft: 0 }, costUsd: 0, elapsedMs: 0 };
}

/**
 * Pull a JSON object out of model text: strips a single ``` fence, then
 * takes the outermost `{ … }`. Throws `LLMError("invalid_json")`.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new LLMError("model returned empty output", "empty");
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fence?.[1] ?? trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // fall through to brace extraction
  }
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new LLMError("model output contained no JSON object", "invalid_json", body.slice(0, 400));
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new LLMError(
      `model output was not valid JSON: ${(err as Error).message}`,
      "invalid_json",
      body.slice(0, 400),
    );
  }
}

export function validateWithSchema<T>(value: unknown, schema: z.ZodType<T>): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new LLMError(
      `model JSON did not match schema: ${result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
      "schema",
      value,
    );
  }
  return result.data;
}

/** JSON Schema for providers that support structured output natively. */
export function toJsonSchema<T>(schema: z.ZodType<T>): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

/**
 * Shared skeleton: a provider implements `rawComplete(system, prompt,
 * tier, jsonSchema)` returning text (or an already-parsed object); this
 * wrapper handles JSON parsing, schema validation, one repair retry, usage
 * accounting and timing.
 */
export interface RawCompletion {
  text?: string;
  structured?: unknown;
  costUsd?: number;
}

export type RawCompleter = (args: {
  system: string;
  prompt: string;
  tier: ModelTier;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  label: string;
}) => Promise<RawCompletion>;

export function createProvider(options: {
  name: string;
  models: Record<ModelTier, string>;
  rawComplete: RawCompleter;
  log?: (line: string) => void;
  retries?: number;
}): LLMProvider {
  const usage = emptyUsage();
  const log = options.log ?? (() => undefined);
  const retries = options.retries ?? 1;

  return {
    name: options.name,
    describeModels: () => ({ ...options.models }),
    usage: () => ({ ...usage, byTier: { ...usage.byTier } }),
    async complete<T>(req: CompletionRequest<T>): Promise<T> {
      const jsonSchema = toJsonSchema(req.schema);
      const label = req.label ?? "llm";
      const maxTokens = req.maxTokens ?? 1200;
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const started = Date.now();
        usage.calls += 1;
        usage.byTier[req.tier] += 1;
        try {
          const prompt =
            attempt === 0
              ? req.prompt
              : `${req.prompt}\n\nYour previous answer was not valid JSON matching the schema (${String(
                  (lastError as Error)?.message ?? lastError,
                ).slice(0, 200)}). Return ONLY a single JSON object that matches the schema.`;
          const raw = await options.rawComplete({
            system: req.system,
            prompt,
            tier: req.tier,
            jsonSchema,
            maxTokens,
            label,
          });
          usage.elapsedMs += Date.now() - started;
          usage.costUsd += raw.costUsd ?? 0;
          const value = raw.structured !== undefined ? raw.structured : parseJsonLoose(raw.text ?? "");
          return validateWithSchema(value, req.schema);
        } catch (err) {
          usage.elapsedMs += Date.now() - started;
          usage.failures += 1;
          lastError = err;
          const kind = err instanceof LLMError ? err.kind : "unknown";
          const retryable = kind === "invalid_json" || kind === "schema" || kind === "empty";
          log(`[llm] ${label} attempt ${attempt + 1} failed (${kind}): ${(err as Error).message}`);
          if (!retryable || attempt === retries) throw err;
        }
      }
      throw lastError instanceof Error ? lastError : new LLMError(String(lastError), "unknown");
    },
  };
}
