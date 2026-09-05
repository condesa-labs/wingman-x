import { LLMError, createProvider, type LLMProvider, type ModelTier } from "./provider.js";

/**
 * Backend: Anthropic Messages API over plain `fetch` (no SDK dependency).
 * Selected automatically when `ANTHROPIC_API_KEY` is set.
 */
export interface AnthropicOptions {
  apiKey: string;
  models?: Partial<Record<ModelTier, string>>;
  timeoutMs: number;
  baseUrl?: string;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

const DEFAULT_MODELS: Record<ModelTier, string> = {
  cheap: "claude-haiku-4-5-20251001",
  strong: "claude-sonnet-5",
  draft: "claude-sonnet-5",
};

export function createAnthropicProvider(options: AnthropicOptions): LLMProvider {
  const models: Record<ModelTier, string> = { ...DEFAULT_MODELS, ...(options.models ?? {}) };
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  return createProvider({
    name: "anthropic",
    models,
    log: options.log,
    rawComplete: async ({ system, prompt, tier, jsonSchema, maxTokens }) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), options.timeoutMs);
      try {
        const res = await doFetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: models[tier],
            max_tokens: maxTokens,
            system: `${system}\n\nRespond with a single JSON object matching this JSON Schema and nothing else:\n${JSON.stringify(jsonSchema)}`,
            messages: [{ role: "user", content: prompt }],
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new LLMError(`anthropic HTTP ${res.status}: ${body.slice(0, 300)}`, "http");
        }
        const json = (await res.json()) as {
          content?: Array<{ type: string; text?: string }>;
        };
        const text = (json.content ?? [])
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        return { text };
      } catch (err) {
        if (err instanceof LLMError) throw err;
        if ((err as Error).name === "AbortError") {
          throw new LLMError(`anthropic timed out after ${options.timeoutMs}ms`, "timeout");
        }
        throw new LLMError(`anthropic request failed: ${(err as Error).message}`, "http");
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
