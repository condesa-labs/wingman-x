import { z } from "zod";

export interface ObsidianConfig {
  vaultPath: string;
  wingmanRoot: string;
  toneFile: string;
  libraryFolder: string;
  handlesFile: string;
  followObsidianLinks: boolean;
}

export const configSchema: z.ZodType<ObsidianConfig> = z
  .object({
    vaultPath: z.string().min(1).describe("Path to the Obsidian vault root directory."),
    wingmanRoot: z
      .string()
      .min(1)
      .default("WingmanX")
      .describe("Folder inside the vault that contains WingmanX knowledge files."),
    toneFile: z
      .string()
      .min(1)
      .default("VOICE.md")
      .describe("Markdown file name for the WingmanX tone guide."),
    libraryFolder: z
      .string()
      .min(1)
      .default("library")
      .describe("Folder name under the WingmanX root that contains library Markdown files."),
    handlesFile: z
      .string()
      .min(1)
      .default("handles.md")
      .describe("Markdown file name for WingmanX handle tiers."),
    followObsidianLinks: z
      .boolean()
      .default(false)
      .describe("Whether to follow Obsidian wiki-links while reading vault content."),
  })
  .strict();
