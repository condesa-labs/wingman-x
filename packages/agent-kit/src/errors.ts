// RED-phase stub. The real implementations land in the GREEN commit.
// These symbols must exist so the test suite can import them and fail
// with meaningful assertion errors rather than "export not found".
export class DaemonHttpError extends Error {
  public readonly status: number = 0;
  public readonly statusText: string = "";
  public readonly body: unknown = undefined;
  constructor() {
    super("not implemented");
    this.name = "DaemonHttpError";
  }
}
export class DaemonTimeoutError extends Error {
  constructor() {
    super("not implemented");
    this.name = "DaemonTimeoutError";
  }
}
export class DaemonNetworkError extends Error {
  public override readonly cause: unknown = undefined;
  constructor() {
    super("not implemented");
    this.name = "DaemonNetworkError";
  }
}
