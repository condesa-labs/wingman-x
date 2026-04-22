import { buildServer } from "../src/server.js";

const port = Number(process.env.PORT ?? 53827);

const app = await buildServer();
await app.listen({ port, host: "127.0.0.1" });
