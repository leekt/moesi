import type { Address, Hex } from "viem";
import { MoesiPlanError } from "./errors.js";
import { asRecord, deepFreeze, exactKeys, hashCanonical } from "./internal.js";
import type {
  ChainSnapshot,
  DeploymentCall,
  DeploymentPostcondition,
  DeploymentStep,
  DriftKind,
  PlanDisposition,
  PlanDraft,
  ResourceCell,
  ReviewedCallScope,
  ReviewedConfiguration,
  ReviewedPlan,
  ReviewedPolicy,
} from "./types.js";

export const MOESI_REVIEWED_PLAN_VERSION = "moesi.reviewed-plan/v1" as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;
const STEP_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,382}[a-zA-Z0-9])?$/;
const DRIFT_KINDS = new Set<DriftKind>(["missing", "configuration-drift"]);

export function reviewPlan(input: PlanDraft): ReviewedPlan;
export function reviewPlan(input: unknown): ReviewedPlan {
  const record = asRecord(input, "plan");
  exactKeys(record, ["manifestHash", "snapshots", "cells", "steps"], "plan");

  const manifestHash = parseBytes32(
    record.manifestHash,
    "plan.manifestHash",
    "invalid_manifest_hash",
  );
  const snapshots = parseSnapshots(record.snapshots);
  const pinnedChains = new Set(snapshots.map(({ chainId }) => chainId));
  const cells = parseCells(record.cells, pinnedChains);
  const steps = parseSteps(record.steps, pinnedChains);
  validateCellStepOwnership(cells, steps);
  const policy = derivePolicy(steps);
  const disposition = deriveDisposition(cells, steps);
  const payload = {
    version: MOESI_REVIEWED_PLAN_VERSION,
    manifestHash,
    disposition,
    snapshots,
    cells,
    steps,
    policy,
  } as const;

  return deepFreeze({
    ...payload,
    planId: hashCanonical(payload),
  }) as unknown as ReviewedPlan;
}

export function parseReviewedPlan(input: ReviewedPlan): ReviewedPlan;
export function parseReviewedPlan(input: unknown): ReviewedPlan {
  const record = asRecord(input, "reviewedPlan");
  exactKeys(
    record,
    ["version", "planId", "manifestHash", "disposition", "snapshots", "cells", "steps", "policy"],
    "reviewedPlan",
  );
  if (record.version !== MOESI_REVIEWED_PLAN_VERSION) {
    throw new MoesiPlanError(
      "unsupported_plan_version",
      "reviewedPlan.version",
      `reviewed plan version must be ${MOESI_REVIEWED_PLAN_VERSION}`,
    );
  }
  const rebuilt = reviewPlan({
    manifestHash: record.manifestHash,
    snapshots: record.snapshots,
    cells: record.cells,
    steps: record.steps,
  } as PlanDraft);
  if (record.planId !== rebuilt.planId) {
    throw new MoesiPlanError(
      "plan_identity_mismatch",
      "reviewedPlan.planId",
      "reviewed plan identity does not match its payload",
    );
  }
  if (record.disposition !== rebuilt.disposition) {
    throw new MoesiPlanError(
      "contradictory_plan",
      "reviewedPlan.disposition",
      "reviewed plan disposition contradicts its cells and steps",
    );
  }
  try {
    if (hashCanonical(record.policy) !== hashCanonical(rebuilt.policy)) {
      throw new MoesiPlanError(
        "contradictory_plan",
        "reviewedPlan.policy",
        "reviewed plan policy contradicts its steps",
      );
    }
  } catch (error) {
    if (error instanceof MoesiPlanError) throw error;
    throw new MoesiPlanError(
      "contradictory_plan",
      "reviewedPlan.policy",
      "reviewed plan policy is unreadable",
    );
  }
  return rebuilt;
}

