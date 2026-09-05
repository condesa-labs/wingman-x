import { existsSync, readFileSync } from "node:fs";

/** Default themes: broad lanes, not sub-topics. A narrow list makes the classifier fuss over labels; a broad one lets the response stage do the thinking. Override with `<chimeDir>/themes.txt`, one per line. */
export const DEFAULT_THEMES: readonly string[] = [
  "Tokenization and market structure",
  "Credit and collateral",
  "Credit card receivables",
  "Stablecoins",
  "DeFi market structure",
  "AI in financial workflows",
  "Payments and fintech",
  "Regulation and policy",
  "Technology and startups",
  "General and internet culture",
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
