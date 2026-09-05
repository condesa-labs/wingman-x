import { z } from "zod";
import type { NormalizedPost } from "../../model/post.js";
import type { LLMProvider } from "../../llm/provider.js";
import { SAFETY_PREAMBLE, renderPost } from "../prompts.js";
import { LINE_TYPES } from "../lane.js";

/**
 * Conversational-lane gate. Replaces the expertise + contribution stages for
 * themes where the KB has nothing to say. One question: is there a genuinely
 * good line here, in the energy of the post? No knowledge is retrieved and no
 * fact outside the post itself may appear.
 */
export const LineTypeSchema = z.enum([...LINE_TYPES, "none"]);
export const EnergySchema = z.enum(["shitpost", "casual", "serious"]);

export const LineResultSchema = z.object({
  line_score: z.number().int().min(0).max(100),
  line_type: LineTypeSchema,
  /** The line itself, in one sentence, roughly as it would be said. */
  line: z.string(),
  energy: EnergySchema.default("casual"),
  reason: z.string(),
});
export type LineResult = z.infer<typeof LineResultSchema>;

export const LINE_TYPE_GUIDE: Record<(typeof LINE_TYPES)[number], string> = {
  irony: "irony: name the contradiction or irony already sitting in the post. Dry, one clause, no explanation of the joke.",
  question: "question: ask the one sharp thing that makes them want to answer. Not bait, not rhetorical.",
  thinking_out_loud: "thinking_out_loud: say what everyone reading is thinking and nobody has said. Flat, unhedged.",
  light_reaction: "light_reaction: a short human response, a nod or a dry line. No thesis, no expertise.",
};

export function buildLineSystemPrompt(policy: string, constraints?: string): string {
  return [
    "You judge whether one specific person should reply to a post in a casual, non-expert register. You are not looking for something to teach; you are looking for a good line.",
    "",
    "# Reply policy for this lane",
    policy.trim(),
    "",
    ...(constraints && constraints.trim() ? ["# Hard constraints (identity and boundaries)", constraints.trim(), ""] : []),
    "# How to judge",
    "First name the energy of the post: shitpost, casual, or serious. The reply must match it. An analyst reply to a shitpost, a punchline on something serious, or a résumé in response to a casual observation all fail regardless of cleverness.",
    "Then consider the four reply types and pick the one that fits:",
    ...LINE_TYPES.map((t) => `- ${LINE_TYPE_GUIDE[t]}`),
    "- none: nothing better than generic is available. Use it freely. Silence beats a forced joke.",
    "",
    "Scoring line_score (0-100):",
    "- 90-100: the line is genuinely funny or genuinely sharp, matches the energy, and needs no fact the post does not contain. A real person would be pleased to have thought of it.",
    "- 80-89: good and natural; worth posting; not memorable.",
    "- 60-79: fine but forgettable, or slightly off the post's energy.",
    "- below 60: generic, sycophantic, a reach, or an AI-shaped joke.",
    "Never invent a number, name, date, quote, or event. Every fact in the line comes from the post itself. If the joke needs a fact you do not have, the type is none.",
    "Do not draw on the person's professional expertise unless the expertise IS the joke. This lane is for being a person, not an operator.",
    "Never dunk on someone the person wants a relationship with. Irony is aimed at the situation in the post, not at the author.",
    'Return JSON: {"line_score", "line_type", "line", "energy", "reason"}. Keep reason to one sentence.',
    SAFETY_PREAMBLE,
  ].join("\n");
}

export async function assessLine(
  post: NormalizedPost,
  theme: string,
  deps: { llm: LLMProvider; policy: string; constraints?: string },
): Promise<LineResult> {
  return deps.llm.complete({
    tier: "strong",
    system: buildLineSystemPrompt(deps.policy, deps.constraints),
    prompt: [renderPost(post), "", `Theme: ${theme}`, "", "Is there a good line here? Return the JSON."].join("\n"),
    schema: LineResultSchema,
    label: `line:${post.tweet_id}`,
    maxTokens: 400,
  });
}
