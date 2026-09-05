import type { Config } from "../config.js";

/**
 * Two lanes, two questions. Expertise: "do I know something worth adding?"
 * (KB retrieval, expertise gate, KB-grounded drafting). Conversational:
 * "do I just have a good line here?" (no KB, a line gate, energy matching).
 * A post's theme decides the lane; the theme classifier is told that an
 * expertise theme wins whenever a post fits both.
 */
export type Lane = "expertise" | "conversational";

type LaneConfig = Pick<Config, "conversationalThemes" | "conversationalStrictThemes" | "conversationalThreshold">;

const norm = (s: string): string => s.trim().toLowerCase();

export function laneForTheme(theme: string, config: Pick<Config, "conversationalThemes">): Lane {
  const t = norm(theme);
  return config.conversationalThemes.some((c) => norm(c) === t) ? "conversational" : "expertise";
}

/**
 * In the conversational lane, subject matter does not earn entry; the author
 * does. Priority 1 accounts are eligible everywhere. Priority 2 accounts are
 * eligible at the normal bar, except on "strict" themes (general culture)
 * where the line has to be exceptional. Priority 3 accounts get expertise
 * replies only.
 */
export function conversationalEligibility(
  priority: 1 | 2 | 3,
  theme: string,
  config: LaneConfig,
): { eligible: boolean; threshold: number; reason?: string } {
  const strict = config.conversationalStrictThemes.some((c) => norm(c) === norm(theme));
  if (priority === 3) return { eligible: false, threshold: 101, reason: "priority 3 account: expertise replies only" };
  if (priority === 2 && strict) return { eligible: true, threshold: Math.min(100, config.conversationalThreshold + 10) };
  return { eligible: true, threshold: config.conversationalThreshold };
}

/** The reply types of the conversational lane. "context" from the original skill is deliberately absent: it invites fabrication without a KB. */
export const LINE_TYPES = ["irony", "question", "thinking_out_loud", "light_reaction"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export function isLineType(v: string): v is LineType {
  return (LINE_TYPES as readonly string[]).includes(v);
}

/** Next unused type, in preference order, for variants and regen. */
export function nextLineType(used: readonly string[]): LineType {
  const u = new Set(used);
  return LINE_TYPES.find((t) => !u.has(t)) ?? "light_reaction";
}
