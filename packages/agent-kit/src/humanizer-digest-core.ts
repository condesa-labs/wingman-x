/**
 * Humanizer feedback digest core — the unit-testable surface of the
 * human-run feedback digest tool (CP04). The thin entrypoint at
 * `scripts/humanizer-digest.ts` imports from here and adds the I/O wiring
 * (read `<stateDir>/flagged-replies.jsonl`, print the digest, and — only on
 * an explicit `--post` flag — invoke `gh issue create`).
 *
 * Design split (mirrors `watcher-core.ts` ↔ `scripts/watcher.ts`):
 *   `src/humanizer-digest-core.ts` — pure parse/aggregate/render (this file).
 *   `scripts/humanizer-digest.ts`  — file read + optional `gh` invocation.
 *
 * Vitest's coverage scope is `src/**`, so all branchy logic lives here:
 * tolerant JSONL parsing, per-pattern aggregation, and markdown rendering.
 * The core is PURE — no I/O, no network, no `Date`.
 */

/**
 * One flagged-reply record as written to `<stateDir>/flagged-replies.jsonl`
 * by the watcher (`FlaggedReplyRecord` in `watcher-core.ts`). Re-declared here
 * — not imported — so the digest core has no coupling to the watcher's write
 * path and only depends on the on-disk JSONL contract.
 */
export interface FlaggedDigestRecord {
  ts: string;
  tweet_id: string;
  reply: string;
  matched: string[];
}

/** A single row of the per-pattern count table, count-desc / label-asc. */
export interface PatternCount {
  label: string;
  count: number;
}

const MAX_EXAMPLES = 5;

/**
 * Coerce one parsed JSON value into a {@link FlaggedDigestRecord}, or `null`
 * if it does not match the on-disk shape. Tolerant by design: a single
 * corrupt line must never abort the digest.
 */
function toFlaggedRecord(value: unknown): FlaggedDigestRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const rec = value as Record<string, unknown>;
  if (
    typeof rec.ts !== "string" ||
    typeof rec.tweet_id !== "string" ||
    typeof rec.reply !== "string" ||
    !Array.isArray(rec.matched)
  ) {
    return null;
  }
  return {
    ts: rec.ts,
    tweet_id: rec.tweet_id,
    reply: rec.reply,
    matched: rec.matched.filter((m): m is string => typeof m === "string"),
  };
}

/**
 * Parse JSONL text (one record per line) into flagged-reply records.
 * Blank, whitespace-only, malformed (non-JSON), and wrong-shape lines are
 * skipped silently — the function never throws.
 */
export function parseFlaggedReplies(jsonl: string): FlaggedDigestRecord[] {
  const out: FlaggedDigestRecord[] = [];
  for (const rawLine of jsonl.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // malformed line — skip, don't abort
    }
    const record = toFlaggedRecord(parsed);
    if (record !== null) out.push(record);
  }
  return out;
}

/**
 * Aggregate flagged records into per-pattern counts, sorted by count
 * descending then label ascending (stable, deterministic output). Records
 * with an empty `matched` array contribute nothing.
 */
export function aggregateByPattern(
  records: readonly FlaggedDigestRecord[],
): PatternCount[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const label of record.matched) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Collapse a reply to a single line so it can't break markdown structure. */
function sanitizeReply(reply: string): string {
  return reply.replace(/\s+/g, " ").trim();
}

/**
 * Render the full markdown digest from raw JSONL text. Empty input, or input
 * where every line is malformed/wrong-shape, produces a clear "nothing
 * flagged" digest rather than an empty or broken document.
 */
export function renderDigest(jsonl: string): string {
  const records = parseFlaggedReplies(jsonl);
  const rows = aggregateByPattern(records);

  const lines: string[] = ["## Humanizer feedback digest", ""];

  if (rows.length === 0) {
    lines.push(
      "Nothing flagged — no AI-tell patterns were recorded in the local log.",
    );
    return lines.join("\n") + "\n";
  }

  lines.push(
    `${records.length} flagged repl${records.length === 1 ? "y" : "ies"} across ${rows.length} pattern${rows.length === 1 ? "" : "s"}.`,
    "",
    "| Pattern | Count |",
    "| --- | --- |",
  );
  for (const { label, count } of rows) {
    lines.push(`| ${label} | ${count} |`);
  }

  lines.push("", "### Example replies", "");
  for (const record of records.slice(0, MAX_EXAMPLES)) {
    lines.push(
      `- [${record.matched.join(", ")}] ${sanitizeReply(record.reply)}`,
    );
  }

  return lines.join("\n") + "\n";
}
