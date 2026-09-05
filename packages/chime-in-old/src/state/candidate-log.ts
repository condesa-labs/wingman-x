import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { NormalizedPostSchema } from "../model/post.js";

/**
 * Everything we knew when we drafted a candidate, so regeneration can
 * reuse the same theme, angle, KB excerpts and prior replies without
 * re-scoring. Also the raw material for Phase 2 "learn from my behaviour".
 */
export const CandidateLogRecordSchema = z.object({
  tweet_id: z.string().min(1),
  recorded_at: z.string(),
  post: NormalizedPostSchema,
  theme: z.string(),
  theme_score: z.number(),
  expertise_score: z.number(),
  contribution_score: z.number(),
  contribution_angle: z.string(),
  account_priority: z.number(),
  kb_refs: z.array(z.string()),
  /** Chunk refs (file#heading) used for drafting — used again for regen. */
  chunk_refs: z.array(z.string()),
  replies: z.array(z.string()),
});
export type CandidateLogRecord = z.infer<typeof CandidateLogRecordSchema>;

export interface CandidateLog {
  get(tweetId: string): CandidateLogRecord | undefined;
  upsert(rec: CandidateLogRecord): void;
  all(): CandidateLogRecord[];
}

export function parseCandidateLog(text: string): Map<string, CandidateLogRecord> {
  const map = new Map<string, CandidateLogRecord>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const rec = CandidateLogRecordSchema.safeParse(JSON.parse(line));
      if (rec.success) map.set(rec.data.tweet_id, rec.data);
    } catch {
      // skip torn line
    }
  }
  return map;
}

export function openCandidateLog(path: string): CandidateLog {
  const map = existsSync(path) ? parseCandidateLog(readFileSync(path, "utf8")) : new Map<string, CandidateLogRecord>();
  return {
    get: (id) => map.get(id),
    upsert(rec) {
      const v = CandidateLogRecordSchema.parse(rec);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(v)}\n`, "utf8");
      map.set(v.tweet_id, v);
    },
    all: () => [...map.values()],
  };
}

export function createMemoryCandidateLog(): CandidateLog {
  const map = new Map<string, CandidateLogRecord>();
  return {
    get: (id) => map.get(id),
    upsert(rec) {
      map.set(rec.tweet_id, CandidateLogRecordSchema.parse(rec));
    },
    all: () => [...map.values()],
  };
}
