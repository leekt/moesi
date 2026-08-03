export type CliErrorCode =
  | "invalid_arguments"
  | "manifest_read_failed"
  | "manifest_json_invalid"
  | "internal";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
