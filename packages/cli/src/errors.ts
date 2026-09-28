export type CliErrorCode =
  | "fleet_baseline_read_failed"
  | "fleet_baseline_json_invalid"
  | "fleet_baseline_too_large"
  | "invalid_arguments"
  | "manifest_read_failed"
  | "plan_read_failed"
  | "plan_json_invalid"
  | "plan_artifact_invalid"
  | "unsupported_plan_artifact_version"
  | "signer_unavailable"
  | "signer_invalid"
  | "execution_review_mismatch"
  | "oaath_adapter_unavailable"
  | "oaath_client_invalid"
  | "oaath_permission_failed"
  | "oaath_permission_unavailable"
  | "oaath_cleanup_failed"
  | "internal";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
