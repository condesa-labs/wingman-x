import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runConformanceTests } from "../src/index.js";
import {
  assertAdapterConformance,
  type RunConformanceTestsOptions,
} from "../src/conformance.js";
import * as duplicateLibraryIds from "./fakes/duplicate-library-ids.js";
import * as invalidHandlesPayload from "./fakes/invalid-handles-payload.js";
import * as invalidLibraryContentPayload from "./fakes/invalid-library-content-payload.js";
import * as invalidTonePayload from "./fakes/invalid-tone-payload.js";
import * as minimalConforming from "./fakes/minimal-conforming.js";
import * as missingConfigSchema from "./fakes/missing-config-schema.js";
import * as missingHealthCheck from "./fakes/missing-health-check.js";
import * as nonEnumErrorCode from "./fakes/non-enum-error-code.js";
import * as nonKebabCaseId from "./fakes/non-kebab-case-id.js";
import * as optionalCapabilitiesNoop from "./fakes/optional-capabilities-noop.js";
import * as optionalCapabilitiesOmitted from "./fakes/optional-capabilities-omitted.js";
import * as unstableListLibrary from "./fakes/unstable-list-library.js";
import * as wrongSchemaVersion from "./fakes/wrong-schema-version.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(repoRoot, "packages/wingman-x-adapter-test-kit");

type FakeModule = Record<string, unknown> & {
  fixtures?: { config: unknown };
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function optionsFrom(module: FakeModule): RunConformanceTestsOptions {
  return {
    createAdapter: module.createAdapter,
    configSchema: module.configSchema,
    fixtures: module.fixtures ?? { config: {} },
  };
}

describe("@wingman-x/adapter-test-kit package scaffold", () => {
  it("is registered as a workspace with the expected manifest shape", () => {
    const rootPackageJson = readJson(resolve(repoRoot, "package.json")) as {
      workspaces?: string[];
    };
    expect(rootPackageJson.workspaces).toContain("packages/wingman-x-adapter-test-kit");

    const manifestPath = resolve(packageRoot, "package.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readJson(manifestPath);
    expect(manifest).toMatchObject({
      name: "@wingman-x/adapter-test-kit",
      private: true,
      type: "module",
      main: "dist/index.js",
      types: "dist/index.d.ts",
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
      },
      files: ["dist", "src"],
      dependencies: {
        "@wingman-x/kb-contract": "*",
        zod: "^4.3.6",
        vitest: "^2.1.8",
      },
    });
    expect((manifest as { dependencies?: Record<string, string> }).dependencies).toEqual({
      "@wingman-x/kb-contract": "*",
      zod: "^4.3.6",
      vitest: "^2.1.8",
    });
  });

  it("has TypeScript and Vitest configuration matching the scaffold contract", () => {
    const tsconfigPath = resolve(packageRoot, "tsconfig.json");
    const buildConfigPath = resolve(packageRoot, "tsconfig.build.json");
    const vitestConfigPath = resolve(packageRoot, "vitest.config.ts");
    const indexPath = resolve(packageRoot, "src/index.ts");

    expect(existsSync(tsconfigPath)).toBe(true);
    expect(existsSync(buildConfigPath)).toBe(true);
    expect(existsSync(vitestConfigPath)).toBe(true);
    expect(existsSync(indexPath)).toBe(true);

    const tsconfig = readJson(tsconfigPath);
    expect(tsconfig).toMatchObject({
      extends: "../../tsconfig.base.json",
    });

    const buildConfig = readJson(buildConfigPath);
    expect(buildConfig).toMatchObject({
      extends: "./tsconfig.json",
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
      },
    });
    expect((buildConfig as { exclude?: string[] }).exclude).toContain("test/**/*.ts");
    expect((buildConfig as { exclude?: string[] }).exclude).toContain("**/*.test.ts");

    const vitestConfig = readFileSync(vitestConfigPath, "utf8");
    expect(vitestConfig).toContain('provider: "v8"');
    expect(vitestConfig).toContain('exclude: ["src/index.ts", "**/*.d.ts"]');
    expect(vitestConfig).toContain("lines: 85");
    expect(vitestConfig).toContain("statements: 85");
    expect(vitestConfig).toContain("functions: 85");
    expect(vitestConfig).toContain("branches: 85");
  });

  it("resolves the package entrypoint by its public import specifier", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "console.log(import.meta.resolve('@wingman-x/adapter-test-kit'))",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(
      /(?:node_modules\/@wingman-x\/adapter-test-kit|packages\/wingman-x-adapter-test-kit)\/dist\/index\.js$/,
    );
    expect(realpathSync(resolve(repoRoot, "node_modules/@wingman-x/adapter-test-kit"))).toBe(
      packageRoot,
    );
  });
});

describe("public barrel exports", () => {
  it("exports runConformanceTests as the only runtime symbol", () => {
    expect({ runConformanceTests }).toEqual({ runConformanceTests: expect.any(Function) });
  });
});

describe("runConformanceTests public suite", () => {
  runConformanceTests({
    ...optionsFrom(minimalConforming),
    suiteName: "minimal conforming fake adapter",
  });
});

describe("adapter conformance assertion", () => {
  it.each([
    ["minimal conforming adapter", minimalConforming],
    ["optional capabilities omitted", optionalCapabilitiesOmitted],
    ["optional capabilities present as no-op", optionalCapabilitiesNoop],
  ])("accepts %s", async (_name, module) => {
    await expect(assertAdapterConformance(optionsFrom(module))).resolves.toBeUndefined();
  });

  it.each([
    ["wrong schemaVersion", wrongSchemaVersion, /schemaVersion/],
    ["non-kebab-case id", nonKebabCaseId, /LibraryEntrySchema/],
    ["unstable listLibrary", unstableListLibrary, /listLibrary.*stable/],
    ["missing healthCheck", missingHealthCheck, /healthCheck.*function/],
    ["thrown error with non-enum code", nonEnumErrorCode, /undocumented.*code/],
    ["invalid tone payload", invalidTonePayload, /ToneResultSchema/],
    ["invalid handles payload", invalidHandlesPayload, /HandleSetSchema/],
    ["invalid library content payload", invalidLibraryContentPayload, /LibraryContentSchema/],
    ["duplicate library ids", duplicateLibraryIds, /duplicate.*LibraryEntry.id/],
    ["missing configSchema export", missingConfigSchema, /configSchema.*Zod/],
  ])("rejects %s", async (_name, module, message) => {
    await expect(assertAdapterConformance(optionsFrom(module))).rejects.toThrow(message);
  });
});
