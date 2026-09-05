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
export const ReplyMoveSchema = z.enum([
  "agree_extend",
  "distinction",
  "challenge",
  "operator_context",
  "question",
  "example",
  "light_reaction",
  "none",
]);
export type ReplyMove = z.infer<typeof ReplyMoveSchema>;

export const ReplyDepthSchema = z.enum(["light", "substantive", "deep"]);
export type ReplyDepth = z.infer<typeof ReplyDepthSchema>;

/** What the author is doing in the post. A reasoning step before choosing the move, not a taxonomy. */
export const PostPostureSchema = z.enum([
  "announcement",
  "argument",
  "observation",
  "question",
  "prediction",
  "technical_explanation",
  "personal_update",
  "data_point",
  "other",
]);
export type PostPosture = z.infer<typeof PostPostureSchema>;

export const ContributionResultSchema = z.object({
  contribution_score: z.number().int().min(0).max(100),
  contribution_angle: z.string(),
  reason: z.string(),
  /** The conversational move the reply should make. Defaults keep older fakes/tests valid. */
  move: ReplyMoveSchema.default("agree_extend"),
  depth: ReplyDepthSchema.default("substantive"),
  posture: PostPostureSchema.default("other"),
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
  "First say what the author is doing (posture): announcement, argument, observation, question, prediction, technical_explanation, personal_update, data_point, or other. An announcement and an argument on the same topic call for different replies: an announcement usually earns a question or a light reaction, an argument earns engagement with the claim.",
  "Then consider several materially different conversational moves and pick the one that fits this post best. A move describes the FUNCTION of the reply, never its wording or opening:",
  "- agree_extend: the author is basically right, but you can add a consequence or implication.",
  "- distinction: separating two concepts genuinely changes the conclusion.",
  "- challenge: you materially disagree with an assumption.",
  "- operator_context: firsthand experience adds something the post does not contain (only if an excerpt states the person saw it).",
  "- question: the most valuable contribution is surfacing something unresolved.",
  "- example: one concrete example makes the argument more useful.",
  "- light_reaction: worth engaging, but does not require demonstrating expertise.",
  "- none: anything you would say would be generic, forced, redundant, or attention seeking. Use this freely. No reply is better than a manufactured clever one. A none move must score below 40.",
  "Do not favor distinction or challenge because the knowledge base contains many distinctions. Contrarianism is not inherently higher value. If the author is basically right, build on them rather than manufacture a correction.",
  "Then set depth: light (one short sentence or clause), substantive (one clear point), deep (a technical response leaning on the excerpts). Posture drives the default: announcements, personal updates, and posts under about 100 characters default to light unless the post contains a claim worth engaging; arguments and technical explanations default to substantive; deep is for a technical post that asks for it. Judge each post on its own; never force a distribution.",
  "",
  "Scoring contribution_score (0-100):",
  "- 85-100: a sharp, specific angle grounded in the excerpts that adds something the thread does not have.",
  "- 70-84: a genuinely useful addition, somewhat narrower or less surprising.",
  "- 40-69: possible but thin; the reply would mostly be agreement with a detail.",
  "- 0-39: nothing worth saying.",
  "contribution_angle: ONE sentence stating what the reply would actually say in the chosen move (what it adds, asks, extends, or challenges). A light_reaction angle can be as small as the reaction itself. If the score is low, state the best available angle anyway.",
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
    'Return JSON: {"contribution_score", "contribution_angle", "reason", "move", "depth", "posture"}.',
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
