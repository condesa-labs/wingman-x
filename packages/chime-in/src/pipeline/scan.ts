import type { CandidateInput } from "@wingman-x/agent-kit";
import type { Config } from "../config.js";
import type { KBIndex } from "../kb/kb-index.js";
import type { LLMProvider } from "../llm/provider.js";
import type { NormalizedPost } from "../model/post.js";
import type { PostSource } from "../sources/post-source.js";
import type { CandidateLog } from "../state/candidate-log.js";
import type { ProcessedStore } from "../state/processed-store.js";
import { mapWithConcurrency, settle } from "../util/concurrency.js";
import type { Logger } from "../util/logger.js";
import type { WatchAccount } from "../watchlist.js";
import { toWingmanCandidate, type ScoredDraft } from "../wingman/candidate-map.js";
import { rankCandidates } from "./rank.js";
import { assessContribution } from "./stages/contribution.js";
import { draftReply } from "./stages/draft.js";
import { assessExpertise, type ExpertiseOutcome } from "./stages/expertise.js";
import { mechanicalFilter, type MechanicalReason } from "./stages/mechanical.js";
import { classifyThemes, type ThemeResult } from "./stages/theme.js";

/**
 * The scan orchestrator. Pure with respect to I/O — every side effect
 * (source, LLM, stores, daemon) is injected — so the whole funnel is
 * testable with the fake provider and the fixture source.
 */
export interface CandidateSink {
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
}

export interface ScanDeps {
  config: Config;
  watchlist: WatchAccount[];
  source: PostSource;
  llm: LLMProvider;
  kb: KBIndex;
  themes: readonly string[];
  processed: ProcessedStore;
  candidateLog: CandidateLog;
  /** `null` in dry-run: nothing is sent, nothing is marked processed. */
  sink: CandidateSink | null;
  log: Logger;
  now?: () => Date;
}

export interface ScanOptions {
  since: Date;
  dryRun: boolean;
  /** Ignore the processed store (explicit re-run on already-seen posts). */
  reprocess: boolean;
  /** Only scan these handles (subset of the watchlist). */
  handles?: string[];
  /** Cap posts admitted to the LLM stages (debugging). */
  limit?: number;
}

export interface PostOutcome {
  tweet_id: string;
  author_handle: string;
  tweet_url: string;
  stage: "mechanical" | "theme" | "expertise" | "contribution" | "rank" | "draft" | "sent" | "error";
  decision: "filtered" | "candidate" | "error";
  reason?: string;
  theme?: string;
  theme_score?: number;
  expertise_score?: number;
  contribution_score?: number;
  contribution_angle?: string;
  suggested_reply?: string;
}

export interface ScanSummary {
  started_at: string;
  completed_at: string;
  since: string;
  source: string;
  dry_run: boolean;
  accounts_requested: number;
  accounts_fetched: number;
  account_failures: Array<{ handle: string; error: string }>;
  posts_fetched: number;
  raw_items: number;
  unseen_posts: number;
  removed_by_basic_filters: number;
  basic_filter_breakdown: Record<MechanicalReason, number>;
  theme_candidates: number;
  expertise_candidates: number;
  contribution_candidates: number;
  ranked_out: number;
  drafted: number;
  sent: number;
  errors: number;
  llm: { provider: string; calls: number; failures: number; cost_usd: number; elapsed_ms: number };
  candidates: Array<{
    tweet_id: string;
    tweet_url: string;
    author_handle: string;
    theme: string;
    theme_score: number;
    expertise_score: number;
    contribution_score: number;
    contribution_angle: string;
    suggested_reply: string;
    ai_tell_flags: string[];
  }>;
  outcomes: PostOutcome[];
}

/**
 * The last few replies we actually sent (from candidates.jsonl), so the
 * drafter knows what has just been said and does not recycle it.
 */
export function buildEditorialMemory(log: CandidateLog, recent = 12): string {
  const sent = log
    .all()
    .sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at))
    .slice(0, recent)
    .map((r) => r.replies[r.replies.length - 1])
    .filter((r): r is string => typeof r === "string" && r.length > 0);
  return sent.map((r) => `- ${r.replace(/\s+/g, " ")}`).join("\n");
}

