import { z } from "zod";
import { detectAiTells } from "@wingman-x/agent-kit";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import type { ReplyDepth, ReplyMove } from "./contribution.js";
import { LINE_TYPE_GUIDE } from "./line.js";
import type { Lane, LineType } from "../lane.js";
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

/**
 * The voice is sentence case, but the model imitates the lowercase quotes in
 * the tone guide and the lowercase replies in its own history. Rather than
 * fight that with more prompt, normalise: capitalise sentence starts and the
 * pronoun "I". Nothing else is touched, so tickers and brand names keep the
 * case the model gave them.
 */
export function toSentenceCase(text: string): string {
  let out = text.replace(/(^|[.!?]\s+|\n\s*)([a-z])/g, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  out = out.replace(/(^|[^A-Za-z0-9$@#])i(?=$|[^A-Za-z0-9])/g, "$1I");
  out = out.replace(/(^|[^A-Za-z0-9$@#])i(?=['’](m|d|ve|ll)\b)/g, "$1I");
  return out;
}

/**
 * Concede-then-pivot openers ("agree, though", "fair, but", "yes, and").
 * Legitimate once; a tic when every reply in a scan starts that way.
 */
export const CONCEDE_OPENER_RE = /^\W*(agree(d)?|fair( enough)?|true|right|yes|yep|sure|correct)\b/i;

export function hasConcedeOpener(text: string): boolean {
  return CONCEDE_OPENER_RE.test(text);
}

export function buildDraftSystemPrompt(
  tone: string,
  maxChars: number,
  constraints?: string,
  lane: Lane = "expertise",
  policy?: string,
): string {
  if (lane === "conversational") {
    return [
      "You draft a reply on X on behalf of a specific person, in a casual, non-expert register. Write in their voice, following the tone guide below for register and rhythm.",
      "",
      "# Tone guide",
      tone.trim(),
      "",
      "Preserve natural roughness where the tone guide shows it: fragments, contractions, comma-spliced clauses. Write in sentence case. Never copy wording from the example replies; match the behavior and rhythm.",
      "",
      ...(constraints && constraints.trim() ? ["# Hard constraints (override everything else)", constraints.trim(), ""] : []),
      "# Reply policy for this lane",
      (policy ?? "").trim(),
      "",
      "# How to write it",
      "1. Read the post and name its energy: shitpost, casual, or serious. Match it. That is the whole job.",
      "2. Write the given line in the given reply type, the way this person would type it in ten seconds. One sentence, sometimes two.",
      "3. Check: every fact in the reply is in the post itself. No number, name, date, or event from anywhere else. No professional expertise unless the expertise is the joke. No résumé.",
      "4. Do not explain the joke. Do not add a second thought. Stop.",
      "",
      "# Non-negotiable rules",
      "- No praise openers, no agreement fillers, no engagement bait, no plugging.",
      "- Aim irony at the situation, never at the author.",
      `- Hard length limit: ${maxChars} characters. Casual replies are usually well under half that.`,
      "- No hashtags. No emoji unless one emoji is the whole reply. Do not address the author by name or handle.",
      "- No em dashes, en dashes, or spaced hyphens used as dashes.",
      SAFETY_PREAMBLE,
    ].join("\n");
  }
  return [
    "You draft a reply on X on behalf of a specific person. Write in their voice, following the tone guide below exactly.",
    "",
    "# Tone guide",
    tone.trim(),
    "",
    "Preserve natural roughness where the tone guide shows it: fragments, contractions, comma-spliced clauses. Write in sentence case: the quoted @mdudas replies are lowercase because that is how he types, and that is not inherited. Do not polish into brand copy, and do not manufacture errors. Never copy wording from the example replies; match the behavior and rhythm.",
    "",
    ...(constraints && constraints.trim()
      ? ["# Hard constraints (override everything else, including a sharper reply)", constraints.trim(), ""]
      : []),
    "# How to write it",
    "1. Read the post and understand what the author is actually saying, before looking at the excerpts.",
    "2. Write the most natural reaction this person would have, in the given move and depth, as if they already held the views in the excerpts.",
    "3. Then check the excerpts. They may change the substance of the reaction if they show it is wrong, unsupported, or missing an important fact, and they can sharpen it with a fact or example. They must not be mined for a clever framework to deploy. Do not introduce a framework, lens, or distinction merely because it was retrieved, and do not let an excerpt supply the opening line.",
    "4. Say it in plain words. Never name a lens or use taxonomy labels; at most one term of art per reply. The move names the function of the reply, not its syntax: never start from a stock phrase for the move.",
    "5. Write it the way this person would type it in twenty seconds, then stop. That is usually one or two sentences, sometimes one clause. Stop when the point is made; if one sentence says it, one sentence is the reply. Do not compress what you wrote into maxims, and do not pad it toward the cap. One ordinary, unpolished clause per reply is normal.",
    "",
    "# Non-negotiable rules",
    "- Respond to the actual argument in the post. Add something; never summarise or restate it.",
    "- Follow the given move. If the move is agree_extend, do not manufacture a correction. If it is light_reaction, keep it to one short, human sentence. If it is question, ask the one question the person genuinely wants answered.",
    "- Use only the knowledge base excerpts (and the post itself) for facts, examples and opinions. NEVER invent personal experience, numbers, names, or deals. If an excerpt does not explicitly say the person did or saw something, do not claim it.",
    "- No generic agreement, no praise openers, no engagement bait, no questions asked only to seem engaged.",
    "- Where the angle challenges the author, do it respectfully and specifically.",
    "- Prefer clarity over cleverness. Plain words. One point, made well.",
    `- Hard length limit: ${maxChars} characters. That is the only length rule: use what the point needs and do not compress below it.`,
    "- No hashtags. No emoji unless the tone guide asks for them. Do not address the author by name or handle.",
    "- No em dashes, en dashes, or spaced hyphens used as dashes. Use a period, a comma, a colon, or 'so'.",
    SAFETY_PREAMBLE,
  ].join("\n");
}

export const DEPTH_GUIDE: Record<ReplyDepth, string> = {
  light: "light: one clause or one short sentence, well under 100 characters. A reaction, a question, or a small extension. No mechanism required.",
  substantive: "substantive: one clear point in one or two sentences, typically 100 to 180 characters. If one sentence says it, stop there.",
  deep: "deep: a technical response grounded in the excerpts. The only depth that should approach the hard cap. Still one point.",
};

/** Moves describe the function of the reply. They are conceptual categories, not templates. */
export const MOVE_GUIDE: Record<ReplyMove, string> = {
  agree_extend: "agree_extend: the author is basically right, and you add a consequence or implication they did not draw. No correction.",
  distinction: "distinction: separating two concepts genuinely changes the conclusion. Say what changes, in plain words.",
  challenge: "challenge: you materially disagree with one assumption. Say which, and why, respectfully.",
  operator_context: "operator_context: firsthand experience adds something the post does not contain. One clause, only as the excerpts state it.",
  question: "question: the most valuable contribution is surfacing something unresolved. The question is the reply.",
  example: "example: one concrete example makes the argument more useful. Bring it from the excerpts or the post.",
  light_reaction: "light_reaction: worth engaging, but it does not require demonstrating expertise. A short human response.",
  none: "none: this should not have reached drafting; write the smallest honest reply.",
};

export function buildDraftPrompt(args: {
  post: NormalizedPost;
  theme: string;
  angle: string;
  chunks: KBChunk[];
  move?: ReplyMove;
  depth?: ReplyDepth;
  /** What the author is doing (announcement, argument, question ...). */
  posture?: string;
  /** Moves already used nearby (previous candidate, or rejected drafts). Soft: vary construction, never downgrade the move. */
  avoidMoves?: ReplyMove[];
  previousReplies?: string[];
  shortenFrom?: string;
  fixDashesFrom?: string;
  fixContrastFrom?: string;
  fixOpenerFrom?: string;
  /** A nearby reply already opened by conceding; this one should not. */
  avoidConcedeOpener?: boolean;
  /** "short": the recent replies all ran long, or this is the short variant. */
  lengthNudge?: "short";
  lane?: Lane;
  lineType?: LineType;
  energy?: string;
  maxChars: number;
  /** Recently sent replies, so the drafter knows what has just been said. */
  editorial?: string;
  /** Replies already drafted in this scan — do not repeat their point. */
  avoidPoints?: string[];
}): string {
  const move = args.move ?? "agree_extend";
  const depth = args.depth ?? "substantive";
  const conversational = args.lane === "conversational";
  const lines = [
    renderPost(args.post),
    "",
    `Theme: ${args.theme}`,
    ...(conversational
      ? [
          `Energy of the post: ${args.energy ?? "casual"}. Match it.`,
          `Reply type: ${args.lineType ? LINE_TYPE_GUIDE[args.lineType] : "light_reaction"}`,
          `The line: ${args.angle}`,
        ]
      : [
          ...(args.posture ? [`What the author is doing: ${args.posture.replace(/_/g, " ")}`] : []),
          `Move: ${MOVE_GUIDE[move]}`,
          `Depth: ${DEPTH_GUIDE[depth]}`,
          `What the reply should say: ${args.angle}`,
        ]),
    ...(args.avoidConcedeOpener
      ? ["A nearby reply already opens by agreeing or conceding before it pivots. Do not open that way here; start with the point itself."]
      : []),
    ...(args.lengthNudge === "short"
      ? ["Make this one SHORT: one sentence, or one clause if the point survives it. Under 120 characters. The recent replies have all run long and a person does not write every reply at the same length."]
      : []),
    ...(args.avoidMoves && args.avoidMoves.length > 0
      ? [
          `A nearby reply in this scan used the same move (${Array.from(new Set(args.avoidMoves)).join(", ")}). Keep the move if it is the right one; vary the construction so the set does not read as one template.`,
        ]
      : []),
    ...(conversational
      ? []
      : ["", "Knowledge base excerpts (grounding only: check and enrich, do not recite, do not let them supply the opening):", renderExcerpts(args.chunks)]),
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
      "The other replies in this same scan will make these points (given as angles or drafts). Make a different point, or approach from a different mechanism, so the set does not read as one argument repeated:",
      ...args.avoidPoints.map((r, i) => `<other_reply n="${i + 1}">\n${r}\n</other_reply>`),
    );
  }
  if (args.previousReplies && args.previousReplies.length > 0) {
    lines.push(
      "",
      "The person rejected these earlier drafts. Produce a MEANINGFULLY different reply in the move given above: a different opening, a different structure, and where possible a different supporting point. Do not paraphrase them, and do not drift to a weaker version of the same argument.",
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
  if (args.fixOpenerFrom) {
    lines.push(
      "",
      "This draft opens by conceding or agreeing before it pivots, and a nearby reply already did that. Rewrite it with the same content so the first clause is the point itself:",
      `<concede_opener>\n${args.fixOpenerFrom}\n</concede_opener>`,
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
  move?: ReplyMove;
  depth?: ReplyDepth;
  posture?: string;
  avoidMoves?: ReplyMove[];
  avoidConcedeOpener?: boolean;
  lengthNudge?: "short";
  lane?: Lane;
  /** Conversational-lane policy text (kb/conversational.md). */
  policy?: string;
  lineType?: LineType;
  energy?: string;
  llm: LLMProvider;
}): Promise<DraftOutcome> {
  const system = buildDraftSystemPrompt(args.tone, args.maxChars, args.constraints, args.lane ?? "expertise", args.policy);
  let reply = "";
  let attempts = 0;
  let shortenFrom: string | undefined;
  let fixDashesFrom: string | undefined;
  let fixContrastFrom: string | undefined;
  let fixOpenerFrom: string | undefined;
  let openerRewrites = 0;
  let shortenRounds = 0;
  const MAX_ATTEMPTS = 4;
  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    // Each shorten rewrite asks for a tighter target than the hard cap so
    // the model lands inside it instead of grazing it again.
    const target = shortenRounds === 0 ? args.maxChars : Math.max(60, args.maxChars - 40 * shortenRounds);
    const kind = shortenFrom ? ":shorten" : fixDashesFrom ? ":dashes" : fixContrastFrom ? ":contrast" : fixOpenerFrom ? ":opener" : "";
    const res = await args.llm.complete({
      tier: "draft",
      system,
      prompt: buildDraftPrompt({ ...args, shortenFrom, fixDashesFrom, fixContrastFrom, fixOpenerFrom, maxChars: target }),
      schema: DraftResultSchema,
      label: `draft:${args.post.tweet_id}${kind}`,
      maxTokens: 500,
    });
    reply = toSentenceCase(res.suggested_reply.trim());
    shortenFrom = undefined;
    fixDashesFrom = undefined;
    fixContrastFrom = undefined;
    fixOpenerFrom = undefined;
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
      if (args.avoidConcedeOpener && openerRewrites === 0 && hasConcedeOpener(reply)) {
        openerRewrites += 1;
        fixOpenerFrom = reply;
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
