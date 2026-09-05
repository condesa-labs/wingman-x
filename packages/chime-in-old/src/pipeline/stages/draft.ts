import { z } from "zod";
import { detectAiTells } from "@wingman-x/agent-kit";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { renderExcerpts, type KBChunk } from "../../kb/kb-index.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";

/**
 * Stage 5 — draft one primary reply (and regenerate on request). The
 * tone guide is the system prompt; the contribution angle tells the
 * model what the reply is FOR; the KB excerpts are the only permitted
 * source of first-person claims.
 */
export const DraftResultSchema = z.object({
  suggested_reply: z.string().min(1),
  /** Model's own note on which excerpt(s) it leaned on; not shown to the user. */
  grounding: z.string().optional(),
});
export type DraftResult = z.infer<typeof DraftResultSchema>;

export interface DraftOutcome {
  suggested_reply: string;
  ai_tell_flags: string[];
  attempts: number;
}

/**
 * Em/en dashes and spaced hyphens used as dashes. The user's voice spec bans
 * them (measured ~0% across their reference authors) and Wingman's detector
 * does not cover them, so we check locally and ask for a rewrite.
 */
export const DASH_RE = /[–—]|\s-\s/;

export function hasDashTell(text: string): boolean {
  return DASH_RE.test(text);
}

/**
 * "isn't X, it's Y" and its cousins ("not X, but Y", "X isn't A, it's B").
 * Wingman's detector covers "it's not X, it's Y" and "not X, but Y" with a
 * single word; this catches the contracted and multi-word forms the drafter
 * actually produces. The voice spec bans the whole family.
 */
