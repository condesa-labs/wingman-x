import { spawn } from "node:child_process";
import { LLMError, createProvider, type LLMProvider, type ModelTier } from "./provider.js";

/**
 * Backend: the `claude` CLI in print mode. Uses the user's Claude Code
 * subscription — no API key needed. We disable tools, slash commands and
 * setting sources so each call is a minimal one-shot completion (~1k
 * input tokens of overhead), and use `--json-schema` for structured output.
 *
 * Note: `claude` refuses to run nested inside another Claude Code session,
 * so we strip the `CLAUDECODE*` / `CLAUDE_CODE_*` env vars from the child.
 */
export interface ClaudeCliOptions {
  bin?: string;
  models?: Partial<Record<ModelTier, string>>;
  timeoutMs: number;
  log?: (line: string) => void;
}

const DEFAULT_MODELS: Record<ModelTier, string> = {
  cheap: "haiku",
  strong: "sonnet",
  draft: "sonnet",
};

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    env[k] = v;
  }
  return env;
}

interface ClaudePrintResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
}

export function createClaudeCliProvider(options: ClaudeCliOptions): LLMProvider {
  const bin = options.bin ?? "claude";
  const models: Record<ModelTier, string> = { ...DEFAULT_MODELS, ...(options.models ?? {}) };

  return createProvider({
    name: "claude-cli",
    models,
    log: options.log,
    rawComplete: ({ system, prompt, tier, jsonSchema }) =>
      new Promise((resolve, reject) => {
        const args = [
          "-p",
          "--no-session-persistence",
          "--tools",
          "",
          "--disable-slash-commands",
          "--setting-sources",
          "",
          "--output-format",
          "json",
          "--model",
          models[tier],
          "--system-prompt",
          system,
          "--json-schema",
          JSON.stringify(jsonSchema),
        ];
        const child = spawn(bin, args, { env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1000).unref();
          reject(new LLMError(`claude timed out after ${options.timeoutMs}ms`, "timeout"));
        }, options.timeoutMs);
        child.stdout.on("data", (b: Buffer) => (stdout += String(b)));
        child.stderr.on("data", (b: Buffer) => (stderr += String(b)));
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new LLMError(`failed to spawn ${bin}: ${err.message}`, "spawn"));
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) {
            reject(new LLMError(`claude exited ${code}: ${stderr.slice(-400) || stdout.slice(-400)}`, "spawn"));
            return;
          }
          let parsed: ClaudePrintResult;
          try {
            parsed = JSON.parse(stdout) as ClaudePrintResult;
          } catch {
            reject(new LLMError("claude did not emit JSON envelope", "invalid_json", stdout.slice(0, 400)));
            return;
          }
          if (parsed.is_error) {
            reject(new LLMError(`claude error: ${parsed.result ?? parsed.subtype ?? "unknown"}`, "unknown"));
            return;
          }
          if (typeof parsed.result === "string" && /^Not logged in/i.test(parsed.result)) {
            reject(new LLMError("claude CLI is not logged in — run `claude` once and /login", "unknown"));
            return;
          }
          resolve({
            structured: parsed.structured_output,
            text: parsed.result,
            costUsd: parsed.total_cost_usd,
          });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(prompt);
      }),
  });
}
