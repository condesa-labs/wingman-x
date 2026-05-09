export function parseJsonArrayEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = (message) => process.stderr.write(message),
): string[] | null {
  const raw = env[name];
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // fall through to warning below
  }
  warn(
    `watcher warning: ${name} must be a JSON string array; using default scraper args\n`,
  );
  return null;
}
