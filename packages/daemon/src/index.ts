import { buildServer } from "./server.js";
import {
  chooseAndBindPort,
  NoAvailablePortError,
} from "./port.js";

/**
 * Main entry point. Build the server, bind to the first available port
 * in the configured range, and keep the process alive. On port
 * exhaustion, emit the grep-able error line and exit non-zero as the
 * CP02 acceptance criteria require.
 */
export async function main(): Promise<void> {
  const app = await buildServer();
  try {
    await chooseAndBindPort(app);
  } catch (err) {
    if (err instanceof NoAvailablePortError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
