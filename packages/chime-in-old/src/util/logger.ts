export interface Logger {
  info(line: string): void;
  warn(line: string): void;
  debug(line: string): void;
}

export function createLogger(options: { verbose?: boolean; sink?: (line: string) => void } = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  return {
    info: (line) => sink(line),
    warn: (line) => sink(`! ${line}`),
    debug: (line) => {
      if (options.verbose) sink(`  · ${line}`);
    },
  };
}

export const silentLogger: Logger = { info: () => undefined, warn: () => undefined, debug: () => undefined };
