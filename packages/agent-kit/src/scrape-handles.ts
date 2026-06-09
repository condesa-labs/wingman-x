import type { HandleSet } from "@wingman-x/kb-contract";

export function selectScrapeHandles(handleSet: HandleSet): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();

  for (const tier of handleSet.tiers) {
    if (tier.policy !== "every-run") continue;
    for (const entry of tier.handles) {
      const handle = entry.handle.startsWith("@")
        ? entry.handle.slice(1)
        : entry.handle;
      const key = handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      selected.push(handle);
    }
  }

  return selected;
}
