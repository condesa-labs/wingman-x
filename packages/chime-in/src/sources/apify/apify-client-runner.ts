import { ApifyClient } from "apify-client";
import type { ActorRunner } from "./apify-source.js";

export interface ApifyRunnerOptions {
  token: string;
  actorId: string;
  timeoutSecs: number;
  log?: (line: string) => void;
}

/**
 * Production `ActorRunner`: call the actor, wait for it to finish, then
 * page through the default dataset. This is the only file that touches
 * the Apify SDK.
 */
export function createApifyClientRunner(options: ApifyRunnerOptions): ActorRunner {
  const client = new ApifyClient({ token: options.token });
  const log = options.log ?? (() => undefined);

  return async (input) => {
    const run = await client.actor(options.actorId).call(input, {
      waitSecs: options.timeoutSecs,
    });
    if (run.status !== "SUCCEEDED") {
      throw new Error(`apify run ${run.id} ended with status ${run.status}`);
    }
    log(`[apify] run ${run.id} succeeded; dataset ${run.defaultDatasetId}`);

    const items: unknown[] = [];
    const dataset = client.dataset(run.defaultDatasetId);
    let offset = 0;
    const limit = 1000;
    while (true) {
      const page = await dataset.listItems({ offset, limit, clean: true });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length < limit || offset >= page.total) break;
    }
    return items;
  };
}
