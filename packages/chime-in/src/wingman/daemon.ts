import { createDaemonClient, type DaemonClient } from "@wingman-x/agent-kit";

const PORT_START = 53827;
const PORT_END = 53836;
const IDENTITY_HEADER = "x-twitter-helper-daemon";

/** Probe Wingman's daemon port range, verifying the identity header. */
export async function probeDaemonPort(preferred?: number): Promise<number | null> {
  const ports = preferred !== undefined ? [preferred] : [];
  for (let p = PORT_START; p <= PORT_END; p += 1) if (p !== preferred) ports.push(p);
  for (const port of ports) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 700);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctrl.signal });
      if (!res.ok) continue;
      const id = res.headers.get(IDENTITY_HEADER);
      if (!id) continue;
      const body = (await res.json().catch(() => null)) as { status?: string } | null;
      if (body?.status === "ok") return port;
    } catch {
      // next
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

export async function connectDaemon(preferred?: number): Promise<{ port: number; client: DaemonClient }> {
  const port = await probeDaemonPort(preferred);
  if (port === null) {
    throw new Error(
      `Wingman daemon not reachable on ${PORT_START}..${PORT_END}. Start it with: npm --workspace @wingman-x/daemon run dev`,
    );
  }
  return { port, client: createDaemonClient(port, { timeoutMs: 10_000 }) };
}