interface Scored {
  post: NormalizedPost;
  account: WatchAccount;
  theme: ThemeResult;
  expertise: ExpertiseOutcome;
  contribution_score: number;
  contribution_angle: string;
  contribution_reason: string;
}

export async function runScan(deps: ScanDeps, opts: ScanOptions): Promise<ScanSummary> {
  const { config, log } = deps;
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const outcomes: PostOutcome[] = [];
  const breakdown: Record<MechanicalReason, number> = { seen: 0, repost: 0, reply: 0, empty: 0, spam: 0 };
  let errors = 0;

  const markFiltered = (
    post: NormalizedPost,
    stage: PostOutcome["stage"],
    reason: string,
    scores?: { theme?: number; expertise?: number; contribution?: number },
    extra?: Partial<PostOutcome>,
  ): void => {
    outcomes.push({
      tweet_id: post.tweet_id,
      author_handle: post.author_handle,
      tweet_url: post.tweet_url,
      stage,
      decision: "filtered",
      reason,
      ...extra,
    });
    if (opts.dryRun) return;
    deps.processed.record({
      tweet_id: post.tweet_id,
      first_seen_at: deps.processed.get(post.tweet_id)?.first_seen_at ?? startedAt,
      processed_at: now().toISOString(),
      decision: "filtered",
      stage,
      reason,
      author_handle: post.author_handle,
      ...(scores ? { scores } : {}),
    });
  };
  const markError = (post: NormalizedPost, stage: PostOutcome["stage"], error: string): void => {
    errors += 1;
    log.warn(`${stage} failed for ${post.tweet_url}: ${error}`);
    // Deliberately NOT recorded as processed — it will be retried next scan.
    outcomes.push({
      tweet_id: post.tweet_id,
      author_handle: post.author_handle,
      tweet_url: post.tweet_url,
      stage,
      decision: "error",
      reason: error,
    });
  };

  // ---- Fetch ---------------------------------------------------------
  const accounts = opts.handles
    ? deps.watchlist.filter((a) => opts.handles!.some((h) => h.toLowerCase() === a.handle.toLowerCase()))
    : deps.watchlist;
  const byHandle = new Map(accounts.map((a) => [a.handle.toLowerCase(), a] as const));
  log.info("Starting scan");
  log.info(`${accounts.length} accounts requested (source: ${deps.source.name}, since ${opts.since.toISOString()})`);

  const fetched = await deps.source.fetchPosts(accounts, opts.since, {
    maxPostsPerAccount: config.maxPostsPerAccount,
    includeReplies: config.includeReplies,
    includeReposts: config.includeReposts,
  });
  const failures = fetched.accounts.filter((a) => !a.ok);
  log.info(`${fetched.accounts.length - failures.length} accounts successfully fetched`);
  if (failures.length > 0) {
    log.info(`${failures.length} account failures`);
    for (const f of failures.slice(0, 10)) log.debug(`  @${f.handle}: ${f.error ?? "unknown error"}`);
  }
  log.info(`${fetched.posts.length} posts fetched (${fetched.raw_count} raw items)`);

  // ---- Stage 1: mechanical ------------------------------------------
  const seen = (id: string): boolean => (opts.reprocess ? false : deps.processed.has(id));
  let admitted: NormalizedPost[] = [];
  for (const post of fetched.posts) {
    const r = mechanicalFilter(post, {
      includeReplies: config.includeReplies,
      includeReposts: config.includeReposts,
      seen,
    });
    if (r.pass) {
      admitted.push(post);
    } else {
      breakdown[r.reason] += 1;
      // Already-seen posts are not re-recorded; everything else is a decision.
      if (r.reason !== "seen") markFiltered(post, "mechanical", r.reason);
    }
  }
  const unseen = fetched.posts.length - breakdown.seen;
  const removedByBasic = breakdown.repost + breakdown.reply + breakdown.empty + breakdown.spam;
  log.info(`${unseen} unseen posts`);
  log.info(
    `${removedByBasic} removed by basic filters (reposts ${breakdown.repost}, replies ${breakdown.reply}, empty ${breakdown.empty}, spam ${breakdown.spam})`,
  );
  const cap = Math.min(config.maxPostsPerScan, opts.limit ?? Number.POSITIVE_INFINITY);
  if (admitted.length > cap) {
    log.warn(`capping LLM stages at ${cap} of ${admitted.length} posts (newest first)`);
    admitted = [...admitted]
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, cap);
  }

  // ---- Stage 2: theme -------------------------------------------------
  const themeOutcomes = await classifyThemes(admitted, {
    llm: deps.llm,
    themes: deps.themes,
    batchSize: config.themeBatchSize,
    log: (l) => log.debug(l),
  });
  const themed: Array<{ post: NormalizedPost; theme: ThemeResult }> = [];
  for (const post of admitted) {
    const o = themeOutcomes.get(post.tweet_id);
    if (!o) {
      markError(post, "theme", "no classification returned");
      continue;
    }
    if (!o.ok) {
      markError(post, "theme", o.error);
      continue;
    }
    if (!o.result.relevant || o.result.theme_score < config.themeThreshold) {
      markFiltered(post, "theme", `theme ${o.result.theme_score} < ${config.themeThreshold}: ${o.result.reason}`, { theme: o.result.theme_score }, { theme: o.result.theme, theme_score: o.result.theme_score });
      continue;
    }
    themed.push({ post, theme: o.result });
  }
  log.info(`${themed.length} theme candidates`);

  // ---- Stage 3: expertise --------------------------------------------
  const expertiseResults = await mapWithConcurrency(themed, config.llmConcurrency, ({ post, theme }) =>
    settle(assessExpertise(post, theme.theme, { llm: deps.llm, kb: deps.kb, topK: config.kbTopK })),
  );
  const expert: Array<{ post: NormalizedPost; theme: ThemeResult; expertise: ExpertiseOutcome }> = [];
  themed.forEach(({ post, theme }, i) => {
    const r = expertiseResults[i]!;
    if (!r.ok) {
      markError(post, "expertise", r.error.message);
      return;
    }
    if (r.value.expertise_score < config.expertiseThreshold) {
      markFiltered(
        post,
        "expertise",
        `expertise ${r.value.expertise_score} < ${config.expertiseThreshold}: ${r.value.expertise_reason}`,
        { theme: theme.theme_score, expertise: r.value.expertise_score },
        { theme: theme.theme, theme_score: theme.theme_score, expertise_score: r.value.expertise_score },
      );
      return;
    }
    expert.push({ post, theme, expertise: r.value });
  });
  log.info(`${expert.length} expertise candidates`);

  // ---- Stage 4: contribution -----------------------------------------
  const contributionResults = await mapWithConcurrency(expert, config.llmConcurrency, ({ post, theme, expertise }) => {
    // Use the excerpts the expertise stage confirmed; fall back to the
    // retrieved set so the model still sees the KB when nothing was cited.
    const chunks = expertise.chunks.length > 0 ? expertise.chunks : expertise.retrieved;
    return settle(
      assessContribution(post, theme.theme, expertise.expertise_reason, chunks, {
        llm: deps.llm,
        constraints: deps.kb.constraints,
      }),
    );
  });
  const scored: Scored[] = [];
  expert.forEach(({ post, theme, expertise }, i) => {
    const r = contributionResults[i]!;
    if (!r.ok) {
      markError(post, "contribution", r.error.message);
      return;
    }
    const scores = { theme: theme.theme_score, expertise: expertise.expertise_score, contribution: r.value.contribution_score };
    if (r.value.contribution_score < config.contributionThreshold) {
      markFiltered(
        post,
        "contribution",
        `contribution ${r.value.contribution_score} < ${config.contributionThreshold}: ${r.value.reason}`,
        scores,
        {
          theme: theme.theme,
          theme_score: theme.theme_score,
          expertise_score: expertise.expertise_score,
          contribution_score: r.value.contribution_score,
          contribution_angle: r.value.contribution_angle,
        },
      );
      return;
    }
    const account = byHandle.get(post.author_handle.toLowerCase()) ?? { handle: post.author_handle, priority: 2 as const };
    scored.push({
      post,
      account,
      theme,
      expertise,
      contribution_score: r.value.contribution_score,
      contribution_angle: r.value.contribution_angle,
      contribution_reason: r.value.reason,
    });
  });
  log.info(`${scored.length} contribution candidates`);

  // ---- Rank ------------------------------------------------------------
  const { selected, rankedOut } = rankCandidates(
    scored.map((s) => ({
      ...s,
      tweet_id: s.post.tweet_id,
      theme_score: s.theme.theme_score,
      expertise_score: s.expertise.expertise_score,
      account_priority: s.account.priority,
      created_at: s.post.created_at,
    })),
    { priorityBoost: config.priorityBoost, max: config.maxCandidatesPerScan },
  );
  for (const s of rankedOut) {
    markFiltered(
      s.post,
      "rank",
      `ranked out (cap ${config.maxCandidatesPerScan})`,
      { theme: s.theme_score, expertise: s.expertise_score, contribution: s.contribution_score },
      {
        theme: s.theme.theme,
        theme_score: s.theme_score,
        expertise_score: s.expertise_score,
        contribution_score: s.contribution_score,
        contribution_angle: s.contribution_angle,
      },
    );
  }
  if (rankedOut.length > 0) log.info(`${rankedOut.length} above threshold but ranked out by MAX_CANDIDATES_PER_SCAN`);

  // ---- Stage 5: draft ---------------------------------------------------
  // Sequential on purpose: each draft sees the ones before it so a scan's
  // candidates do not all make the same point.
  const editorial = buildEditorialMemory(deps.candidateLog);
  const draftedSoFar: string[] = [];
  const drafts = await mapWithConcurrency(selected, 1, async (s) => {
    const chunks = s.expertise.chunks.length > 0 ? s.expertise.chunks : s.expertise.retrieved.slice(0, 4);
    const result = await settle(
      draftReply({
        post: s.post,
        theme: s.theme.theme,
        angle: s.contribution_angle,
        chunks,
        tone: deps.kb.tone,
        maxChars: config.replyMaxChars,
        constraints: deps.kb.constraints,
        editorial,
        avoidPoints: [...draftedSoFar],
        llm: deps.llm,
      }),
    );
    if (result.ok) draftedSoFar.push(result.value.suggested_reply);
    return result;
  });
  const ready: ScoredDraft[] = [];
  selected.forEach((s, i) => {
    const d = drafts[i]!;
    if (!d.ok) {
      markError(s.post, "draft", d.error.message);
      return;
    }
    const chunks = s.expertise.chunks.length > 0 ? s.expertise.chunks : s.expertise.retrieved.slice(0, 4);
    const kbFiles = Array.from(new Set(chunks.map((c) => c.file)));
    ready.push({
      post: s.post,
      theme: s.theme.theme,
      theme_score: s.theme_score,
      expertise_score: s.expertise_score,
      contribution_score: s.contribution_score,
      contribution_angle: s.contribution_angle,
      account_priority: s.account.priority,
      kb_files: kbFiles,
      suggested_reply: d.value.suggested_reply,
      ai_tell_flags: d.value.ai_tell_flags,
    });
    if (!opts.dryRun) {
      deps.candidateLog.upsert({
        tweet_id: s.post.tweet_id,
        recorded_at: now().toISOString(),
        post: s.post,
        theme: s.theme.theme,
        theme_score: s.theme_score,
        expertise_score: s.expertise_score,
        contribution_score: s.contribution_score,
        contribution_angle: s.contribution_angle,
        account_priority: s.account.priority,
        kb_refs: kbFiles,
        chunk_refs: chunks.map((c) => c.ref),
        replies: [d.value.suggested_reply],
      });
    }
  });
  log.info(`${ready.length} replies drafted`);

  // ---- Send to Wingman -------------------------------------------------
  let sent = 0;
  if (ready.length > 0 && deps.sink !== null && !opts.dryRun) {
    const inputs = ready.map(toWingmanCandidate);
    try {
      const res = await deps.sink.postCandidates(inputs);
      sent = res.accepted;
      for (const r of ready) {
        outcomes.push({
          tweet_id: r.post.tweet_id,
          author_handle: r.post.author_handle,
          tweet_url: r.post.tweet_url,
          stage: "sent",
          decision: "candidate",
          theme: r.theme,
          theme_score: r.theme_score,
          expertise_score: r.expertise_score,
          contribution_score: r.contribution_score,
          contribution_angle: r.contribution_angle,
          suggested_reply: r.suggested_reply,
        });
        deps.processed.record({
          tweet_id: r.post.tweet_id,
          first_seen_at: deps.processed.get(r.post.tweet_id)?.first_seen_at ?? startedAt,
          processed_at: now().toISOString(),
          decision: "candidate",
          stage: "wingman",
          author_handle: r.post.author_handle,
          scores: { theme: r.theme_score, expertise: r.expertise_score, contribution: r.contribution_score },
        });
      }
    } catch (err) {
      // POST failed: nothing is marked processed, so the next scan retries.
      errors += ready.length;
      log.warn(`sending candidates to Wingman failed: ${(err as Error).message}`);
      for (const r of ready) {
        outcomes.push({
          tweet_id: r.post.tweet_id,
          author_handle: r.post.author_handle,
          tweet_url: r.post.tweet_url,
          stage: "sent",
          decision: "error",
          reason: (err as Error).message,
          suggested_reply: r.suggested_reply,
        });
      }
    }
  } else {
    for (const r of ready) {
      outcomes.push({
        tweet_id: r.post.tweet_id,
        author_handle: r.post.author_handle,
        tweet_url: r.post.tweet_url,
        stage: "draft",
        decision: "candidate",
        theme: r.theme,
        theme_score: r.theme_score,
        expertise_score: r.expertise_score,
        contribution_score: r.contribution_score,
        contribution_angle: r.contribution_angle,
        suggested_reply: r.suggested_reply,
      });
    }
  }
  log.info(opts.dryRun ? `${ready.length} candidates (dry run — not sent)` : `${sent} candidates sent to Wingman`);
  if (errors > 0) log.info(`${errors} post(s) hit errors and will be retried next scan`);

  const usage = deps.llm.usage();
  return {
    started_at: startedAt,
    completed_at: now().toISOString(),
    since: opts.since.toISOString(),
    source: fetched.source,
    dry_run: opts.dryRun,
    accounts_requested: accounts.length,
    accounts_fetched: fetched.accounts.length - failures.length,
    account_failures: failures.map((f) => ({ handle: f.handle, error: f.error ?? "unknown" })),
    posts_fetched: fetched.posts.length,
    raw_items: fetched.raw_count,
    unseen_posts: unseen,
    removed_by_basic_filters: removedByBasic,
    basic_filter_breakdown: breakdown,
    theme_candidates: themed.length,
    expertise_candidates: expert.length,
    contribution_candidates: scored.length,
    ranked_out: rankedOut.length,
    drafted: ready.length,
    sent,
    errors,
    llm: {
      provider: deps.llm.name,
      calls: usage.calls,
      failures: usage.failures,
      cost_usd: usage.costUsd,
      elapsed_ms: usage.elapsedMs,
    },
    candidates: ready.map((r) => ({
      tweet_id: r.post.tweet_id,
      tweet_url: r.post.tweet_url,
      author_handle: r.post.author_handle,
      theme: r.theme,
      theme_score: r.theme_score,
      expertise_score: r.expertise_score,
      contribution_score: r.contribution_score,
      contribution_angle: r.contribution_angle,
      suggested_reply: r.suggested_reply,
      ai_tell_flags: r.ai_tell_flags,
    })),
    outcomes,
  };
}
