import { readFile } from "node:fs/promises";
import { NormalizedPostSchema, type NormalizedPost } from "../model/post.js";
import { normalizeApifyItems } from "./apify/normalize.js";
import type { FetchPostsResult, PostSource } from "./post-source.js";
import { applyClientSideBounds } from "./apify/apify-source.js";

/**
 * Reads posts from a local JSON file — either a raw Apify dataset dump
 * (array of items) or `{ "posts": NormalizedPost[] }`. Used for tests,
 * dry runs without an Apify token, and replaying a saved scan.
 */
export function createFixtureSource(
  path: string,
  options: { now?: () => Date; restrictToWatchlist?: boolean } = {},
): PostSource {
  const now = options.now ?? (() => new Date());
  const restrict = options.restrictToWatchlist ?? true;

  return {
    name: `fixture:${path}`,
    async fetchPosts(accounts, since, opts): Promise<FetchPostsResult> {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      const scrapedAt = now().toISOString();
      let posts: NormalizedPost[];
      let rawCount: number;
      if (Array.isArray(raw)) {
        rawCount = raw.length;
        posts = normalizeApifyItems(raw, scrapedAt);
      } else if (typeof raw === "object" && raw !== null && Array.isArray((raw as { posts?: unknown }).posts)) {
        const list = (raw as { posts: unknown[] }).posts;
        rawCount = list.length;
        posts = list.map((p) => NormalizedPostSchema.parse(p));
      } else {
        throw new Error(`fixture ${path}: expected an array of items or {posts: [...]}`);
      }

      const handles = accounts.map((a) => a.handle);
      const bounded = restrict
        ? applyClientSideBounds(posts, handles, since, opts.maxPostsPerAccount)
        : posts;
      const counts = new Map<string, number>();
      for (const p of bounded) {
        const k = p.author_handle.toLowerCase();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      return {
        source: `fixture:${path}`,
        posts: bounded,
        accounts: handles.map((h) => ({ handle: h, ok: true, posts: counts.get(h.toLowerCase()) ?? 0 })),
        raw_count: rawCount,
      };
    },
  };
}
