import { z } from "zod";

export interface FsConfig {
  rootPath?: string;
}

export const configSchema: z.ZodType<FsConfig> = z.object({
  rootPath: z.string().min(1).optional(),
});

export function resolveRootPath(config: FsConfig): string {
  return config.rootPath ?? "";
}
