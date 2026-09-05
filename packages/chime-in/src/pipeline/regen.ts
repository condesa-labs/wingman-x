import type { Candidate, CandidateInput } from "@wingman-x/agent-kit";
import type { Config } from "../config.js";
import type { KBIndex } from "../kb/kb-index.js";
import { buildEditorialMemory } from "./scan.js";
import type { LLMProvider } from "../llm/provider.js";
import { NormalizedPostSchema, canonicalTweetUrl, type NormalizedPost } from "../model/post.js";
import type { CandidateLog } from "../state/candidate-log.js";
import type { ScanState } from "../state/scan-state.js";
import type { Logger } from "../util/logger.js";
import { parseAngleFromMatchReason } from "../wingman/candidate-map.js";
import { draftReply, hasConcedeOpener } from "./stages/draft.js";
import { isLineType, nextLineType } from "./lane.js";
import { ReplyDepthSchema, ReplyMoveSchema, type ReplyDepth, type ReplyMove } from "./stages/contribution.js";

/**
 * Which move the regenerated reply should use. The first regeneration keeps
 * the original move and produces a meaningfully different version of it (the
 * move was probably right and the wording was not). From the second
 * regeneration on, the move itself is switched to one not yet tried.
 */
export function nextRegenMove(previousMoves: readonly string[]): ReplyMove {
  if (previousMoves.length <= 1) return (previousMoves[0] as ReplyMove | undefined) ?? "agree_extend";
  const order: ReplyMove[] = ["agree_extend", "question", "example", "distinction", "light_reaction", "challenge", "operator_context"];
  const used = new Set(previousMoves);
  return order.find((m) => !used.has(m)) ?? "agree_extend";
}
import { retrievalQuery } from "./stages/expertise.js";

/**
 * Regeneration. Wingman's ♻️ button sets a candidate's status to
 * `regen_requested`; nothing in Wingman consumes that, so we do: every
 * scan (or `npm run regen`) redrafts those candidates with the original
 * post, prior reply, KB excerpts, tone guide and contribution angle,
 * then re-POSTs. The daemon's merge keeps the status, so we remember the
 * `status_updated_at` we served to avoid redrafting the same click twice.
 */
export interface RegenDeps {
  config: Config;
  llm: LLMProvider;
  kb: KBIndex;
  candidateLog: CandidateLog;
  state: ScanState;
  getCandidates(): Promise<Candidate[]>;
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
  /** Conversational-lane policy, for regenerating conversational candidates. */
  policy?: string;
  log: Logger;
  now?: () => Date;
  /** Redraft even if the current ♻️ click was already served. */
  force?: boolean;
  /** Watch mode sweeps every minute; do not repeat the "already served" notice each time. */
  quietServed?: boolean;
}

export interface RegenSummary {
  requested: number;
  regenerated: number;
  failed: number;
  /** Candidates in regen_requested whose last click was already served. */
  already_served: number;
  /** Regens answered from pre-generated alternates, no model call. */
  served_from_alternates: number;
  /** Cards the person filled since last run, recorded to the candidate log. */
  fills_recorded: number;
}

/**
 * Record what was live on each card the person filled. Wingman marks the
 * candidate `filled` and keeps the suggested_reply that was showing, which
 * is the closest thing to a preference signal this system has.
 */
export function recordFills(candidates: Candidate[], log: CandidateLog): number {
  let n = 0;
  for (const c of candidates) {
    if (c.status !== "filled" || !c.id.startsWith("chime-")) continue;
    const logged = log.get(c.tweet_id);
    if (!logged || logged.filled_at === c.status_updated_at) continue;
    log.upsert({ ...logged, filled_reply: c.suggested_reply, filled_at: c.status_updated_at });
    n += 1;
  }
  return n;
}

export function pendingRegens(candidates: Candidate[], state: ScanState, force = false): Candidate[] {
  return candidates.filter(
    (c) =>
      c.status === "regen_requested" &&
      c.id.startsWith("chime-") &&
      (force || state.regen_handled[c.tweet_id] !== c.status_updated_at),
  );
}

/** Regen-requested candidates whose current click has already been served. */
export function servedRegens(candidates: Candidate[], state: ScanState): Candidate[] {
  return candidates.filter(
    (c) =>
      c.status === "regen_requested" &&
      c.id.startsWith("chime-") &&
      state.regen_handled[c.tweet_id] === c.status_updated_at,
  );
}

function postFromCandidate(c: Candidate, nowIso: string): NormalizedPost {
  const handle = c.author_handle.replace(/^@/, "");
  return NormalizedPostSchema.parse({
    tweet_id: c.tweet_id,
    tweet_url: c.tweet_url,
    author_handle: handle,
    tweet_text: c.tweet_text,
    created_at: c.created_at,
    scraped_at: nowIso,
  });
}

