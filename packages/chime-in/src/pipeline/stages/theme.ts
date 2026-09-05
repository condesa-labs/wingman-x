import { z } from "zod";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";
import { mapWithConcurrency } from "../../util/concurrency.js";

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

export function buildThemeSystemPrompt(themes: readonly string[], conversationalThemes: readonly string[] = []): string {
  const conv = conversationalThemes.filter((c) => themes.some((t) => t.toLowerCase() === c.toLowerCase()));
  return [
    "You are a strict relevance classifier for one specific person's X (Twitter) feed.",
    "The person cares about these themes:",
    ...themes.map((t) => `- ${t}`),
    "",
    ...(conv.length > 0
      ? [
          `Conversational themes (a different lane, no expertise involved): ${conv.join("; ")}. A post fits one of these when a person makes a real observation, joke, or take about technology, startups, or internet life. Link dumps, announcements without a take, and engagement bait are NOT relevant there. If a post fits both a conversational theme and any other theme, choose the other theme: expertise wins on overlap.`,
          "",
        ]
      : []),
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
  deps: {
    llm: LLMProvider;
    themes: readonly string[];
    conversationalThemes?: readonly string[];
    batchSize: number;
    /** Batches in flight at once. Defaults to 1 (sequential). */
    concurrency?: number;
    log?: (l: string) => void;
  },
): Promise<Map<string, ThemeOutcome>> {
  const out = new Map<string, ThemeOutcome>();
  const system = buildThemeSystemPrompt(deps.themes, deps.conversationalThemes ?? []);
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

  // Batches run in parallel up to the concurrency limit; 200 posts in
  // batches of 16 is 13 calls, which sequentially was the slowest part of
  // the whole scan. Single-post retries for anything a batch left out.
  const limit = Math.max(1, deps.concurrency ?? 1);
  const missingPerBatch = await mapWithConcurrency(batches, limit, (batch, i) => runBatch(batch, `theme:batch-${i + 1}`));
  const missing = missingPerBatch.flat();
  const stillMissing = await mapWithConcurrency(missing, limit, (p) => runBatch([p], `theme:retry-${p.tweet_id}`));
  for (const s of stillMissing.flat()) {
    out.set(s.tweet_id, { ok: false, error: "theme classification failed" });
  }
  return out;
}
