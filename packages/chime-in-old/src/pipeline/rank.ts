/**
 * Ranking after all three semantic gates. Thresholds do the real work;
 * the ranking only orders survivors and applies the per-scan cap.
 * Primary key: contribution; secondary: expertise; account priority nudges.
 */
export interface Rankable {
  tweet_id: string;
  theme_score: number;
  expertise_score: number;
  contribution_score: number;
  account_priority: 1 | 2 | 3;
  created_at: string;
}

export interface RankOptions {
  priorityBoost: number;
  max: number;
}

export function priorityAdjustment(priority: 1 | 2 | 3, boost: number): number {
  if (priority === 1) return boost;
  if (priority === 3) return -boost;
  return 0;
}

export function rankScore(item: Rankable, boost: number): number {
  return (
    item.contribution_score +
    0.5 * item.expertise_score +
    0.1 * item.theme_score +
    priorityAdjustment(item.account_priority, boost)
  );
}

export function rankCandidates<T extends Rankable>(
  items: T[],
  opts: RankOptions,
): { selected: T[]; rankedOut: T[] } {
  const sorted = [...items].sort((a, b) => {
    const d = rankScore(b, opts.priorityBoost) - rankScore(a, opts.priorityBoost);
    if (d !== 0) return d;
    const c = b.contribution_score - a.contribution_score;
    if (c !== 0) return c;
    const e = b.expertise_score - a.expertise_score;
    if (e !== 0) return e;
    const t = Date.parse(b.created_at) - Date.parse(a.created_at);
    if (t !== 0) return t;
    return a.tweet_id.localeCompare(b.tweet_id);
  });
  return { selected: sorted.slice(0, opts.max), rankedOut: sorted.slice(opts.max) };
}
