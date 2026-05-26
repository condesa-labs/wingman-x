import { KBAdapterError } from "./errors.js";
import type { HandleSet, HandleTier } from "./schemas.js";

type MutableTier = HandleTier;

function fail(adapterName: string, lineNumber: number, message: string): never {
  throw new KBAdapterError("CONFIG_INVALID", adapterName, `handles.md line ${lineNumber}: ${message}`);
}

function parseTierHeader(line: string): Pick<HandleTier, "tier" | "label"> | null {
  const match = /^## Tier ([123]): (.*)$/.exec(line);
  if (!match) {
    return null;
  }

  const tier = Number(match[1] as string) as 1 | 2 | 3;
  return { tier, label: match[2] as string };
}

/**
 * Parse the canonical Markdown-native handles format into a HandleSet.
 * Format (per brainstormed Section 4.2):
 *   # Optional H1 title
 *   ## Tier 1: <label>
 *   *Policy: every-run | sampled | manual*
 *   *Count: <n>*
 *   - @handle1
 *   - @handle2 (notes)
 *   ## Tier 2: <label>
 *   ...
 * Empty handles.md (or zero tiers) parses to { tiers: [] } — valid HandleSet.
 * Malformed input (unparseable tier header etc.) throws KBAdapterError
 * CONFIG_INVALID with the source line number.
 */
export function parseHandles(markdown: string, adapterName: string): HandleSet {
  if (markdown.trim() === "") {
    return { tiers: [] };
  }

  const tiers: MutableTier[] = [];
  let currentTier: MutableTier | undefined;
  let seenTier = false;

  const lines = markdown.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }

    if (line.startsWith("## ")) {
      const header = parseTierHeader(line);
      if (!header) {
        fail(adapterName, lineNumber, "unparseable tier header");
      }
      currentTier = { ...header, handles: [] };
      tiers.push(currentTier);
      seenTier = true;
      continue;
    }

    if (!seenTier) {
      if (line.startsWith("# ")) {
        continue;
      }
      fail(adapterName, lineNumber, "unexpected content before first tier");
    }

    if (!currentTier) {
      fail(adapterName, lineNumber, "content is not inside a tier");
    }

    if (line.startsWith("*Policy:")) {
      const match = /^\*Policy: (every-run|sampled|manual)\*$/.exec(line);
      if (!match) {
        fail(adapterName, lineNumber, "invalid policy line");
      }
      currentTier.policy = match[1] as "every-run" | "sampled" | "manual";
      continue;
    }

    if (line.startsWith("*Count:")) {
      if (!/^\*Count: \d+\*$/.test(line)) {
        fail(adapterName, lineNumber, "invalid count line");
      }
      continue;
    }

    if (line.startsWith("- ")) {
      const match = /^- @([A-Za-z0-9_]{1,15})(?: \((.*)\))?$/.exec(line);
      if (!match) {
        fail(adapterName, lineNumber, "invalid handle line");
      }
      currentTier.handles.push({
        handle: match[1] as string,
        ...(match[2] !== undefined ? { notes: match[2] } : {}),
      });
      continue;
    }

    fail(adapterName, lineNumber, "unrecognized handles grammar line");
  }

  if (
    tiers.length === 1 &&
    tiers[0]?.tier === 1 &&
    tiers[0].label === "(empty)" &&
    tiers[0].handles.length === 0
  ) {
    return { tiers: [] };
  }

  return { tiers };
}

function collectDroppedFields(set: HandleSet): string[] {
  const dropped = new Set<string>();
  for (const tier of set.tiers) {
    for (const handle of tier.handles) {
      if (handle.tags !== undefined) {
        dropped.add("Handle.tags");
      }
    }
  }
  if (set.meta !== undefined) {
    dropped.add("HandleSet.meta");
  }

  return [...dropped];
}

/**
 * Inverse of parseHandles. Always emits a parseable shape; empty HandleSet
 * produces a minimal "## Tier 1: (empty)" stub so downstream readers still
 * get a valid file.
 *
 * When `set` contains fields not encodable by the v1 grammar (Handle.tags,
 * HandleSet.meta), those fields are dropped and the optional log callback
 * receives a `{ event: 'handles_grammar_lossy', dropped: [...] }` JSON line.
 * Resolves Codex fresh-final f23 — without the explicit log parameter, the
 * lossy-warning requirement was unimplementable.
 */
export function serializeHandles(set: HandleSet, opts?: { log?: (line: string) => void }): string {
  const dropped = collectDroppedFields(set);
  if (dropped.length > 0) {
    opts?.log?.(JSON.stringify({ event: "handles_grammar_lossy", dropped }));
  }

  if (set.tiers.length === 0) {
    return "## Tier 1: (empty)\n*Count: 0*\n";
  }

  const lines: string[] = [];
  for (const [index, tier] of set.tiers.entries()) {
    if (index > 0) {
      lines.push("");
    }
    lines.push(`## Tier ${tier.tier}: ${tier.label}`);
    if (tier.policy !== undefined) {
      lines.push(`*Policy: ${tier.policy}*`);
    }
    lines.push(`*Count: ${tier.handles.length}*`);
    for (const handle of tier.handles) {
      lines.push(`- @${handle.handle}${handle.notes !== undefined ? ` (${handle.notes})` : ""}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
