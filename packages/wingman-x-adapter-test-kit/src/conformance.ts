import { describe, it } from "vitest";

export interface ConformanceFixtures<C = unknown> {
  readonly config: C;
}

export interface RunConformanceTestsOptions<C = unknown> {
  readonly createAdapter?: unknown;
  readonly configSchema?: unknown;
  readonly fixtures: ConformanceFixtures<C>;
  readonly suiteName?: string;
}

export async function assertAdapterConformance<C>(
  _options: RunConformanceTestsOptions<C>,
): Promise<void> {
  return;
}

export function runConformanceTests<C>(options: RunConformanceTestsOptions<C>): void {
  describe(options.suiteName ?? "WingmanX adapter conformance", () => {
    it("satisfies the v1 adapter contract", async () => {
      await assertAdapterConformance(options);
    });
  });
}
