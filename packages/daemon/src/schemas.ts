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

const IsoDateTimeStringSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: "must be a parseable date-time string" },
);

const CountSchema = z.number().int().min(0);

export const ObservedTweetInputSchema = z.object({
  tweet_id: z.string().min(1),
  tweet_url: TweetUrlSchema,
  author_handle: z.string().min(1),
  tweet_text: z.string(),
  views: CountSchema,
  likes: CountSchema,
  retweets: CountSchema,
  replies: CountSchema,
  bookmarks: CountSchema,
  created_at: IsoDateTimeStringSchema,
});
export type ObservedTweetInput = z.infer<typeof ObservedTweetInputSchema>;

export const ObservedTweetSchema = ObservedTweetInputSchema.extend({
  observed_at: z.iso.datetime(),
  score: z.number().int().min(0).max(100),
});
export type ObservedTweet = z.infer<typeof ObservedTweetSchema>;

export const PostObservedTweetsBodySchema = z.object({
  tweets: z.array(ObservedTweetInputSchema).min(1),
});

export const TweetPoolTopQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .transform((value) => Math.min(value, 100)),
  min_score: z.coerce.number().min(0).max(100).default(0),
});

export const CandidateSourceSchema = z.enum(["handles", "viral_pool"]);
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

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
  source: CandidateSourceSchema.default("handles"),
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

/**
 * Agent-pull signal — an extension-authored "please do X" nudge the
 * agent picks up on its next session. Mirrors the shape of the existing
 * per-candidate `action=regen_requested` pattern, but at global scope.
 *
 * The initial (and only) kind is `discovery_requested`: the popup's
 * "Request discovery" button fires it, the agent's discover skill acks
 * it after handling the run. `meta` is reserved for future filter
 * parameters (e.g., `{tier: "1"}`) without breaking the schema.
 */
export const SignalKindEnum = z.enum(["discovery_requested"]);
export type SignalKind = z.infer<typeof SignalKindEnum>;

export const SignalStatusEnum = z.enum(["pending", "acked"]);
export type SignalStatus = z.infer<typeof SignalStatusEnum>;

/**
 * Optional caller-supplied metadata. Bounded to primitives so signals
 * stay flat, serializable, and cheap to filter. Rejecting nested
 * objects/arrays also keeps the daemon from becoming an accidental
 * general-purpose K/V store.
 */
export const SignalMetaSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type SignalMeta = z.infer<typeof SignalMetaSchema>;

export const SignalInputSchema = z.object({
  kind: SignalKindEnum,
  meta: SignalMetaSchema.optional(),
});
export type SignalInput = z.infer<typeof SignalInputSchema>;

export const SignalSchema = z.object({
  id: z.uuid(),
  kind: SignalKindEnum,
  status: SignalStatusEnum,
  meta: SignalMetaSchema.optional(),
  created_at: z.iso.datetime(),
  acked_at: z.iso.datetime().optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

export const DEFAULT_SIGNALS_LIMIT = 50;
export const MAX_SIGNALS_LIMIT = 100;

export const SignalsQuerySchema = z.object({
  kind: SignalKindEnum.optional(),
  status: SignalStatusEnum.optional().default("pending"),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_SIGNALS_LIMIT)
    .default(DEFAULT_SIGNALS_LIMIT),
  cursor: z.string().min(1).optional(),
});

export const StateFileSchema = z.object({
  port: z.number().int().optional(),
  candidates: z.record(z.string(), CandidateSchema).default({}),
  signals: z.record(z.string(), SignalSchema).default({}),
  tweet_pool: z.record(z.string(), ObservedTweetSchema).default({}),
  config: z
    .object({
      kb_dir: z.string(),
    })
    .default({ kb_dir: "~/.twitter-helper/kb" }),
});
export type StateFile = z.infer<typeof StateFileSchema>;
