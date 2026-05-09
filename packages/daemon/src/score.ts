import type { ObservedTweetInput } from "./schemas.js";

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
