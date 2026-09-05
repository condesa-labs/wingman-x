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
import { draftReply } from "./stages/draft.js";
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
  log: Logger;
  now?: () => Date;
}

export interface RegenSummary {
  requested: number;
  regenerated: number;
  failed: number;
}

export function pendingRegens(candidates: Candidate[], state: ScanState): Candidate[] {
  return candidates.filter(
    (c) =>
      c.status === "regen_requested" &&
      c.id.startsWith("chime-") &&
      state.regen_handled[c.tweet_id] !== c.status_updated_at,
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
  const pending = pendingRegens(candidates, deps.state);
  const summary: RegenSummary = { requested: pending.length, regenerated: 0, failed: 0 };
  if (pending.length === 0) return summary;
  deps.log.info(`${pending.length} regeneration request(s) pending`);

  for (const c of pending) {
    const logged = deps.candidateLog.get(c.tweet_id);
    const post = logged?.post ?? postFromCandidate(c, now().toISOString());
    const theme = logged?.theme ?? "unknown";
    const angle =
      logged?.contribution_angle ?? parseAngleFromMatchReason(c.match_reason) ?? "Add the most specific, non-obvious point the knowledge base supports.";
    const previous = Array.from(new Set([...(logged?.replies ?? []), c.suggested_reply]));
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
        previousReplies: previous,
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
        deps.candidateLog.upsert({ ...logged, replies: [...previous, draft.suggested_reply] });
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