export async function runRegen(deps: RegenDeps): Promise<RegenSummary> {
  const now = deps.now ?? (() => new Date());
  const candidates = await deps.getCandidates();
  const pending = pendingRegens(candidates, deps.state, deps.force === true);
  const served = deps.force === true ? [] : servedRegens(candidates, deps.state);
  const summary: RegenSummary = {
    requested: pending.length,
    regenerated: 0,
    failed: 0,
    already_served: served.length,
    served_from_alternates: 0,
    fills_recorded: recordFills(candidates, deps.candidateLog),
  };
  if (summary.fills_recorded > 0) deps.log.info(`recorded ${summary.fills_recorded} filled reply(ies) to the candidate log`);
  if (pending.length === 0) {
    if (served.length > 0 && !deps.quietServed) {
      deps.log.info(
        `${served.length} candidate(s) still marked ♻️ but their last click was already served. Press ♻️ again in the extension, or run with --force to redraft anyway.`,
      );
    }
    return summary;
  }
  deps.log.info(`${pending.length} regeneration request(s) pending`);

  for (const c of pending) {
    const logged = deps.candidateLog.get(c.tweet_id);
    const post = logged?.post ?? postFromCandidate(c, now().toISOString());
    const theme = logged?.theme ?? "unknown";
    const angle =
      logged?.contribution_angle ?? parseAngleFromMatchReason(c.match_reason) ?? "Add the most specific, non-obvious point the knowledge base supports.";
    const previous = Array.from(new Set([...(logged?.replies ?? []), c.suggested_reply]));
    const previousMoves = (logged?.moves ?? []).filter((m): m is ReplyMove => ReplyMoveSchema.safeParse(m).success);

    // Serve a pre-generated alternate first: same move, different shape,
    // no model call. The model path below is for when they run out.
    const unusedAlternates = (logged?.alternates ?? []).filter((a) => !previous.includes(a));
    if (logged && unusedAlternates.length > 0) {
      const [next, ...rest] = unusedAlternates;
      try {
        await deps.postCandidates([
          {
            id: c.id,
            tweet_id: c.tweet_id,
            tweet_url: c.tweet_url,
            author_handle: c.author_handle,
            tweet_text: c.tweet_text,
            suggested_reply: next!,
            match_reason: c.match_reason,
            match_category: c.match_category,
            source: c.source,
            kb_refs: c.kb_refs,
          },
        ]);
        deps.state.regen_handled[c.tweet_id] = c.status_updated_at;
        deps.candidateLog.upsert({
          ...logged,
          replies: [...previous, next!],
          moves: [...previousMoves, previousMoves[previousMoves.length - 1] ?? "agree_extend"],
          alternates: rest,
        });
        summary.regenerated += 1;
        summary.served_from_alternates += 1;
        deps.log.info(`served alternate draft for ${canonicalTweetUrl(post.author_handle, c.tweet_id)} (${rest.length} left)`);
      } catch (err) {
        summary.failed += 1;
        deps.log.warn(`regen failed for ${c.tweet_url}: ${(err as Error).message}`);
      }
      continue;
    }
    const move = nextRegenMove(previousMoves);
    const loggedDepth = ReplyDepthSchema.safeParse(logged?.depth);
    const depth: ReplyDepth = loggedDepth.success ? loggedDepth.data : "substantive";
    // Conversational candidates regenerate in their own lane: no KB, next
    // unused reply type, same energy.
    const conversational = logged?.lane === "conversational" && !!deps.policy;
    const usedTypes = (logged?.moves ?? []).filter(isLineType);
    const lineType = nextLineType(usedTypes);
    let chunks = logged ? deps.kb.chunksByRef(logged.chunk_refs) : [];
    if (chunks.length === 0) {
      const files = c.kb_refs.filter((r) => r !== "tone.md");
      chunks = files.length > 0 ? deps.kb.chunksForFiles(files, deps.config.kbTopK) : [];
    }
    if (chunks.length === 0) chunks = deps.kb.search(retrievalQuery(post, theme), deps.config.kbTopK);

    try {
      const draft = await draftReply({
        post,
        theme,
        angle,
        chunks,
        tone: deps.kb.tone,
        maxChars: deps.config.replyMaxChars,
        constraints: deps.kb.constraints,
        editorial: buildEditorialMemory(deps.candidateLog),
        move,
        depth,
        posture: logged?.posture,
        avoidMoves: previousMoves.filter((m) => m !== move),
        avoidConcedeOpener: hasConcedeOpener(c.suggested_reply),
        previousReplies: previous,
        ...(conversational
          ? { lane: "conversational" as const, policy: deps.policy, lineType, energy: logged?.posture, chunks: [] }
          : {}),
        llm: deps.llm,
      });
      const input: CandidateInput = {
        id: c.id,
        tweet_id: c.tweet_id,
        tweet_url: c.tweet_url,
        author_handle: c.author_handle,
        tweet_text: c.tweet_text,
        suggested_reply: draft.suggested_reply,
        match_reason: c.match_reason,
        match_category: c.match_category,
        source: c.source,
        kb_refs: c.kb_refs,
        ...(draft.ai_tell_flags.length > 0 ? { ai_tell_flags: draft.ai_tell_flags } : {}),
      };
      await deps.postCandidates([input]);
      deps.state.regen_handled[c.tweet_id] = c.status_updated_at;
      if (logged) {
        deps.candidateLog.upsert({
          ...logged,
          replies: [...previous, draft.suggested_reply],
          moves: conversational ? [...usedTypes, lineType] : [...previousMoves, move],
        });
      }
      summary.regenerated += 1;
      deps.log.info(`regenerated reply for ${canonicalTweetUrl(post.author_handle, c.tweet_id)}`);
    } catch (err) {
      summary.failed += 1;
      deps.log.warn(`regen failed for ${c.tweet_url}: ${(err as Error).message}`);
    }
  }
  return summary;
}
