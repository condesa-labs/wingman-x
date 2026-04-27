import { z } from "zod";

/**
 * Pull-signal schemas — mirror of the daemon's
 * `packages/daemon/src/schemas.ts` Signal* definitions.
 *
 * Duplicated here (rather than imported from the daemon) for the same
 * reason CandidateSchema is: agent-kit is the public surface agents
 * depend on, and pulling in the daemon's Fastify tree as a transitive
 * would bloat every agent that wants the typed client. The integration
 * test round-trips through a real daemon so any drift surfaces loudly.
 */
export const SignalKindSchema = z.enum(["discovery_requested"]);
export type SignalKind = z.infer<typeof SignalKindSchema>;

export const SignalStatusSchema = z.enum(["pending", "acked"]);
export type SignalStatus = z.infer<typeof SignalStatusSchema>;

export const SignalMetaSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type SignalMeta = z.infer<typeof SignalMetaSchema>;

export const SignalInputSchema = z.object({
  kind: SignalKindSchema,
  meta: SignalMetaSchema.optional(),
});
export type SignalInput = z.infer<typeof SignalInputSchema>;

export const SignalSchema = z.object({
  id: z.uuid(),
  kind: SignalKindSchema,
  status: SignalStatusSchema,
  meta: SignalMetaSchema.optional(),
  created_at: z.iso.datetime(),
  acked_at: z.iso.datetime().optional(),
});
export type Signal = z.infer<typeof SignalSchema>;

export interface SignalsQuery {
  kind?: SignalKind;
  status?: SignalStatus;
  limit?: number;
  cursor?: string;
}

export const SignalsListResponseSchema = z.object({
  signals: z.array(SignalSchema),
  nextCursor: z.string().optional(),
});
export type SignalsListResponse = z.infer<typeof SignalsListResponseSchema>;
