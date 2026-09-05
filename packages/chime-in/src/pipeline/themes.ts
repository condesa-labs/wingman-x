import { existsSync, readFileSync } from "node:fs";

/** Initial themes from the product spec. Override with `<chimeDir>/themes.txt`, one per line. */
export const DEFAULT_THEMES: readonly string[] = [
  "Tokenization",
  "Real world assets",
  "Institutional crypto",
  "Stablecoins",
  "Private credit",
  "Credit card receivables",
  "Asset backed finance",
  "Fund finance",
  "NAV lending",
  "DeFi lending",
  "Collateral management",
  "Custody",
  "Securities infrastructure",
  "Transfer agency",
  "Settlement",
  "Onchain capital markets",
  "Tokenized equities",
  "Market structure",
  "Fintech",
  "AI in financial services",
];

export function parseThemes(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim().replace(/^[-*]\s+/, "");
    if (!t || t.startsWith("#")) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function loadThemes(path: string): string[] {
  if (!existsSync(path)) return [...DEFAULT_THEMES];
  const parsed = parseThemes(readFileSync(path, "utf8"));
  return parsed.length > 0 ? parsed : [...DEFAULT_THEMES];
}
