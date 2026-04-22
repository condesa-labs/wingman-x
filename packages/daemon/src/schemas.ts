import { z } from "zod";

/**
 * Candidate status lifecycle.
 *
 * Note: the spec's top-level schema enumerates
 * `"pending" | "filled" | "dismissed" | "saved"`, but CP06 uses
 * `regen_requested` for the regen button and CP02's action endpoint must
 * accept that action. We therefore widen the runtime Status enum to
 * include `regen_requested` (the spec's Open Questions confirm this is a
 * valid terminal-ish status). Rule conflict noted in output-summary.md.
 */
export const StatusEnum = z.enum([
  "pending",
  "filled",
  "dismissed",
  "saved",
  "regen_requested",
]);
export type Status = z.infer<typeof StatusEnum>;

/**
 * Allowed values for POST /candidates/:id/action.body.action.
 * `pending` is excluded — it is the initial server-assigned value and not
 * a user-driven transition. All other Status values are reachable via an
 * explicit action.
 */
export const ActionEnum = z.enum([
  "filled",
  "dismissed",
  "saved",
  "regen_requested",
]);
export type Action = z.infer<typeof ActionEnum>;

/**
 * Tight validator for `tweet_url`: must be a twitter.com / x.com
 * status URL. The popup passes this value directly to
 * `chrome.tabs.create({url})`, so a loose `z.string().url()` would let a
 * misbehaving or malicious local client turn an "Open" click into
 * navigation to an arbitrary origin. Accepts:
 *   https://(www\.)?(twitter|x)\.com/<handle>/status/<digits>(/...)?
 */
const TWEET_URL_RE =
  /^https:\/\/(?:www\.)?(?:twitter|x)\.com\/[^/]+\/status\/\d+(?:[/?#].*)?$/;

export const TweetUrlSchema = z
  .string()
  .url()
  .refine((v) => TWEET_URL_RE.test(v), {
    message:
      "tweet_url must be an https://twitter.com or https://x.com /<handle>/status/<id> URL",
  });

/**
 * Incoming candidate — what the agent POSTs. Server-managed fields
 * (`status`, `status_updated_at`, `created_at`) are optional on input;
 * the server fills them in if omitted.
 */
export const CandidateInputSchema = z.object({
  id: z.string().min(1),
  tweet_id: z.string().min(1),
  tweet_url: TweetUrlSchema,
  author_handle: z.string().min(1),
  tweet_text: z.string(),
  suggested_reply: z.string().min(1),
  match_reason: z.string(),
  match_category: z.enum(["selected", "topic", "trending"]),
  kb_refs: z.array(z.string()).default([]),
  created_at: z.string().datetime().optional(),
  status: StatusEnum.optional(),
  status_updated_at: z.string().datetime().optional(),
});
export type CandidateInput = z.infer<typeof CandidateInputSchema>;

/**
 * Fully-formed Candidate as persisted and returned by GETs.
 */
export const CandidateSchema = CandidateInputSchema.extend({
  created_at: z.string().datetime(),
  status: StatusEnum,
  status_updated_at: z.string().datetime(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const PostCandidatesBodySchema = z.object({
  candidates: z.array(CandidateInputSchema).min(1),
});

export const SuggestionQuerySchema = z.object({
  tweet_id: z.string().min(1),
});

export const ActionBodySchema = z.object({
  action: ActionEnum,
});

export const StateFileSchema = z.object({
  port: z.number().int().optional(),
  candidates: z.record(z.string(), CandidateSchema).default({}),
  config: z
    .object({
      kb_dir: z.string(),
    })
    .default({ kb_dir: "~/.twitter-helper/kb" }),
});
export type StateFile = z.infer<typeof StateFileSchema>;
