import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/**
 * Small mutable state beside the processed log: when the last scan ran
 * (to anchor `since`) and which regen requests we have already served
 * (keyed by the candidate's `status_updated_at`, so a fresh click on
 * ♻️ after we redrafted is served again).
 */
export const ScanStateSchema = z.object({
  last_scan_started_at: z.string().optional(),
  last_scan_completed_at: z.string().optional(),
  regen_handled: z.record(z.string(), z.string()).default({}),
});
export type ScanState = z.infer<typeof ScanStateSchema>;

export function loadScanState(path: string): ScanState {
  if (!existsSync(path)) return ScanStateSchema.parse({});
  try {
    const parsed = ScanStateSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : ScanStateSchema.parse({});
  } catch {
    return ScanStateSchema.parse({});
  }
}

/** Atomic write: tmp + fsync + rename, same discipline as the daemon. */
export function saveScanState(path: string, state: ScanState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Where to start this scan from. We overlap the previous scan by one hour
 * so a post published while the last scan ran is not lost; dedupe makes
 * the overlap free.
 */
export function computeSince(
  state: ScanState,
  lookbackHours: number,
  now: Date,
  overlapMs = 60 * 60 * 1000,
): Date {
  const floor = now.getTime() - lookbackHours * 3600 * 1000;
  const last = state.last_scan_started_at ? Date.parse(state.last_scan_started_at) : NaN;
  if (Number.isFinite(last)) {
    return new Date(Math.max(floor, last - overlapMs));
  }
  return new Date(floor);
}
