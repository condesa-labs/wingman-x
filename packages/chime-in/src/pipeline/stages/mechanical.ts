import type { NormalizedPost } from "../../model/post.js";

/**
 * Stage 1 — mechanical filtering. Zero model calls. Everything here is a
 * cheap, explainable rule; the reason string ends up in the processed log.
 */
export type MechanicalReason = "repost" | "reply" | "seen" | "empty" | "spam";

export interface MechanicalOptions {
  includeReplies: boolean;
  includeReposts: boolean;
  seen: (tweetId: string) => boolean;
}

const SPAM_PHRASES =
  /\b(giveaway|airdrop|whitelist|presale|pre-sale|mint(?:ing)? (?:is )?(?:now )?live|dm me|dm us|join (?:my|our) (?:telegram|discord)|use code|promo code|discount code|\d{1,3}% off|link in bio|limited spots|sign up (?:now|today)|register (?:now|today)|claim your|free (?:tokens?|nft|crypto)|guaranteed returns?|100x|1000x)\b/i;

export function stripUrlsAndMentions(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/(^|\s)@\w+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heuristic promotional-spam detector. Tuned for precision, not recall. */
export function isPromotionalSpam(text: string): boolean {
  const hashtags = (text.match(/(^|\s)#\w+/g) ?? []).length;
  const cashtags = (text.match(/(^|\s)\$[A-Za-z]{2,6}\b/g) ?? []).length;
  const stripped = stripUrlsAndMentions(text);
  if (hashtags >= 4) return true;
  if (cashtags >= 3) return true;
  if (SPAM_PHRASES.test(text)) return true;
  // Emoji-heavy hype with little text.
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emoji >= 5 && stripped.length < 120) return true;
  return false;
}

export function mechanicalFilter(
  post: NormalizedPost,
  opts: MechanicalOptions,
): { pass: true } | { pass: false; reason: MechanicalReason } {
  if (opts.seen(post.tweet_id)) return { pass: false, reason: "seen" };
  if (post.is_repost && !opts.includeReposts) return { pass: false, reason: "repost" };
  if (post.is_reply && !opts.includeReplies) return { pass: false, reason: "reply" };
  const body = stripUrlsAndMentions(post.tweet_text);
  const quoted = post.quoted_tweet?.text ?? "";
  if (body.length < 15 && quoted.trim().length < 15) return { pass: false, reason: "empty" };
  if (isPromotionalSpam(post.tweet_text)) return { pass: false, reason: "spam" };
  return { pass: true };
}
