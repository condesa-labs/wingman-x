// RED-phase stub. Actual zod schema lands in GREEN; the types below are
// declared now so the test suite type-checks against a stable surface.

import { z } from "zod";

/**
 * The four-way status lifecycle from the spec's Data schema section
 * plus `regen_requested` (widened by the daemon in CP06 — documented in
 * daemon's `schemas.ts`). The agent-kit must accept both because it
 * consumes the daemon's real output.
 */
export type Status =
  | "pending"
  | "filled"
  | "dismissed"
  | "saved"
  | "regen_requested";

export type MatchCategory = "selected" | "topic" | "trending";

export interface CandidateInput {
  id: string;
  tweet_id: string;
  tweet_url: string;
  author_handle: string;
  tweet_text: string;
  suggested_reply: string;
  match_reason: string;
  match_category: MatchCategory;
  kb_refs?: string[];
  created_at?: string;
  status?: Status;
  status_updated_at?: string;
}

export interface Candidate extends CandidateInput {
  kb_refs: string[];
  created_at: string;
  status: Status;
  status_updated_at: string;
}

// RED stubs — the real schemas land in GREEN. z.object({}) is intentionally
// empty so the test's `CandidateSchema.parse(...)` call exists as a symbol
// for TypeScript but the behaviour is incorrect enough to fail.
export const CandidateInputSchema: z.ZodType<CandidateInput> =
  z.any() as unknown as z.ZodType<CandidateInput>;
export const CandidateSchema: z.ZodType<Candidate> =
  z.any() as unknown as z.ZodType<Candidate>;
