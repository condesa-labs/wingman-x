import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Durable record of every post the pipeline has reached a decision on.
 *
 * Append-only JSONL, one line per decision, written synchronously the
 * moment a decision is final. A crash mid-scan therefore leaves exactly
 * the decided posts marked and nothing else — a failed scan can never
 * mark undecided posts as processed. The latest line for a tweet_id wins.
 */
export const DecisionSchema = z.enum(["filtered", "candidate", "dismissed"]);
export type Decision = z.infer<typeof DecisionSchema>;

export const ProcessedRecordSchema = z.object({
  tweet_id: z.string().min(1),
  first_seen_at: z.string(),
  processed_at: z.string(),
  decision: DecisionSchema,
  /** Which stage decided (mechanical | theme | expertise | contribution | rank | draft | wingman | regen). */
  stage: z.string().optional(),
  reason: z.string().optional(),
  author_handle: z.string().optional(),
  scores: z
    .object({
      theme: z.number().optional(),
      expertise: z.number().optional(),
      contribution: z.number().optional(),
    })
    .optional(),
});
export type ProcessedRecord = z.infer<typeof ProcessedRecordSchema>;

export interface ProcessedStore {
  readonly path: string;
  has(tweetId: string): boolean;
  get(tweetId: string): ProcessedRecord | undefined;
  /** Append a decision. Synchronous and durable before it returns. */
  record(rec: ProcessedRecord): void;
  size(): number;
}

export function parseProcessedJsonl(text: string): Map<string, ProcessedRecord> {
  const map = new Map<string, ProcessedRecord>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn final line must not poison the store
    }
    const rec = ProcessedRecordSchema.safeParse(parsed);
    if (rec.success) map.set(rec.data.tweet_id, rec.data);
  }
  return map;
}

export function openProcessedStore(path: string): ProcessedStore {
  const map = existsSync(path) ? parseProcessedJsonl(readFileSync(path, "utf8")) : new Map<string, ProcessedRecord>();

  return {
    path,
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    record(rec) {
      const validated = ProcessedRecordSchema.parse(rec);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
      map.set(validated.tweet_id, validated);
    },
    size: () => map.size,
  };
}

/** In-memory store for dry runs and tests: same interface, no disk writes. */
export function createMemoryProcessedStore(initial: ProcessedRecord[] = []): ProcessedStore {
  const map = new Map(initial.map((r) => [r.tweet_id, r] as const));
  return {
    path: "<memory>",
    has: (id) => map.has(id),
    get: (id) => map.get(id),
    record(rec) {
      map.set(rec.tweet_id, ProcessedRecordSchema.parse(rec));
    },
    size: () => map.size,
  };
}
