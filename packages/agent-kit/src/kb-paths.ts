import { homedir } from "node:os";
import { join } from "node:path";

export const WINGMAN_X_STATE_DIR_ENV = "WINGMAN_X_STATE_DIR";
export const DEFAULT_WINGMAN_X_STATE_SUBDIR = ".wingman-x";
export const WINGMAN_X_CONFIG_FILE = "config.json";
export const WINGMAN_X_CACHE_DIR = "cache";
export const WINGMAN_X_GENERATIONS_DIR = "generations";

export interface KBAdapterCachePaths {
  stateDir: string;
  cacheParent: string;
  adapterCacheDir: string;
  generationsDir: string;
  currentPath: string;
  currentTmpPath: string;
  lockPath: string;
}

export function resolveWingmanXStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WINGMAN_X_STATE_DIR_ENV];
  if (override !== undefined && override.length > 0) {
    return override;
  }

  return join(homedir(), DEFAULT_WINGMAN_X_STATE_SUBDIR);
}

export function resolveWingmanXConfigPath(stateDir = resolveWingmanXStateDir()): string {
  return join(stateDir, WINGMAN_X_CONFIG_FILE);
}

export function resolveKBCachePaths(
  adapterName: string,
  stateDir = resolveWingmanXStateDir(),
): KBAdapterCachePaths {
  const cacheParent = join(stateDir, WINGMAN_X_CACHE_DIR);
  const adapterCacheDir = join(cacheParent, adapterName);
  const generationsDir = join(adapterCacheDir, WINGMAN_X_GENERATIONS_DIR);
  const currentPath = join(adapterCacheDir, "CURRENT");

  return {
    stateDir,
    cacheParent,
    adapterCacheDir,
    generationsDir,
    currentPath,
    currentTmpPath: `${currentPath}.tmp`,
    lockPath: join(cacheParent, `.${adapterName}.refresh.lock`),
  };
}
