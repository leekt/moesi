export type MoesiProbeErrorCode =
  | "missing-transport"
  | "state-override-unreadable"
  | "invalid-address"
  | "invalid-probe-input"
  | "invalid-response"
  | "transport-failed"
  | "method-unavailable";

/** Machine-readable failure for a probe that produced no usable evidence. */
export class MoesiProbeError extends Error {
  readonly code: MoesiProbeErrorCode;
  /** The probe produced no conclusive evidence. */
  readonly via = "unreadable";

  constructor(code: MoesiProbeErrorCode, message: string) {
    super(message);
    this.name = "MoesiProbeError";
    this.code = code;
  }
}
