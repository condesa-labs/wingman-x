import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FsConfig {
  rootPath?: string;
}

export const WINGMAN_X_STATE_DIR_ENV = "WINGMAN_X_STATE_DIR";
export const DEFAULT_STATE_SUBDIR = ".wingman-x";
export const KB_DIR_NAME = "kb";

export const configSchema: z.ZodType<FsConfig> = z.object({
  rootPath: z.string().min(1).optional(),
}).strict();

export function resolveRootPath(config: FsConfig): string {
  if (config.rootPath !== undefined) {
    return config.rootPath;
  }

  const override = process.env[WINGMAN_X_STATE_DIR_ENV];
  if (override !== undefined && override.length > 0) {
    return join(override, KB_DIR_NAME);
  }

  return join(homedir(), DEFAULT_STATE_SUBDIR, KB_DIR_NAME);
}
