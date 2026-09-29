export type CliErrorCode =
  | "invalid_arguments"
  | "manifest_read_failed"
  | "manifest_json_invalid"
  | "plan_read_failed"
  | "plan_json_invalid"
  | "plan_artifact_invalid"
  | "plan_output_exists"
  | "plan_write_failed"
  | "signer_unavailable"
  | "signer_invalid"
  | "execution_review_mismatch"
  | "internal";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
