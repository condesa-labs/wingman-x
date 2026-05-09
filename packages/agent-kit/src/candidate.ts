import { z } from "zod";

/**
 * Candidate-status lifecycle.
 *
 * The spec's Data-Schema section enumerates four statuses:
 *   `pending | filled | dismissed | saved`.
 *
 * CP06 widened the daemon's runtime enum with `regen_requested` (see
 * `packages/daemon/src/schemas.ts`). Since the agent-kit consumes the
 * daemon's real output, we accept the widened set here too. Rejecting
 * `regen_requested` would make the client unusable against a daemon
 * that legitimately transitioned a candidate via the regen button —
 * that's a goal-breaking choice. Documented in output-summary.md.
 */
export const StatusSchema = z.enum([
  "pending",
  "filled",
  "dismissed",
  "saved",
  "regen_requested",
]);
export type Status = z.infer<typeof StatusSchema>;

export const MatchCategorySchema = z.enum(["selected", "topic", "trending"]);
export type MatchCategory = z.infer<typeof MatchCategorySchema>;

export const CandidateSourceSchema = z.enum(["handles", "viral_pool"]);
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

/**
 * Must match `packages/daemon/src/schemas.ts#TWEET_URL_RE` verbatim.
 * Kept duplicated here (rather than imported) so agent-kit stays a
 * small, self-contained surface with no daemon-runtime dependency.
 * Integration test proves the two regexes agree.
 */
const TWEET_URL_RE =
  /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+(?:[/?#].*)?$/;

const TweetUrlSchema = z
  .string()
  .url()
  .refine((v) => TWEET_URL_RE.test(v), {
    message:
      "tweet_url must be an https://twitter.com or https://x.com /<handle>/status/<id> URL",
  });

/**
 * `CandidateInput` — what the agent POSTs. Server-managed fields
 * (`status`, `status_updated_at`, `created_at`) are optional on input;
 * the server fills them in if omitted. `kb_refs` defaults to `[]` on
 * the server so we treat it as optional here as well.
 *
 * This schema deliberately duplicates the daemon's schema rather than
 * importing from the daemon package. Reasons:
 *   1. `@twitter-helper/agent-kit` is what agents import. We want it to
 *      be a small, self-contained typed surface — pulling in the
 *      daemon's Fastify deps as a transitive would bloat agents.
 *   2. The integration test round-trips the shape through the real
 *      daemon, so any drift between the two zod schemas is caught
 *      immediately.
 */
export const CandidateInputSchema = z.object({
  id: z.string().min(1),
  tweet_id: z.string().min(1),
  tweet_url: TweetUrlSchema,
  author_handle: z.string().min(1),
  tweet_text: z.string(),
  suggested_reply: z.string().min(1),
  match_reason: z.string(),
  match_category: MatchCategorySchema,
  source: CandidateSourceSchema.default("handles"),
  kb_refs: z.array(z.string()).optional(),
  created_at: z.string().datetime().optional(),
  status: StatusSchema.optional(),
  status_updated_at: z.string().datetime().optional(),
});
export type CandidateInput = z.input<typeof CandidateInputSchema>;

/**
 * `Candidate` — the fully-formed record the daemon returns. All
 * server-managed fields are guaranteed present.
 */
export const CandidateSchema = CandidateInputSchema.extend({
  kb_refs: z.array(z.string()),
  created_at: z.string().datetime(),
  status: StatusSchema,
  status_updated_at: z.string().datetime(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/**
 * Response validators — used by popup / content-script to confirm that
 * a 2xx on the cached port actually came from the daemon (not a
 * co-located local HTTP service that happens to be listening on the
 * stale port — review-loop f12). On shape mismatch the caller should
 * treat the response as a stale-cache signal and `invalidate_port` +
 * retry once.
 */
export const CandidatesListResponseSchema = z.object({
  candidates: z.array(CandidateSchema),
});
export type CandidatesListResponse = z.infer<
  typeof CandidatesListResponseSchema
>;

export const SuggestionResponseSchema = CandidateSchema;
export type SuggestionResponse = z.infer<typeof SuggestionResponseSchema>;
