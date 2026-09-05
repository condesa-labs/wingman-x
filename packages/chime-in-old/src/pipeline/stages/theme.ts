import { z } from "zod";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";

/**
 * Stage 2 — theme classification with the cheap model. Posts are batched
 * to keep the call count low; any post the batch answer omits is retried
 * alone once, and if it still fails it is reported as an error (never
 * silently dropped, never marked processed).
 */
export const ThemeResultSchema = z.object({
  relevant: z.boolean(),
  theme: z.string(),
  theme_score: z.number().int().min(0).max(100),
  reason: z.string(),
});
export type ThemeResult = z.infer<typeof ThemeResultSchema>;

const BatchSchema = z.object({
  results: z.array(ThemeResultSchema.extend({ tweet_id: z.string() })),
});

export function buildThemeSystemPrompt(themes: readonly string[]): string {
  return [
    "You are a strict relevance classifier for one specific person's X (Twitter) feed.",
    "The person cares about these themes:",
    ...themes.map((t) => `- ${t}`),
    "",
    "For each post decide whether it SUBSTANTIVELY engages with one of these themes — an argument, a claim, a question, a data point, an announcement with real content. Classify by meaning, not keywords: a post about a bank piloting settlement on a shared ledger is about Securities infrastructure / Settlement even if it never says 'tokenization' or 'RWA'.",
    "",
    "Scoring (theme_score, 0-100):",
    "- 85-100: the post is squarely about a theme and makes a substantive point.",
    "- 60-84: clearly touches a theme, but thinner or partly about something else.",
    "- 30-59: a passing mention, generic industry chatter, or only adjacent (macro, generic crypto price talk, general startup advice).",
    "- 0-29: unrelated.",
    "Set relevant=true only when theme_score >= 50. Pick the single best-fitting theme name from the list (copy it exactly). Keep reason to one short sentence.",
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildThemeBatchPrompt(posts: NormalizedPost[]): string {
  return [
    `Classify the following ${posts.length} post(s). Return JSON: {"results": [{"tweet_id", "relevant", "theme", "theme_score", "reason"}]} with exactly one entry per tweet_id.`,
    "",
    ...posts.map((p) => renderPost(p)),
  ].join("\n");
}

export type ThemeOutcome =
  | { ok: true; result: ThemeResult }
  | { ok: false; error: string };

export async function classifyThemes(
  posts: NormalizedPost[],
  deps: { llm: LLMProvider; themes: readonly string[]; batchSize: number; log?: (l: string) => void },
): Promise<Map<string, ThemeOutcome>> {
  const out = new Map<string, ThemeOutcome>();
  const system = buildThemeSystemPrompt(deps.themes);
  const batches: NormalizedPost[][] = [];
  for (let i = 0; i < posts.length; i += deps.batchSize) batches.push(posts.slice(i, i + deps.batchSize));

  async function runBatch(batch: NormalizedPost[], label: string): Promise<NormalizedPost[]> {
    const missing: NormalizedPost[] = [];
    try {
      const res = await deps.llm.complete({
        tier: "cheap",
        system,
        prompt: buildThemeBatchPrompt(batch),
        schema: BatchSchema,
        label,
        maxTokens: 200 + batch.length * 160,
      });
      const byId = new Map(res.results.map((r) => [r.tweet_id, r] as const));
      for (const p of batch) {
        const r = byId.get(p.tweet_id);
        if (!r) {
          missing.push(p);
          continue;
        }
        const { tweet_id: _id, ...rest } = r;
        out.set(p.tweet_id, { ok: true, result: rest });
      }
    } catch (err) {
      deps.log?.(`[theme] ${label} failed: ${(err as Error).message}`);
      missing.push(...batch);
    }
    return missing;
  }

  let batchNo = 0;
  for (const batch of batches) {
    batchNo += 1;
    const missing = await runBatch(batch, `theme:batch-${batchNo}`);
    for (const p of missing) {
      // Single-post retry so one confused batch answer doesn't cost the
      // whole group; a second failure becomes an explicit error.
      const still = await runBatch([p], `theme:retry-${p.tweet_id}`);
      for (const s of still) {
        out.set(s.tweet_id, { ok: false, error: "theme classification failed" });
      }
    }
  }
  return out;
}
