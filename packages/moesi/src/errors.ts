export type MoesiPlanErrorCode =
  | "invalid_record"
  | "unknown_field"
  | "unsupported_plan_version"
  | "plan_identity_mismatch"
  | "contradictory_plan"
  | "invalid_manifest"
  | "manifest_mismatch"
  | "invalid_manifest_hash"
  | "invalid_chain"
  | "duplicate_chain"
  | "invalid_snapshot"
  | "invalid_cell"
  | "missing_cell"
  | "duplicate_cell"
  | "duplicate_step"
  | "unpinned_chain"
  | "orphan_step"
  | "missing_step"
  | "invalid_step"
  | "invalid_call"
  | "invalid_postcondition"
  | "invalid_sender"
  | "invalid_enforcement"
  | "conflicting_senders"
  | "invalid_requirements";

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
  | "invalid_deployment"
  | "invalid_sender"
  | "invalid_enforcement";

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

export type MoesiExecutionErrorCode =
  | "provider_invalid"
  | "provider_review_failed"
  | "provider_review_invalid"
  | "provider_review_blocked"
  | "provider_mismatch"
  | "plan_mismatch"
  | "plan_snapshot_unverifiable"
  | "invalid_action"
  | "provider_prepare_failed";

export class MoesiExecutionError extends Error {
  readonly code: MoesiExecutionErrorCode;

  constructor(code: MoesiExecutionErrorCode, message: string) {
    super(message);
    this.name = "MoesiExecutionError";
    this.code = code;
  }
}
