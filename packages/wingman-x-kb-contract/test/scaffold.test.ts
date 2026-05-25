import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const packageRoot = resolve(repoRoot, "packages/wingman-x-kb-contract");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("@wingman-x/kb-contract package scaffold", () => {
  it("is registered as a workspace with the expected library manifest shape", () => {
    const rootPackageJson = readJson(resolve(repoRoot, "package.json")) as {
      workspaces?: string[];
    };
    expect(rootPackageJson.workspaces).toContain("packages/wingman-x-kb-contract");

    const manifestPath = resolve(packageRoot, "package.json");
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = readJson(manifestPath);
    expect(manifest).toMatchObject({
      name: "@wingman-x/kb-contract",
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
        zod: "^4.3.6",
      },
    });
    expect(Object.keys((manifest as { dependencies?: Record<string, string> }).dependencies ?? {})).toEqual([
      "zod",
    ]);
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
        "console.log(import.meta.resolve('@wingman-x/kb-contract'))",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(
      /(?:node_modules\/@wingman-x\/kb-contract|packages\/wingman-x-kb-contract)\/dist\/index\.js$/,
    );
    expect(realpathSync(resolve(repoRoot, "node_modules/@wingman-x/kb-contract"))).toBe(
      packageRoot,
    );
  });
});
