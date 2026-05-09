export interface ObservedTweetInput {
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  views: number;
  likes: number;
  retweets: number;
  replies: number;
  bookmarks: number;
  created_at: string;
}

export function extractTweetsFromGraphQLResponse(
  response: unknown,
): ObservedTweetInput[] {
  if (
    !isRecord(response) ||
    (Array.isArray(response.errors) && response.errors.length > 0)
  ) {
    return [];
  }

  const tweets: ObservedTweetInput[] = [];
  const seen = new Set<string>();
  walk(response, (candidate) => {
    const tweet = normalizeTweetResult(candidate);
    if (tweet === null || seen.has(tweet.tweet_id)) return;
    seen.add(tweet.tweet_id);
    tweets.push(tweet);
  });
  return tweets;
}

function walk(value: unknown, visit: (tweetResult: unknown) => void): void {
  if (!isRecord(value)) return;
  const maybeTweetResults = value.tweet_results;
  if (isRecord(maybeTweetResults) && "result" in maybeTweetResults) {
    visit(maybeTweetResults.result);
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) walk(item, visit);
    } else if (isRecord(child)) {
      walk(child, visit);
    }
  }
}

function normalizeTweetResult(value: unknown): ObservedTweetInput | null {
  let tweet = unwrapTweet(value);
  if (tweet === null) return null;
  if (isRecord(tweet.promotedMetadata) || isRecord(tweet.promoted_metadata)) {
    return null;
  }

  const retweeted = readPath(tweet, [
    "legacy",
    "retweeted_status_result",
    "result",
  ]);
  if (retweeted !== undefined) {
    tweet = unwrapTweet(retweeted);
    if (tweet === null) return null;
  }

  const legacy = isRecord(tweet.legacy) ? tweet.legacy : {};
  const tweetId = readString(tweet.rest_id) ?? readString(legacy.id_str);
  const authorHandle =
    readString(readPath(tweet, ["core", "user_results", "result", "legacy", "screen_name"])) ??
    readString(readPath(tweet, ["core", "user_results", "result", "screen_name"])) ??
    readString(readPath(tweet, ["legacy", "user", "screen_name"]));
  const text =
    readString(legacy.full_text) ??
    readString(legacy.text) ??
    readString(tweet.full_text) ??
    "";
  const createdAtRaw = readString(legacy.created_at) ?? readString(tweet.created_at);
  const createdAt = normalizeDate(createdAtRaw);
  const views = readCount(readPath(tweet, ["views", "count"])) ??
    readCount(readPath(tweet, ["view_count_info", "count"])) ??
    readCount(legacy.view_count) ??
    readCount(legacy.views);

  if (
    tweetId === null ||
    authorHandle === null ||
    createdAt === null ||
    views === null
  ) {
    return null;
  }

  return {
    tweet_id: tweetId,
    tweet_url: `https://x.com/${authorHandle}/status/${tweetId}`,
    author_handle: authorHandle,
    tweet_text: text,
    views,
    likes: readCount(legacy.favorite_count) ?? 0,
    retweets: readCount(legacy.retweet_count) ?? 0,
    replies: readCount(legacy.reply_count) ?? 0,
    bookmarks: readCount(legacy.bookmark_count) ?? 0,
    created_at: createdAt,
  };
}

function unwrapTweet(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const typename = readString(value.__typename);
  if (
    typename === "TweetTombstone" ||
    typename === "TweetUnavailable" ||
    typename === "TweetWithVisibilityResultsUnavailable"
  ) {
    return null;
  }
  if (typename === "TweetWithVisibilityResults" && isRecord(value.tweet)) {
    return unwrapTweet(value.tweet);
  }
  return value;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

function normalizeDate(value: string | null): string | null {
  if (value === null) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