function parseCells(value: unknown, pinnedChains: ReadonlySet<number>): ResourceCell[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MoesiPlanError(
      "invalid_cell",
      "plan.cells",
      "at least one resource cell is required",
    );
  }
  const seen = new Set<string>();
  const cells = value.map((entry, index) => {
    const path = `plan.cells[${index}]`;
    const record = asRecord(entry, path, "invalid_cell");
    exactKeys(
      record,
      ["resourceId", "chainId", "address", "expectedRuntimeCodeHash", "configuration", "status"],
      path,
    );
    if (typeof record.resourceId !== "string" || !RESOURCE_ID_PATTERN.test(record.resourceId)) {
      throw new MoesiPlanError("invalid_cell", `${path}.resourceId`, "resource id is invalid");
    }
    const chainId = parseChainId(record.chainId, `${path}.chainId`);
    if (!pinnedChains.has(chainId)) {
      throw new MoesiPlanError(
        "unpinned_chain",
        `${path}.chainId`,
        `chain ${chainId} is not pinned`,
      );
    }
    const cellKey = `${chainId}:${record.resourceId}`;
    if (seen.has(cellKey)) {
      throw new MoesiPlanError("duplicate_cell", `${path}.resourceId`, `duplicate cell ${cellKey}`);
    }
    seen.add(cellKey);
    const cell = {
      resourceId: record.resourceId,
      chainId,
      address: parseAddress(record.address, `${path}.address`, "invalid_cell"),
      expectedRuntimeCodeHash: parseBytes32(
        record.expectedRuntimeCodeHash,
        `${path}.expectedRuntimeCodeHash`,
        "invalid_cell",
      ),
      configuration: parseReviewedConfiguration(record.configuration, `${path}.configuration`),
      status: parseCellStatus(record.status, `${path}.status`),
    } as ResourceCell;
    validateCellEvidence(cell, path);
    return cell;
  });
  return cells.sort(
    (left, right) =>
      left.chainId - right.chainId || left.resourceId.localeCompare(right.resourceId),
  );
}

function parseCellStatus(value: unknown, path: string): ResourceCell["status"] {
  const record = asRecord(value, path, "invalid_cell");
  if (record.kind === "converged") {
    exactKeys(record, ["kind", "observedRuntimeCodeHash", "configurationResults"], path);
    return {
      kind: "converged",
      observedRuntimeCodeHash: parseBytes32(
        record.observedRuntimeCodeHash,
        `${path}.observedRuntimeCodeHash`,
        "invalid_cell",
      ),
      configurationResults: parseConfigurationResults(
        record.configurationResults,
        `${path}.configurationResults`,
      ),
    };
  }
  if (record.kind === "missing") {
    exactKeys(record, ["kind"], path);
    return { kind: "missing" };
  }
  if (record.kind === "bytecode-drift") {
    exactKeys(record, ["kind", "observedRuntimeCodeHash"], path);
    return {
      kind: "bytecode-drift",
      observedRuntimeCodeHash: parseBytes32(
        record.observedRuntimeCodeHash,
        `${path}.observedRuntimeCodeHash`,
        "invalid_cell",
      ),
    };
  }
  if (record.kind === "configuration-drift") {
    exactKeys(record, ["kind", "observedRuntimeCodeHash", "mismatches"], path);
    if (!Array.isArray(record.mismatches) || record.mismatches.length === 0) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.mismatches`,
        "at least one mismatch is required",
      );
    }
    const seen = new Set<string>();
    const mismatches = record.mismatches.map((entry, index) => {
      const mismatchPath = `${path}.mismatches[${index}]`;
      const mismatch = asRecord(entry, mismatchPath, "invalid_cell");
      exactKeys(mismatch, ["id", "expectedResult", "observedResult"], mismatchPath);
      const id = parseResourceId(mismatch.id, `${mismatchPath}.id`, "invalid_cell");
      if (seen.has(id)) {
        throw new MoesiPlanError("invalid_cell", `${mismatchPath}.id`, `duplicate mismatch ${id}`);
      }
      seen.add(id);
      return {
        id,
        expectedResult: parseHex(
          mismatch.expectedResult,
          `${mismatchPath}.expectedResult`,
          "invalid_cell",
        ),
        observedResult: parseHex(
          mismatch.observedResult,
          `${mismatchPath}.observedResult`,
          "invalid_cell",
        ),
      };
    });
    mismatches.sort((left, right) => left.id.localeCompare(right.id));
    return {
      kind: "configuration-drift",
      observedRuntimeCodeHash: parseBytes32(
        record.observedRuntimeCodeHash,
        `${path}.observedRuntimeCodeHash`,
        "invalid_cell",
      ),
      mismatches,
    };
  }
  if (record.kind === "unreadable") {
    exactKeys(record, ["kind", "reason", "configurationId"], path);
    if (
      record.reason !== "read-failed" &&
      record.reason !== "invalid-response" &&
      record.reason !== "configuration-read-failed" &&
      record.reason !== "configuration-invalid-response"
    ) {
      throw new MoesiPlanError("invalid_cell", `${path}.reason`, "unreadable reason is invalid");
    }
    const isConfigurationReason = record.reason.startsWith("configuration-");
    if ((record.configurationId === null) === isConfigurationReason) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.configurationId`,
        "configurationId must identify only configuration read failures",
      );
    }
    return {
      kind: "unreadable",
      reason: record.reason,
      configurationId:
        record.configurationId === null
          ? null
          : parseResourceId(record.configurationId, `${path}.configurationId`, "invalid_cell"),
    };
  }
  throw new MoesiPlanError("invalid_cell", `${path}.kind`, "cell status is invalid");
}

