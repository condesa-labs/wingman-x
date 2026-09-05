export {
  createDaemonClient,
  type DaemonClient,
  type DaemonClientOptions,
  type DaemonAction,
} from "./client.js";
export {
  DaemonHttpError,
  DaemonTimeoutError,
  DaemonNetworkError,
} from "./errors.js";
export {
  CandidateInputSchema,
  CandidateSourceSchema,
  CandidateSchema,
  CandidatesListResponseSchema,
  SuggestionResponseSchema,
  type CandidateInput,
  type CandidateSource,
  type Candidate,
  type CandidatesListResponse,
  type SuggestionResponse,
} from "./candidate.js";
export {
  SignalKindSchema,
  SignalStatusSchema,
  SignalInputSchema,
  SignalSchema,
  SignalsListResponseSchema,
  type SignalKind,
  type SignalStatus,
  type SignalInput,
  type Signal,
  type SignalsQuery,
  type SignalsListResponse,
} from "./signal.js";
export {
  createKBLoader,
  type KBLoader,
  type KBLoaderOptions,
} from "./kb-loader.js";
export { detectAiTells, AI_TELL_PATTERNS } from "./watcher-core.js";
