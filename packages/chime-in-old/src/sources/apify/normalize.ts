import {
  NormalizedPostSchema,
  canonicalTweetUrl,
  type NormalizedPost,
  type QuotedPost,
} from "../../model/post.js";

/**
 * Tolerant mapping from an Apify dataset item to `NormalizedPost`.
 *
 * Supports the `apidojo/*` tweet scrapers (`id`, `url`, `text`, `author.userName`,
 * `createdAt` in Twitter's "Fri Nov 24 17:49:36 +0000 2023" format, `isReply`,
 * `isRetweet`, `quote`) and simpler feed scrapers (`handle`, `text`, `likes`,
 * `retweets`, `replies`, `isRetweet`, `isReply`). Unknown shapes that still
 * carry an id + text + handle also work. Returns `null` for anything we
 * cannot map to a valid post (including apidojo's `mock_tweet` filler items).
 */
type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.trunc(v));
  if (typeof v === "string") {
    const n = Number(v.replace(/[,_\s]/g, ""));
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  return 0;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function first<T>(...vals: Array<T | undefined>): T | undefined {
  for (const v of vals) if (v !== undefined) return v;
  return undefined;
}

const STATUS_URL_RE = /(?:twitter|x)\.com\/([^/]+)\/status\/(\d+)/i;

function parseStatusUrl(url: string | undefined): { handle: string; id: string } | null {
  if (!url) return null;
  const m = STATUS_URL_RE.exec(url);
  if (!m?.[1] || !m[2]) return null;
  return { handle: m[1], id: m[2] };
}

function authorHandle(raw: Rec): string | undefined {
  const author = isRec(raw.author) ? raw.author : undefined;
  const user = isRec(raw.user) ? raw.user : undefined;
  const h = first(
    str(author?.userName),
    str(author?.username),
    str(author?.screen_name),
    str(author?.screenName),
    str(raw.handle),
    str(raw.username),
    str(raw.userName),
    str(user?.screen_name),
    str(user?.username),
    str(raw.author_handle),
    str(raw.authorHandle),
  );
  return h?.replace(/^@/, "");
}

function authorName(raw: Rec): string {
  const author = isRec(raw.author) ? raw.author : undefined;
  const user = isRec(raw.user) ? raw.user : undefined;
  return first(str(author?.name), str(raw.name), str(user?.name), str(raw.author_name), str(raw.authorName)) ?? "";
}

function toIso(v: unknown, fallback: string): string {
  const s = str(v);
  if (!s) return fallback;
  let t = Date.parse(s);
  // "2026-09-04 20:01:23+00:00" (space separator) is not universally parseable.
  if (!Number.isFinite(t)) t = Date.parse(s.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/, "$1T$2"));
  if (Number.isFinite(t)) return new Date(t).toISOString();
  return fallback;
}

function quoted(raw: Rec): QuotedPost | null {
  // Flat shape (delicious_zebu): quotedText / quotedAuthorHandle / quotedTweetId.
  const flatText = str(raw.quotedText);
  if (flatText && flatText.trim().length > 0) {
    const out: QuotedPost = { text: flatText };
    const id = str(raw.quotedTweetId);
    if (id) out.tweet_id = id;
    const h = str(raw.quotedAuthorHandle)?.replace(/^@/, "");
    if (h) out.author_handle = h;
    return out;
  }
  const q = first(raw.quote, raw.quoted_tweet, raw.quotedTweet, raw.quoted_status);
  if (!isRec(q)) return null;
  const text = first(str(q.fullText), str(q.full_text), str(q.text));
  if (!text) return null;
  const out: QuotedPost = { text };
  const id = first(str(q.id), str(q.id_str), str(q.tweet_id));
  if (id) out.tweet_id = id;
  const h = authorHandle(q);
  if (h) out.author_handle = h;
  return out;
}

export function normalizeApifyItem(raw: unknown, scrapedAt: string): NormalizedPost | null {
  if (!isRec(raw)) return null;
  // apidojo emits `{type: "mock_tweet"}` padding when a query has too few
  // results; anything typed and not a tweet is noise.
  if (typeof raw.type === "string" && raw.type !== "tweet") return null;

  const url = first(str(raw.url), str(raw.twitterUrl), str(raw.tweetUrl), str(raw.tweet_url), str(raw.link));
  const fromUrl = parseStatusUrl(url);
  const id = first(str(raw.id), str(raw.id_str), str(raw.tweet_id), str(raw.tweetId), fromUrl?.id);
  const handle = first(authorHandle(raw), fromUrl?.handle);
  const text = first(str(raw.fullText), str(raw.full_text), str(raw.text), str(raw.content)) ?? "";
  if (!id || !handle) return null;

  const retweeted = first(raw.retweeted_tweet, raw.retweetedTweet);
  const isRepost =
    first(bool(raw.isRetweet), bool(raw.is_retweet)) ??
    (isRec(retweeted) || /^RT @\w+:/.test(text));
  const inReplyTo = first(str(raw.inReplyToId), str(raw.inReplyToTweetId), str(raw.in_reply_to_status_id), str(raw.inReplyToStatusId), str(raw.in_reply_to_status_id_str));
  const isReply = first(bool(raw.isReply), bool(raw.is_reply)) ?? (inReplyTo !== undefined && inReplyTo !== "");
  const q = quoted(raw);
  const isQuote = first(bool(raw.isQuote), bool(raw.is_quote)) ?? q !== null;

  const candidate = {
    tweet_id: id,
    tweet_url: fromUrl ? canonicalTweetUrl(fromUrl.handle, fromUrl.id) : canonicalTweetUrl(handle, id),
    author_handle: handle,
    author_name: authorName(raw),
    tweet_text: text,
    created_at: toIso(first(raw.createdAt, raw.created_at, raw.date, raw.timestamp), scrapedAt),
    reply_count: num(first(raw.replyCount, raw.reply_count, raw.replies)),
    repost_count: num(first(raw.retweetCount, raw.retweet_count, raw.retweets, raw.repostCount)),
    like_count: num(first(raw.likeCount, raw.like_count, raw.likes, raw.favorite_count)),
    view_count: num(first(raw.viewCount, raw.view_count, raw.views, raw.impressions)),
    quoted_tweet: q,
    is_reply: isReply,
    is_repost: isRepost,
    is_quote: isQuote,
    lang: str(raw.lang),
    scraped_at: scrapedAt,
  };
  const parsed = NormalizedPostSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function normalizeApifyItems(items: unknown[], scrapedAt: string): NormalizedPost[] {
  const out: NormalizedPost[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const post = normalizeApifyItem(item, scrapedAt);
    if (post === null || seen.has(post.tweet_id)) continue;
    seen.add(post.tweet_id);
    out.push(post);
  }
  return out;
}