function parseSnapshots(value: unknown): ChainSnapshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MoesiPlanError(
      "invalid_snapshot",
      "plan.snapshots",
      "at least one snapshot is required",
    );
  }
  const seen = new Set<number>();
  const snapshots = value.map((entry, index) => {
    const path = `plan.snapshots[${index}]`;
    const record = asRecord(entry, path, "invalid_snapshot");
    exactKeys(record, ["chainId", "blockNumber", "blockHash"], path);
    const chainId = parseChainId(record.chainId, `${path}.chainId`);
    if (seen.has(chainId)) {
      throw new MoesiPlanError("duplicate_chain", `${path}.chainId`, `duplicate chain ${chainId}`);
    }
    seen.add(chainId);
    if (typeof record.blockNumber !== "bigint" || record.blockNumber < 0n) {
      throw new MoesiPlanError(
        "invalid_snapshot",
        `${path}.blockNumber`,
        "blockNumber must be a non-negative bigint",
      );
    }
    return {
      chainId,
      blockNumber: record.blockNumber,
      blockHash: parseBytes32(record.blockHash, `${path}.blockHash`, "invalid_snapshot"),
    };
  });
  return snapshots.sort((left, right) => left.chainId - right.chainId);
}

function parseSteps(value: unknown, pinnedChains: ReadonlySet<number>): DeploymentStep[] {
  if (!Array.isArray(value)) {
    throw new MoesiPlanError("invalid_step", "plan.steps", "steps must be an array");
  }
  const seen = new Set<string>();
  const steps = value.map((entry, index) => {
    const path = `plan.steps[${index}]`;
    const record = asRecord(entry, path, "invalid_step");
    exactKeys(
      record,
      ["id", "resourceId", "chainId", "kind", "configurationId", "drift", "call", "postconditions"],
      path,
    );
    if (typeof record.id !== "string" || !STEP_ID_PATTERN.test(record.id)) {
      throw new MoesiPlanError("invalid_step", `${path}.id`, "step id is invalid");
    }
    const chainId = parseChainId(record.chainId, `${path}.chainId`);
    if (!pinnedChains.has(chainId)) {
      throw new MoesiPlanError(
        "unpinned_chain",
        `${path}.chainId`,
        `chain ${chainId} is not pinned`,
      );
    }
    const stepKey = `${chainId}:${record.id}`;
    if (seen.has(stepKey)) {
      throw new MoesiPlanError(
        "duplicate_step",
        `${path}.id`,
        `duplicate step ${record.id} on chain ${chainId}`,
      );
    }
    seen.add(stepKey);
    const resourceId = parseResourceId(record.resourceId, `${path}.resourceId`, "invalid_step");
    if (record.kind !== "deploy" && record.kind !== "configure") {
      throw new MoesiPlanError("invalid_step", `${path}.kind`, "step kind is invalid");
    }
    const kind = record.kind as DeploymentStep["kind"];
    const configurationId =
      record.configurationId === null
        ? null
        : parseResourceId(record.configurationId, `${path}.configurationId`, "invalid_step");
    if (typeof record.drift !== "string" || !DRIFT_KINDS.has(record.drift as DriftKind)) {
      throw new MoesiPlanError("invalid_step", `${path}.drift`, "drift kind is invalid");
    }
    if (!Array.isArray(record.postconditions) || record.postconditions.length === 0) {
      throw new MoesiPlanError(
        "invalid_postcondition",
        `${path}.postconditions`,
        "at least one postcondition is required",
      );
    }
    return {
      id: record.id,
      resourceId,
      chainId,
      kind,
      configurationId,
      drift: record.drift as DriftKind,
      call: parseCall(record.call, `${path}.call`),
      postconditions: record.postconditions.map((condition, conditionIndex) =>
        parsePostcondition(condition, `${path}.postconditions[${conditionIndex}]`),
      ),
    };
  });
  return steps.sort(
    (left, right) => left.chainId - right.chainId || left.id.localeCompare(right.id),
  );
}