export const CONTRASTIVE_RE =
  /\b(?:isn['’]t|aren['’]t|wasn['’]t|weren['’]t|is not|are not|was not|not)\b[^.?!\n]{1,80}?,\s*(?:it['’]s|they['’]re|that['’]s|but)\b/i;

export function hasContrastiveTell(text: string): boolean {
  return CONTRASTIVE_RE.test(text);
}

export function buildDraftSystemPrompt(tone: string, maxChars: number, constraints?: string): string {
  return [
    "You draft a reply on X on behalf of a specific person. Write in their voice, following the tone guide below exactly.",
    "",
    "# Tone guide",
    tone.trim(),
    "",
    "Preserve natural roughness where the tone guide shows it: fragments, contractions, lowercase openings. Do not polish into brand copy, and do not manufacture errors. Never copy wording from the example replies; match the behavior and rhythm.",
    "",
    ...(constraints && constraints.trim()
      ? ["# Hard constraints (override everything else, including a sharper reply)", constraints.trim(), ""]
      : []),
    "# Non-negotiable rules",
    "- Respond directly to the actual argument in the post. Add something; never summarise or restate it.",
    "- Build the reply around the given contribution angle.",
    "- Use only the knowledge base excerpts for facts, examples and opinions. NEVER invent personal experience, numbers, names, or deals. If an excerpt does not explicitly say the person did or saw something, do not claim it.",
    "- No generic agreement, no praise openers, no engagement bait, no questions asked only to seem engaged.",
    "- Where the angle challenges the author, do it respectfully and specifically.",
    "- Prefer clarity over cleverness. Plain words. One point, made well.",
    `- Hard length limit: ${maxChars} characters. Aim well under it unless the tone guide says otherwise.`,
    "- No hashtags. No emoji unless the tone guide asks for them. Do not address the author by name or handle.",
    "- No em dashes, en dashes, or spaced hyphens used as dashes. Use a period, a comma, a colon, or 'so'.",
    SAFETY_PREAMBLE,
  ].join("\n");
}

export function buildDraftPrompt(args: {
  post: NormalizedPost;
  theme: string;
  angle: string;
  chunks: KBChunk[];
  previousReplies?: string[];
  shortenFrom?: string;
  fixDashesFrom?: string;
  fixContrastFrom?: string;
  maxChars: number;
  /** Recently sent replies, so the drafter knows what has just been said. */
  editorial?: string;
  /** Replies already drafted in this scan — do not repeat their point. */
  avoidPoints?: string[];
}): string {
  const lines = [
    `Theme: ${args.theme}`,
    `Contribution angle: ${args.angle}`,
    "",
    renderPost(args.post),
    "",
    "Knowledge base excerpts (the only permitted source of claims):",
    renderExcerpts(args.chunks),
  ];
  if (args.editorial && args.editorial.trim()) {
    lines.push(
      "",
      "Recently sent replies. Do not recycle their point unless this post introduces a genuinely different mechanism or implication:",
      args.editorial.trim(),
    );
  }
  if (args.avoidPoints && args.avoidPoints.length > 0) {
    lines.push(
      "",
      "Replies already drafted in this same scan. Make a different point, or approach from a different mechanism, so the set does not read as one argument repeated:",
      ...args.avoidPoints.map((r, i) => `<already_drafted n="${i + 1}">\n${r}\n</already_drafted>`),
    );
  }
  if (args.previousReplies && args.previousReplies.length > 0) {
    lines.push(
      "",
      "The person rejected these earlier drafts. Produce a MEANINGFULLY different reply: a different opening, a different structure, and ideally a different supporting point from the excerpts. Do not paraphrase them.",
      ...args.previousReplies.map((r, i) => `<rejected_draft n="${i + 1}">\n${r}\n</rejected_draft>`),
    );
  }
  if (args.shortenFrom) {
    lines.push(
      "",
      `This draft is too long (${args.shortenFrom.length} characters). Rewrite it under ${args.maxChars} characters, keeping the same point:`,
      `<too_long>\n${args.shortenFrom}\n</too_long>`,
    );
  }
  if (args.fixDashesFrom) {
    lines.push(
      "",
      "This draft uses dashes (em dash, en dash, or a spaced hyphen), which this person never uses. Rewrite it with the same point and no dashes at all. Split into two sentences or use a comma or colon:",
      `<has_dashes>\n${args.fixDashesFrom}\n</has_dashes>`,
    );
  }
  if (args.fixContrastFrom) {
    lines.push(
      "",
      "This draft uses the \"isn't X, it's Y\" / \"not X, but Y\" construction, which this person's voice guide bans as an AI tell. Rewrite with the same point as two flat statements (say what it IS; drop the negated half, or put it in its own sentence without the contrast):",
      `<has_contrast>\n${args.fixContrastFrom}\n</has_contrast>`,
    );
  }
  lines.push("", 'Return JSON: {"suggested_reply", "grounding"}.');
  return lines.join("\n");
}

export async function draftReply(args: {
  post: NormalizedPost;
  theme: string;
  angle: string;
  chunks: KBChunk[];
  tone: string;
  maxChars: number;
  previousReplies?: string[];
  /** Text of KB constraint files (e.g. library/boundaries.md). */
  constraints?: string;
  editorial?: string;
  avoidPoints?: string[];
  llm: LLMProvider;
}): Promise<DraftOutcome> {
  const system = buildDraftSystemPrompt(args.tone, args.maxChars, args.constraints);
  let reply = "";
  let attempts = 0;
  let shortenFrom: string | undefined;
  let fixDashesFrom: string | undefined;
  let fixContrastFrom: string | undefined;
  let shortenRounds = 0;
  const MAX_ATTEMPTS = 4;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    // Each shorten rewrite asks for a tighter target than the hard cap so
    // the model lands inside it instead of grazing it again.
    const target = shortenRounds === 0 ? args.maxChars : Math.max(60, args.maxChars - 40 * shortenRounds);
    const kind = shortenFrom ? ":shorten" : fixDashesFrom ? ":dashes" : fixContrastFrom ? ":contrast" : "";
    const res = await args.llm.complete({
      tier: "draft",
      system,
      prompt: buildDraftPrompt({ ...args, shortenFrom, fixDashesFrom, fixContrastFrom, maxChars: target }),
      schema: DraftResultSchema,
      label: `draft:${args.post.tweet_id}${kind}`,
      maxTokens: 500,
    });
    reply = res.suggested_reply.trim();
    shortenFrom = undefined;
    fixDashesFrom = undefined;
    fixContrastFrom = undefined;
    if ([...reply].length > args.maxChars) {
      shortenRounds += 1;
      shortenFrom = reply;
      continue;
    }
    if (attempts < MAX_ATTEMPTS) {
      if (hasDashTell(reply)) {
        fixDashesFrom = reply;
        continue;
      }
      if (hasContrastiveTell(reply)) {
        fixContrastFrom = reply;
        continue;
      }
    }
    break;
  }
  if ([...reply].length > args.maxChars) {
    throw new Error(`draft for ${args.post.tweet_id} still exceeds ${args.maxChars} chars after ${attempts - 1} rewrites`);
  }
  const flags = detectAiTells(reply);
  // Tells that survived the rewrite budget are surfaced, not silently shipped.
  if (hasDashTell(reply)) flags.push("dash");
  if (hasContrastiveTell(reply) && !flags.includes("contrastive-en")) flags.push("contrastive-en");
  return { suggested_reply: reply, ai_tell_flags: flags, attempts };
}
