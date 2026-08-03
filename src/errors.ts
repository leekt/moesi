export type MoesiPlanErrorCode =
  | "invalid_record"
  | "unknown_field"
  | "unsupported_plan_version"
  | "plan_identity_mismatch"
  | "contradictory_plan"
  | "invalid_manifest_hash"
  | "invalid_chain"
  | "duplicate_chain"
  | "invalid_snapshot"
  | "invalid_cell"
  | "duplicate_cell"
  | "duplicate_step"
  | "unpinned_chain"
  | "orphan_step"
  | "missing_step"
  | "invalid_step"
  | "invalid_call"
  | "invalid_postcondition";

export class MoesiPlanError extends Error {
  readonly code: MoesiPlanErrorCode;
  readonly path: string;

  constructor(code: MoesiPlanErrorCode, path: string, message: string) {
    super(message);
    this.name = "MoesiPlanError";
    this.code = code;
    this.path = path;
  }
}

export type MoesiManifestErrorCode =
  | "invalid_manifest"
  | "unsupported_manifest_version"
  | "unknown_field"
  | "duplicate_resource"
  | "invalid_resource"
  | "invalid_deployment";

export class MoesiManifestError extends Error {
  readonly code: MoesiManifestErrorCode;
  readonly path: string;

  constructor(code: MoesiManifestErrorCode, path: string, message: string) {
    super(message);
    this.name = "MoesiManifestError";
    this.code = code;
    this.path = path;
  }
}

export type MoesiPlanningErrorCode =
  | "invalid_chains"
  | "duplicate_chain"
  | "snapshot_unreadable"
  | "invalid_snapshot";

export class MoesiPlanningError extends Error {
  readonly code: MoesiPlanningErrorCode;
  readonly chainId: number | null;

  constructor(code: MoesiPlanningErrorCode, chainId: number | null, message: string) {
    super(message);
    this.name = "MoesiPlanningError";
    this.code = code;
    this.chainId = chainId;
  }
}