function validateCellEvidence(cell: ResourceCell, path: string): void {
  if (
    (cell.status.kind === "converged" || cell.status.kind === "configuration-drift") &&
    cell.status.observedRuntimeCodeHash !== cell.expectedRuntimeCodeHash
  ) {
    throw new MoesiPlanError(
      "invalid_cell",
      `${path}.status.observedRuntimeCodeHash`,
      "configuration evidence requires matching runtime bytecode",
    );
  }
  if (
    cell.status.kind === "bytecode-drift" &&
    cell.status.observedRuntimeCodeHash === cell.expectedRuntimeCodeHash
  ) {
    throw new MoesiPlanError(
      "invalid_cell",
      `${path}.status.observedRuntimeCodeHash`,
      "bytecode drift requires a different runtime code hash",
    );
  }
  if (cell.status.kind === "converged") {
    const status = cell.status;
    if (
      status.configurationResults.length !== cell.configuration.length ||
      cell.configuration.some((configuration, index) => {
        const result = status.configurationResults[index];
        return result?.id !== configuration.id || result.result !== configuration.expectedResult;
      })
    ) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.status.configurationResults`,
        "converged configuration results must exactly satisfy every reviewed check",
      );
    }
  }
  if (cell.status.kind === "configuration-drift") {
    for (const mismatch of cell.status.mismatches) {
      const configuration = cell.configuration.find(({ id }) => id === mismatch.id);
      if (
        !configuration ||
        configuration.expectedResult !== mismatch.expectedResult ||
        mismatch.observedResult === mismatch.expectedResult
      ) {
        throw new MoesiPlanError(
          "invalid_cell",
          `${path}.status.mismatches`,
          `configuration mismatch ${mismatch.id} contradicts reviewed checks`,
        );
      }
    }
  }
  if (cell.status.kind === "unreadable") {
    const configurationId = cell.status.configurationId;
    if (configurationId !== null && !cell.configuration.some(({ id }) => id === configurationId)) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.status.configurationId`,
        "unreadable configuration is not reviewed by this cell",
      );
    }
  }
}

