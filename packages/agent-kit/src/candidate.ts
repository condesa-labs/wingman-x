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
  tweet_url: z.string().url(),
  author_handle: z.string().min(1),
  tweet_text: z.string(),
  suggested_reply: z.string().min(1),
  match_reason: z.string(),
  match_category: MatchCategorySchema,
  kb_refs: z.array(z.string()).optional(),
  created_at: z.string().datetime().optional(),
  status: StatusSchema.optional(),
  status_updated_at: z.string().datetime().optional(),
});
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

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
