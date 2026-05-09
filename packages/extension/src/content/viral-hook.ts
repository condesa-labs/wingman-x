import { extractTweetsFromGraphQLResponse } from "./viral-hook-extract.js";

const GRAPHQL_URL_RE = /\/i\/api\/graphql\//;
const MESSAGE_TYPE = "TH_VIRAL_OBSERVED";

installFetchHook();
installXhrHook();

function installFetchHook(): void {
  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(
    this: Window,
    ...args: Parameters<typeof fetch>
  ): ReturnType<typeof fetch> {
    const requestUrl = requestInfoToUrl(args[0]);
    return originalFetch.apply(this, args).then((response) => {
      if (requestUrl !== null && GRAPHQL_URL_RE.test(requestUrl)) {
        void readResponseClone(response);
      }
      return response;
    });
  };
}

function installXhrHook(): void {
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ): void {
    const requestUrl = String(url);
    if (GRAPHQL_URL_RE.test(requestUrl)) {
      this.addEventListener("load", () => void readXhrResponse(this));
    }
    return originalOpen.call(this, method, url, async ?? true, username, password);
  };
}

async function readResponseClone(response: Response): Promise<void> {
  try {
    const clone = response.clone();
    const body = await clone.json();
    emitTweets(body);
  } catch {
    // Degrade silently; the hook must not affect X's own request lifecycle.
  }
}

async function readXhrResponse(xhr: XMLHttpRequest): Promise<void> {
  try {
    const contentType = xhr.getResponseHeader("content-type") ?? "";
    if (!contentType.includes("json") && typeof xhr.responseText !== "string") {
      return;
    }
    const body = JSON.parse(xhr.responseText);
    emitTweets(body);
  } catch {
    // Degrade silently; malformed/non-JSON GraphQL payloads are ignored.
  }
}

function emitTweets(body: unknown): void {
  const tweets = extractTweetsFromGraphQLResponse(body);
  if (tweets.length === 0) return;
  window.postMessage({ type: MESSAGE_TYPE, tweets }, window.location.origin);
}

function requestInfoToUrl(input: RequestInfo | URL): string | null {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  return null;
}
