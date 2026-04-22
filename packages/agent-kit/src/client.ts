// RED-phase stub. Real implementation lands in GREEN.
import type { CandidateInput, Candidate } from "./candidate.js";

export type DaemonAction = "filled" | "dismissed" | "saved" | "regen_requested";

export interface DaemonClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface DaemonClient {
  postCandidates(cs: CandidateInput[]): Promise<{ accepted: number }>;
  getCandidates(): Promise<Candidate[]>;
  postAction(id: string, action: DaemonAction): Promise<void>;
  getConfig(): Promise<{ kb_dir: string; port: number }>;
}

export function createDaemonClient(
  _port: number,
  _opts?: DaemonClientOptions,
): DaemonClient {
  const stub = async (): Promise<never> => {
    throw new Error("createDaemonClient: not implemented (RED)");
  };
  return {
    postCandidates: stub as DaemonClient["postCandidates"],
    getCandidates: stub as DaemonClient["getCandidates"],
    postAction: stub as DaemonClient["postAction"],
    getConfig: stub as DaemonClient["getConfig"],
  };
}
