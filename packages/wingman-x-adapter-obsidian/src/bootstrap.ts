import type { BootstrapOptions, ToneResult } from "@wingman-x/kb-contract";

const BASE_TEMPLATE = `# WingmanX Tone Bootstrap

Use this offline scaffold to draft a first-pass tone guide from representative writing.

## Voice DNA

- Default stance:
- Sentence rhythm:
- Vocabulary to prefer:
- Vocabulary to avoid:
- Evidence and citation habits:
- Boundaries and red lines:

## Extraction Prompt

Paste 5-10 representative writing samples below this prompt and ask your own LLM to extract a reusable Voice DNA guide. Preserve concrete phrasing patterns, decision rules, recurring objections, and examples of what to avoid. Return concise markdown that can become the vault's tone source.
`;

export function bootstrapTone(opts?: BootstrapOptions): ToneResult {
  const hint = opts?.hint?.trim();
  const markdown =
    hint === undefined || hint.length === 0
      ? BASE_TEMPLATE
      : `${BASE_TEMPLATE}\nAdditional user hint:\n${hint}\n`;

  return {
    markdown,
    meta: {
      source: "adapter-obsidian:bootstrap",
      language: "en",
      tags: ["bootstrap", "tone"],
    },
  };
}
