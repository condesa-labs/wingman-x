import { z } from "zod";

export const HealthReportSchema = z.object({
  ok: z.boolean(),
  stats: z.object({
    libraryCount: z.number().int().nonnegative(),
    handlesCount: z.number().int().nonnegative(),
    toneBytes: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

export const ToneResultSchema = z.object({
  markdown: z.string(),
  meta: z.object({
    version: z.string().optional(),
    language: z.string().optional(),
    updatedAt: z.iso.datetime().optional(),
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
});
export type ToneResult = z.infer<typeof ToneResultSchema>;

export const LibraryEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case ASCII").max(64),
  title: z.string(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  updatedAt: z.iso.datetime().optional(),
});
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export const LibraryContentSchema = LibraryEntrySchema.extend({
  markdown: z.string(),
  frontmatter: z.record(z.string(), z.unknown()).optional(),
});
export type LibraryContent = z.infer<typeof LibraryContentSchema>;

export const HandleSchema = z.object({
  handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/, "X/Twitter handle, no @ prefix"),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
});
export type Handle = z.infer<typeof HandleSchema>;

export const HandleTierSchema = z.object({
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  label: z.string(),
  policy: z.enum(["every-run", "sampled", "manual"]).optional(),
  handles: z.array(HandleSchema),
});
export type HandleTier = z.infer<typeof HandleTierSchema>;

export const HandleSetSchema = z.object({
  tiers: z.array(HandleTierSchema),
  meta: z
    .object({
      sourceUser: z.string().optional(),
      scrapedAt: z.iso.datetime().optional(),
      notes: z.string().optional(),
    })
    .optional(),
});
export type HandleSet = z.infer<typeof HandleSetSchema>;

export const KBEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("tone-changed") }),
  z.object({ kind: z.literal("library-changed"), ids: z.array(z.string()) }),
  z.object({ kind: z.literal("handles-changed") }),
]);
export type KBEvent = z.infer<typeof KBEventSchema>;

export const BootstrapOptionsSchema = z
  .object({
    maxBytes: z.number().int().positive().optional(),
    hint: z.string().optional(),
  })
  .optional();
export type BootstrapOptions = z.infer<typeof BootstrapOptionsSchema>;

export const WingmanXConfigSchema = z.object({
  version: z.literal(1),
  adapter: z.object({
    package: z
      .string()
      .min(1)
      .max(214)
      .regex(
        /^(@[a-z0-9][a-z0-9-_.]*\/)?[a-z0-9][a-z0-9-_.]*$/,
        "must be a valid npm package specifier (lowercase, optional @scope/, 1-214 chars)",
      ),
    name: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be kebab-case ASCII"),
    config: z.record(z.string(), z.unknown()),
  }),
  cache: z
    .object({
      ttlSeconds: z.number().int().positive().default(900),
      strategy: z.literal("stale-while-revalidate").default("stale-while-revalidate"),
    })
    .optional(),
});
export type WingmanXConfig = z.infer<typeof WingmanXConfigSchema>;
