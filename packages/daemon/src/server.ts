import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
) as { version: string };

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.get("/health", async () => {
    return { status: "ok", version: pkg.version };
  });

  return app;
}