function validateCellStepOwnership(
  cells: readonly ResourceCell[],
  steps: readonly DeploymentStep[],
): void {
  const cellsByKey = new Map(cells.map((cell) => [`${cell.chainId}:${cell.resourceId}`, cell]));
  const stepsByCell = new Map<string, DeploymentStep[]>();
  for (const step of steps) {
    const key = `${step.chainId}:${step.resourceId}`;
    const cell = cellsByKey.get(key);
    const owned = stepsByCell.get(key) ?? [];
    owned.push(step);
    stepsByCell.set(key, owned);
    if (!cell) {
      throw new MoesiPlanError("orphan_step", "plan.steps", `step ${step.id} has no resource cell`);
    }
    if (step.kind === "deploy") {
      if (
        cell.status.kind !== "missing" ||
        step.drift !== "missing" ||
        step.configurationId !== null ||
        step.postconditions.length !== 1 ||
        step.postconditions[0]?.kind !== "runtime-code-hash" ||
        step.postconditions[0].address !== cell.address ||
        step.postconditions[0].expectedHash !== cell.expectedRuntimeCodeHash
      ) {
        throw new MoesiPlanError(
          "orphan_step",
          "plan.steps",
          `deployment step ${step.id} contradicts its cell`,
        );
      }
      continue;
    }
    const mismatch =
      cell.status.kind === "configuration-drift"
        ? cell.status.mismatches.find(({ id }) => id === step.configurationId)
        : undefined;
    const configuration = cell.configuration.find(({ id }) => id === step.configurationId);
    const postcondition = step.postconditions[0];
    if (
      cell.status.kind !== "configuration-drift" ||
      step.drift !== "configuration-drift" ||
      step.configurationId === null ||
      !mismatch ||
      !configuration ||
      mismatch.expectedResult !== configuration.expectedResult ||
      step.call.target !== cell.address ||
      step.postconditions.length !== 1 ||
      postcondition?.kind !== "static-call" ||
      postcondition.target !== cell.address ||
      postcondition.data !== configuration.readData ||
      postcondition.expectedResult !== configuration.expectedResult
    ) {
      throw new MoesiPlanError(
        "orphan_step",
        "plan.steps",
        `configuration step ${step.id} contradicts its cell`,
      );
    }
  }
  for (const cell of cells) {
    const owned = stepsByCell.get(`${cell.chainId}:${cell.resourceId}`) ?? [];
    if (cell.status.kind === "missing" && (owned.length !== 1 || owned[0]?.kind !== "deploy")) {
      throw new MoesiPlanError(
        "missing_step",
        "plan.steps",
        `missing cell ${cell.chainId}:${cell.resourceId} has no deployment step`,
      );
    }
    if (cell.status.kind === "configuration-drift") {
      const configurationIds = owned
        .filter(({ kind }) => kind === "configure")
        .map(({ configurationId }) => configurationId)
        .sort();
      const mismatchIds = cell.status.mismatches.map(({ id }) => id).sort();
      if (
        configurationIds.length !== mismatchIds.length ||
        configurationIds.some((id, index) => id !== mismatchIds[index])
      ) {
        throw new MoesiPlanError(
          "missing_step",
          "plan.steps",
          `configuration drift cell ${cell.chainId}:${cell.resourceId} lacks exact remediation steps`,
        );
      }
    } else if (cell.status.kind !== "missing" && owned.length > 0) {
      throw new MoesiPlanError(
        "orphan_step",
        "plan.steps",
        `non-actionable cell ${cell.chainId}:${cell.resourceId} owns steps`,
      );
    }
  }
}

function deriveDisposition(
  cells: readonly ResourceCell[],
  steps: readonly DeploymentStep[],
): PlanDisposition {
  const hasBlocked = cells.some(
    ({ status }) => status.kind === "bytecode-drift" || status.kind === "unreadable",
  );
  if (hasBlocked && steps.length > 0) return "partial";
  if (hasBlocked) return "blocked";
  return steps.length > 0 ? "changes" : "converged";
}

function parseCall(value: unknown, path: string): DeploymentCall {
  const record = asRecord(value, path, "invalid_call");
  exactKeys(record, ["target", "data", "value"], path);
  const data = parseHex(record.data, `${path}.data`, "invalid_call");
  if (data.length < 10) {
    throw new MoesiPlanError("invalid_call", `${path}.data`, "call data must include a selector");
  }
  if (typeof record.value !== "bigint" || record.value < 0n) {
    throw new MoesiPlanError(
      "invalid_call",
      `${path}.value`,
      "call value must be a non-negative bigint",
    );
  }
  return {
    target: parseAddress(record.target, `${path}.target`, "invalid_call"),
    data,
    value: record.value,
  };
}

function parsePostcondition(value: unknown, path: string): DeploymentPostcondition {
  const record = asRecord(value, path, "invalid_postcondition");
  if (record.kind === "runtime-code-hash") {
    exactKeys(record, ["kind", "address", "expectedHash"], path);
    return {
      kind: "runtime-code-hash",
      address: parseAddress(record.address, `${path}.address`, "invalid_postcondition"),
      expectedHash: parseBytes32(
        record.expectedHash,
        `${path}.expectedHash`,
        "invalid_postcondition",
      ),
    };
  }
  if (record.kind === "static-call") {
    exactKeys(record, ["kind", "target", "data", "expectedResult"], path);
    const data = parseHex(record.data, `${path}.data`, "invalid_postcondition");
    if (data.length < 10) {
      throw new MoesiPlanError(
        "invalid_postcondition",
        `${path}.data`,
        "call data must include a selector",
      );
    }
    return {
      kind: "static-call",
      target: parseAddress(record.target, `${path}.target`, "invalid_postcondition"),
      data,
      expectedResult: parseHex(
        record.expectedResult,
        `${path}.expectedResult`,
        "invalid_postcondition",
      ),
    };
  }
  throw new MoesiPlanError(
    "invalid_postcondition",
    `${path}.kind`,
    "postcondition kind is invalid",
  );
}

