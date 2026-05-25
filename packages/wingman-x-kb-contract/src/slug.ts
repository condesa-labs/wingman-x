/**
 * Derive a kebab-case ASCII id from a string. Lowercase, replace any non-[a-z0-9]
 * run with a single hyphen, trim leading/trailing hyphens. Used by adapters for
 * library entry id derivation. Lives in the contract package so adapters never
 * depend on each other.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
