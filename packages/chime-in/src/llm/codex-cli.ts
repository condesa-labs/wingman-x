import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMError, createProvider, type LLMProvider, type ModelTier } from "./provider.js";

/**
 * Backend: OpenAI Codex CLI (`codex exec`). Uses the user's ChatGPT login.
 * Runs read-only, ephemeral, outside any git repo, with the JSON schema
 * passed via `--output-schema` and the final message captured with `-o`.
 */
export interface CodexCliOptions {
  bin?: string;
  models?: Partial<Record<ModelTier, string>>;
  timeoutMs: number;
  log?: (line: string) => void;
}

const REASONING: Record<ModelTier, string> = { cheap: "low", strong: "medium", draft: "medium" };

export function createCodexCliProvider(options: CodexCliOptions): LLMProvider {
  const bin = options.bin ?? "codex";
  const models: Record<ModelTier, string> = {
    cheap: options.models?.cheap ?? "default",
    strong: options.models?.strong ?? "default",
    draft: options.models?.draft ?? "default",
  };

  return createProvider({
    name: "codex-cli",
    models,
    log: options.log,
    rawComplete: ({ system, prompt, tier, jsonSchema }) =>
      new Promise((resolve, reject) => {
        const dir = mkdtempSync(join(tmpdir(), "chime-codex-"));
        const schemaPath = join(dir, "schema.json");
        const outPath = join(dir, "out.txt");
        writeFileSync(schemaPath, JSON.stringify(jsonSchema));
        const args = [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "-C",
          dir,
          "-c",
          `model_reasoning_effort=${REASONING[tier]}`,
          "--output-schema",
          schemaPath,
          "-o",
          outPath,
          "--color",
          "never",
        ];
        if (models[tier] !== "default") args.push("-m", models[tier]);
        args.push("-");
        const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        let settled = false;
        const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 1000).unref();
          cleanup();
          reject(new LLMError(`codex timed out after ${options.timeoutMs}ms`, "timeout"));
        }, options.timeoutMs);
        child.stdout.on("data", () => undefined);
        child.stderr.on("data", (b: Buffer) => (stderr += String(b)));
        child.on("error", (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(new LLMError(`failed to spawn ${bin}: ${err.message}`, "spawn"));
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          let text = "";
          try {
            text = readFileSync(outPath, "utf8");
          } catch {
            // no output file
          }
          cleanup();
          if (code !== 0) {
            reject(new LLMError(`codex exited ${code}: ${stderr.slice(-400)}`, "spawn"));
            return;
          }
          resolve({ text });
        });
        child.stdin.on("error", () => undefined);
        child.stdin.end(
          `${system}\n\nDo not run commands or read files; answer from the information below only.\n\n${prompt}`,
        );
      }),
  });
}
