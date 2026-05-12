import type { ObservedTweetInput } from "./schemas.js";

export interface NoveltyContext {
  /** Handles already in Tier 1 (directly scraped every run). */
  tier1Handles: ReadonlySet<string>;
  /** Handles that already have candidates in state (already seen). */
  candidateHandles: ReadonlySet<string>;
}

export function computeScore(
  input: Pick<
    ObservedTweetInput,
    | "views"
    | "likes"
    | "retweets"
    | "replies"
    | "bookmarks"
    | "created_at"
  >,
  now: Date = new Date(),
): number {
  const createdAt = new Date(input.created_at);
  const ageHours = Math.max(
    (now.getTime() - createdAt.getTime()) / 3_600_000,
    0.1,
  );
  const velocity = input.views / ageHours;
  const velocityScore = Math.min(velocity / 50_000, 1) * 40;
  const engagementRate =
    input.views > 0
      ? (input.likes + input.retweets + input.replies) / input.views
      : 0;
  const engagementScore = Math.min(engagementRate / 0.1, 1) * 25;
  const rtRatio = input.retweets / Math.max(input.likes, 1);
  const rtScore = Math.min(rtRatio / 0.5, 1) * 20;
  const bmRatio = input.bookmarks / Math.max(input.likes, 1);
  const bmScore = Math.min(bmRatio / 0.3, 1) * 15;

  return Math.max(
    0,
    Math.min(
      100,
      Math.round(velocityScore + engagementScore + rtScore + bmScore),
    ),
  );
}

/**
 * Query-time novelty adjustment applied when ranking tweet_pool entries.
 * Returns a bonus (0–20) that rewards tweets from unfamiliar sources.
 *
 * - Author NOT in Tier 1 AND NOT in existing candidates → +20 (fully novel)
 * - Author NOT in Tier 1 BUT already has candidates → +8 (known but not core)
 * - Author in Tier 1 → +0 (already scraped directly, no novelty)
 */
export function computeNoveltyBonus(
  authorHandle: string,
  ctx: NoveltyContext,
): number {
  const normalized = authorHandle.startsWith("@")
    ? authorHandle.toLowerCase()
    : `@${authorHandle}`.toLowerCase();

  const inTier1 = ctx.tier1Handles.has(normalized);
  if (inTier1) return 0;

  const hasCandidate = ctx.candidateHandles.has(normalized);
  return hasCandidate ? 8 : 20;
}