function derivePolicy(steps: readonly DeploymentStep[]): ReviewedPolicy {
  const calls = new Map<string, ReviewedCallScope>();
  for (const step of steps) {
    const scope = {
      target: step.call.target,
      selector: step.call.data.slice(0, 10) as Hex,
      calldata: step.call.data,
      value: step.call.value,
    };
    calls.set(`${scope.target}:${scope.calldata}:${scope.value.toString(10)}`, scope);
  }
  return {
    chainScope: "all",
    calls: [...calls.values()].sort((left, right) => {
      const leftKey = `${left.target}:${left.calldata}:${left.value.toString(10)}`;
      const rightKey = `${right.target}:${right.calldata}:${right.value.toString(10)}`;
      return leftKey.localeCompare(rightKey);
    }),
    perChainOperationLimit: steps.length === 0 ? 0 : 1,
  };
}

function parseChainId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MoesiPlanError("invalid_chain", path, "chain id must be a positive safe integer");
  }
  return value;
}

function parseAddress(
  value: unknown,
  path: string,
  code: "invalid_call" | "invalid_postcondition" | "invalid_cell",
): Address {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new MoesiPlanError(code, path, "address is invalid");
  }
  return value.toLowerCase() as Address;
}

function parseHex(
  value: unknown,
  path: string,
  code: "invalid_call" | "invalid_postcondition" | "invalid_cell",
): Hex {
  if (typeof value !== "string" || !HEX_PATTERN.test(value)) {
    throw new MoesiPlanError(code, path, "hex value is invalid");
  }
  return value.toLowerCase() as Hex;
}

function parseResourceId(
  value: unknown,
  path: string,
  code: "invalid_cell" | "invalid_step",
): string {
  if (typeof value !== "string" || !RESOURCE_ID_PATTERN.test(value)) {
    throw new MoesiPlanError(code, path, "resource id is invalid");
  }
  return value;
}

function parseReviewedConfiguration(value: unknown, path: string): ReviewedConfiguration[] {
  if (!Array.isArray(value)) {
    throw new MoesiPlanError("invalid_cell", path, "configuration must be an array");
  }
  const seen = new Set<string>();
  const configuration = value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(entry, itemPath, "invalid_cell");
    exactKeys(record, ["id", "readData", "expectedResult"], itemPath);
    const id = parseResourceId(record.id, `${itemPath}.id`, "invalid_cell");
    if (seen.has(id)) {
      throw new MoesiPlanError("invalid_cell", `${itemPath}.id`, `duplicate configuration ${id}`);
    }
    seen.add(id);
    const readData = parseHex(record.readData, `${itemPath}.readData`, "invalid_cell");
    if (readData.length < 10) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${itemPath}.readData`,
        "readData must include a selector",
      );
    }
    return {
      id,
      readData,
      expectedResult: parseHex(record.expectedResult, `${itemPath}.expectedResult`, "invalid_cell"),
    };
  });
  return configuration.sort((left, right) => left.id.localeCompare(right.id));
}

function parseConfigurationResults(
  value: unknown,
  path: string,
): Array<{ id: string; result: Hex }> {
  if (!Array.isArray(value)) {
    throw new MoesiPlanError("invalid_cell", path, "configurationResults must be an array");
  }
  const seen = new Set<string>();
  const results = value.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(entry, itemPath, "invalid_cell");
    exactKeys(record, ["id", "result"], itemPath);
    const id = parseResourceId(record.id, `${itemPath}.id`, "invalid_cell");
    if (seen.has(id)) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${itemPath}.id`,
        `duplicate configuration result ${id}`,
      );
    }
    seen.add(id);
    return { id, result: parseHex(record.result, `${itemPath}.result`, "invalid_cell") };
  });
  return results.sort((left, right) => left.id.localeCompare(right.id));
}

function parseBytes32(
  value: unknown,
  path: string,
  code: "invalid_manifest_hash" | "invalid_snapshot" | "invalid_postcondition" | "invalid_cell",
): Hex {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value)) {
    throw new MoesiPlanError(code, path, "bytes32 value is invalid");
  }
  return value.toLowerCase() as Hex;
}
