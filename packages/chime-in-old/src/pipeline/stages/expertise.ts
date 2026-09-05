import { z } from "zod";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { renderExcerpts, type KBChunk, type KBIndex } from "../../kb/kb-index.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";

/**
 * Stage 3 — expertise matching. Retrieve the most relevant KB excerpts,
 * then ask the strong model whether the KB actually evidences enough
 * expertise or first-hand experience to contribute credibly. Interest is
 * not expertise: a macro post touching finance should score low unless
 * the KB shows real ground to stand on.
 */
export const ExpertiseResultSchema = z.object({
  expertise_score: z.number().int().min(0).max(100),
  relevant_kb_refs: z.array(z.string()),
  expertise_reason: z.string(),
});
export type ExpertiseResult = z.infer<typeof ExpertiseResultSchema>;

export interface ExpertiseOutcome extends ExpertiseResult {
  /** Chunks the model marked relevant (subset of retrieved), in KB order. */
  chunks: KBChunk[];
  /** Everything retrieved, for the contribution stage's context. */
  retrieved: KBChunk[];
}

export function buildExpertiseSystemPrompt(kbSummary: string): string {
  return [
    "You evaluate whether a specific person has enough real expertise or first-hand experience to credibly join a conversation on X.",
    "You are given the person's knowledge base: a summary of every file, plus the excerpts that best match the post. The knowledge base is the ONLY evidence of what this person knows and believes. Do not assume expertise that is not evidenced there.",
    "",
    "Knowledge base files:",
    kbSummary || "(empty knowledge base)",
    "",
    "Score expertise_score (0-100):",
    "- 85-100: the excerpts show direct experience or specific, well-formed views on exactly what the post discusses.",
    "- 70-84: solid adjacent knowledge with specific opinions that clearly apply.",
    "- 40-69: general familiarity; the person could comment but not with distinctive authority.",
    "- 0-39: the topic merely interests the person, or the knowledge base has nothing substantive about it (e.g. macroeconomics, politics, generic startup advice, price speculation).",
    "relevant_kb_refs: list the excerpt refs (the strings after [K1], [K2] …, e.g. 'library/private-credit.md#why-financing-utility-matters') that genuinely support the score. Empty if none apply.",
    "expertise_reason: one or two sentences naming the specific knowledge that applies (or why it does not).",
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildExpertisePrompt(post: NormalizedPost, theme: string, chunks: KBChunk[]): string {
  return [
    `Theme: ${theme}`,
    "",
    renderPost(post),
    "",
    "Knowledge base excerpts:",
    renderExcerpts(chunks),
    "",
    'Return JSON: {"expertise_score", "relevant_kb_refs", "expertise_reason"}.',
  ].join("\n");
}

export function retrievalQuery(post: NormalizedPost, theme: string): string {
  return `${theme} ${post.tweet_text} ${post.quoted_tweet?.text ?? ""}`;
}

export async function assessExpertise(
  post: NormalizedPost,
  theme: string,
  deps: { llm: LLMProvider; kb: KBIndex; topK: number },
): Promise<ExpertiseOutcome> {
  const retrieved = deps.kb.search(retrievalQuery(post, theme), deps.topK);
  const result = await deps.llm.complete({
    tier: "strong",
    system: buildExpertiseSystemPrompt(deps.kb.summary),
    prompt: buildExpertisePrompt(post, theme, retrieved),
    schema: ExpertiseResultSchema,
    label: `expertise:${post.tweet_id}`,
    maxTokens: 600,
  });
  const wanted = new Set(result.relevant_kb_refs);
  const chunks = retrieved.filter((c) => wanted.has(c.ref));
  return {
    ...result,
    relevant_kb_refs: chunks.map((c) => c.ref),
    chunks,
    retrieved,
  };
}
