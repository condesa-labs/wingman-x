export type KBAdapterErrorCode =
  | "CONFIG_INVALID"
  | "SOURCE_UNAVAILABLE"
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "UNKNOWN";

export class KBAdapterError extends Error {
  constructor(
    public readonly code: KBAdapterErrorCode,
    public readonly adapter: string,
    message: string,
  ) {
    super(message);
    this.name = "KBAdapterError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
