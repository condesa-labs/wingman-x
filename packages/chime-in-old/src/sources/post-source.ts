import type { NormalizedPost } from "../model/post.js";
import type { WatchAccount } from "../watchlist.js";

export interface FetchOptions {
  maxPostsPerAccount: number;
  includeReplies: boolean;
  includeReposts: boolean;
}

export interface AccountFetchResult {
  handle: string;
  ok: boolean;
  posts: number;
  error?: string;
}

export interface FetchPostsResult {
  source: string;
  posts: NormalizedPost[];
  accounts: AccountFetchResult[];
  /** Raw items received before normalisation / filtering (for the log). */
  raw_count: number;
}

/**
 * The ingestion seam. Apify is one implementation; an official X
 * Filtered Stream adapter is a future one. Implementations must:
 *   - never throw for a single account's failure (report it in
 *     `accounts[]` and keep going),
 *   - return posts newer than `since` where the backend allows it (the
 *     pipeline re-checks client-side anyway),
 *   - emit only `NormalizedPost` — no backend response shapes leak.
 */
export interface PostSource {
  readonly name: string;
  fetchPosts(
    accounts: WatchAccount[],
    since: Date,
    opts: FetchOptions,
  ): Promise<FetchPostsResult>;
}
