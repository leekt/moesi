import { type ObservationCause, parseObservationCause } from "../observation/failure.js";
export type MoesiFleetErrorCode =
  | "invalid_fleet"
  | "authoring_failed"
  | "resource_dependency_cycle"
  | "resource_unavailable"
  | "account_unavailable"
  | "invalid_abi_call"
  | "observer_required"
  | "live_read_failed"
  | "invalid_live_read";
/** Bounded authoring failures never retain raw RPC errors or callback inputs. */
export class MoesiFleetError extends Error {
  readonly code: MoesiFleetErrorCode;
  override readonly cause: ObservationCause | null;
  constructor(code: MoesiFleetErrorCode, cause?: ObservationCause) {
    super(`fleet compilation failed: ${code}`);
    this.name = "MoesiFleetError";
    this.code = code;
    this.cause = cause ? parseObservationCause(cause) : null;
  }
}
