import { spawnSync } from "node:child_process";
import type { Config } from "../config.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createClaudeCliProvider } from "./claude-cli.js";
import { createCodexCliProvider } from "./codex-cli.js";
import type { LLMProvider, ModelTier } from "./provider.js";

export * from "./provider.js";
export { createFakeProvider } from "./fake.js";

function onPath(bin: string): boolean {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function modelOverrides(config: Config): Partial<Record<ModelTier, string>> {
  const m: Partial<Record<ModelTier, string>> = {};
  if (config.llmModelCheap) m.cheap = config.llmModelCheap;
  if (config.llmModelStrong) m.strong = config.llmModelStrong;
  if (config.llmModelDraft) m.draft = config.llmModelDraft;
  return m;
}

/**
 * Resolve the configured provider. `auto` prefers the Anthropic API when a
 * key is present, then the `claude` CLI, then `codex`. The pipeline never
 * imports a vendor SDK; swapping hosts is a one-line env change.
 */
export function createLLMProvider(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  log?: (line: string) => void,
): LLMProvider {
  const models = modelOverrides(config);
  const timeoutMs = config.llmTimeoutMs;
  let name = config.llmProvider;
  if (name === "auto") {
    if (env.ANTHROPIC_API_KEY) name = "anthropic";
    else if (onPath("claude")) name = "claude-cli";
    else if (onPath("codex")) name = "codex-cli";
    else {
      throw new Error(
        "no LLM provider available: set ANTHROPIC_API_KEY, or install the `claude` or `codex` CLI, or set LLM_PROVIDER explicitly",
      );
    }
  }
  switch (name) {
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
      return createAnthropicProvider({ apiKey, models, timeoutMs, log });
    }
    case "claude-cli":
      return createClaudeCliProvider({ models, timeoutMs, log });
    case "codex-cli":
      return createCodexCliProvider({ models, timeoutMs, log });
    case "fake":
      throw new Error("LLM_PROVIDER=fake is only for tests; pass a provider explicitly");
    default:
      throw new Error(`unknown LLM provider ${String(name)}`);
  }
}
