import { createProvider, type LLMProvider, type ModelTier } from "./provider.js";

/**
 * Deterministic provider for tests and offline dry runs. The handler sees
 * the tier, label, system and prompt and returns whatever object the
 * caller scripted (validated against the stage schema like any provider).
 */
export type FakeHandler = (args: {
  tier: ModelTier;
  label: string;
  system: string;
  prompt: string;
}) => unknown | Promise<unknown>;

export function createFakeProvider(handler: FakeHandler, log?: (line: string) => void): LLMProvider {
  return createProvider({
    name: "fake",
    models: { cheap: "fake-cheap", strong: "fake-strong", draft: "fake-draft" },
    log,
    retries: 0,
    rawComplete: async ({ tier, label, system, prompt }) => ({
      structured: await handler({ tier, label, system, prompt }),
    }),
  });
}
