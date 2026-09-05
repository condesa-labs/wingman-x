import { z } from "zod";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { renderExcerpts, type KBChunk } from "../../kb/kb-index.js";
import { SAFETY_PREAMBLE, renderEngagement, renderPost } from "../prompts.js";

/**
 * Stage 4 — contribution scoring. The most important filter. Matching the
 * person's knowledge is not enough; the question is whether they have
 * something useful, specific, or non-obvious to ADD to this exact post.
 */
export const ContributionResultSchema = z.object({
  contribution_score: z.number().int().min(0).max(100),
  contribution_angle: z.string(),
  reason: z.string(),
});
export type ContributionResult = z.infer<typeof ContributionResultSchema>;

export const CONTRIBUTION_SYSTEM_PROMPT = [
  "You decide whether a specific person should reply to a post on X. You are demanding: most posts — even relevant ones — should NOT get a reply.",
  "You are given the post, the person's knowledge base excerpts that apply, and a note on their expertise. The excerpts are the only things the person can credibly say; never assume experience beyond them.",
  "",
  "GOOD opportunities (score high):",
  "- The person disagrees with an important assumption in the post and can say why.",
  "- The person can add missing institutional context the author or readers lack.",
  "- The person has direct experience with the workflow, product, or structure being discussed.",
  "- The person can offer a useful, specific comparison.",
  "- The person can explain an overlooked market-structure, legal, or operational implication.",
  "- The person has a concrete example that supports or challenges the argument.",
  "",
  "BAD opportunities (score low):",
  "- The person basically agrees; the only reply is praise or 'great point'.",
  "- The reply would restate or summarise the post.",
  "- The reply would sound like generic networking or engagement bait.",
  "- The excerpts contain nothing specific enough to build a reply on.",
  "- The post is a plain announcement, a link drop, or a joke with no argument to engage.",
  "",
  "Scoring contribution_score (0-100):",
  "- 85-100: a sharp, specific angle grounded in the excerpts that adds something the thread does not have.",
  "- 70-84: a genuinely useful addition, somewhat narrower or less surprising.",
  "- 40-69: possible but thin; the reply would mostly be agreement with a detail.",
  "- 0-39: nothing worth saying.",
  "contribution_angle: ONE sentence stating the specific angle of the reply (what it would add, challenge, or compare). If the score is low, state the best available angle anyway.",
  "reason: one or two sentences justifying the score.",
  SAFETY_PREAMBLE,
].join("\n");

export function buildContributionPrompt(
  post: NormalizedPost,
  theme: string,
  expertiseReason: string,
  chunks: KBChunk[],
  constraints?: string,
): string {
  return [
    ...(constraints && constraints.trim()
      ? [
          "Hard constraints on what this person may say (a post whose only good reply would violate these should score LOW):",
          constraints.trim(),
          "",
        ]
      : []),
    `Theme: ${theme}`,
    `Engagement so far: ${renderEngagement(post)}`,
    `Expertise assessment: ${expertiseReason}`,
    "",
    renderPost(post),
    "",
    "Applicable knowledge base excerpts:",
    renderExcerpts(chunks),
    "",
    'Return JSON: {"contribution_score", "contribution_angle", "reason"}.',
  ].join("\n");
}

export async function assessContribution(
  post: NormalizedPost,
  theme: string,
  expertiseReason: string,
  chunks: KBChunk[],
  deps: { llm: LLMProvider; constraints?: string },
): Promise<ContributionResult> {
  return deps.llm.complete({
    tier: "strong",
    system: CONTRIBUTION_SYSTEM_PROMPT,
    prompt: buildContributionPrompt(post, theme, expertiseReason, chunks, deps.constraints),
    schema: ContributionResultSchema,
    label: `contribution:${post.tweet_id}`,
    maxTokens: 500,
  });
}
