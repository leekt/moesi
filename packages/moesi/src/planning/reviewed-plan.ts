import { type Address, type Hex, keccak256 } from "viem";
import { MoesiPlanError } from "../errors.js";
import {
  asRecord,
  compareAscii,
  deepFreeze,
  exactKeys,
  hashCanonical,
  mapArrayElements,
  snapshotArray,
} from "../internal.js";
import { parseManifest } from "../manifest/parse.js";
import type { MoesiManifest } from "../manifest/types.js";
import type { ChainSnapshot } from "../observation/types.js";
import { compileExecutionRequirements, orderDeploymentSteps } from "./requirements.js";
import {
  compileConfigurationCall,
  compileConfigurationCaller,
  compileDeploymentCall,
  compileResourceEnforcement,
  compileResourceSender,
  deriveResourceAddress,
} from "./resource.js";
import type {
  DeploymentCall,
  DeploymentPostcondition,
  DeploymentStep,
  DriftKind,
  PlanDisposition,
  PlanDraft,
  PlanEnforcement,
  ResourceCell,
  ReviewedConfiguration,
  ReviewedPlan,
  StepSender,
} from "./types.js";
import { MAX_PLAN_CHAINS } from "./types.js";

export const MOESI_REVIEWED_PLAN_VERSION = "moesi.reviewed-plan/v1" as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const RESOURCE_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,126}[a-zA-Z0-9])?$/;
const STEP_ID_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:-]{0,382}[a-zA-Z0-9])?$/;
const DRIFT_KINDS = new Set<DriftKind>(["missing", "configuration-drift"]);
const EMPTY_CODE_HASH = keccak256("0x");
const MAX_UINT256 = (1n << 256n) - 1n;
const UINT256_PATTERN = /^(?:0|[1-9][0-9]{0,77})$/;

export function reviewPlan(input: PlanDraft): ReviewedPlan;
export function reviewPlan(input: unknown): ReviewedPlan {
  const record = asRecord(input, "plan");
  exactKeys(record, ["manifest", "snapshots", "cells", "steps"], "plan");

  const parsedManifest = parsePlanManifest(record.manifest);
  const manifest: MoesiManifest = {
    version: parsedManifest.version,
    contracts: parsedManifest.contracts,
  };
  const snapshots = parseSnapshots(record.snapshots);
  const pinnedChains = new Set(snapshots.map(({ chainId }) => chainId));
  const cells = parseCells(record.cells, pinnedChains);
  validateCellCoverage(parsedManifest, snapshots, cells);
  validateManifestCells(parsedManifest, cells);
  const steps = parseSteps(record.steps, pinnedChains);
  validateCellStepOwnership(parsedManifest, cells, steps);
  const requirements = compileExecutionRequirements(steps);
  const disposition = deriveDisposition(cells, steps);
  const payload = {
    version: MOESI_REVIEWED_PLAN_VERSION,
    manifest,
    manifestHash: parsedManifest.manifestHash,
    disposition,
    snapshots,
    cells,
    steps,
    requirements,
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
    [
      "version",
      "planId",
      "manifest",
      "manifestHash",
      "disposition",
      "snapshots",
      "cells",
      "steps",
      "requirements",
    ],
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
    manifest: record.manifest as MoesiManifest,
    snapshots: record.snapshots,
    cells: record.cells,
    steps: record.steps,
  } as PlanDraft);
  if (
    parseBytes32(record.manifestHash, "reviewedPlan.manifestHash", "invalid_manifest_hash") !==
    rebuilt.manifestHash
  ) {
    throw new MoesiPlanError(
      "manifest_mismatch",
      "reviewedPlan.manifestHash",
      "reviewed plan manifest hash does not match its embedded manifest",
    );
  }
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
    if (hashCanonical(record.requirements) !== hashCanonical(rebuilt.requirements)) {
      throw new MoesiPlanError(
        "contradictory_plan",
        "reviewedPlan.requirements",
        "reviewed plan requirements contradict its steps",
      );
    }
  } catch (error) {
    if (error instanceof MoesiPlanError) throw error;
    throw new MoesiPlanError(
      "contradictory_plan",
      "reviewedPlan.requirements",
      "reviewed plan requirements are unreadable",
    );
  }
  return rebuilt;
}

function parseCells(value: unknown, pinnedChains: ReadonlySet<number>): ResourceCell[] {
  const entries = snapshotArray(value);
  if (entries === null || entries.length === 0) {
    throw new MoesiPlanError(
      "invalid_cell",
      "plan.cells",
      "at least one resource cell is required",
    );
  }
  const seen = new Set<string>();
  const seenAddresses = new Set<string>();
  const cells = mapArrayElements(entries, (entry, index) => {
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
    const address = parseAddress(record.address, `${path}.address`, "invalid_cell");
    const addressKey = `${chainId}:${address}`;
    if (seenAddresses.has(addressKey)) {
      throw new MoesiPlanError(
        "duplicate_cell",
        `${path}.address`,
        `multiple cells target address ${address} on chain ${chainId}`,
      );
    }
    seenAddresses.add(addressKey);
    const expectedRuntimeCodeHash = parseBytes32(
      record.expectedRuntimeCodeHash,
      `${path}.expectedRuntimeCodeHash`,
      "invalid_cell",
    );
    if (expectedRuntimeCodeHash === EMPTY_CODE_HASH) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.expectedRuntimeCodeHash`,
        "expected runtime code must not be empty",
      );
    }
    const cell = {
      resourceId: record.resourceId,
      chainId,
      address,
      expectedRuntimeCodeHash,
      configuration: parseReviewedConfiguration(record.configuration, `${path}.configuration`),
      status: parseCellStatus(record.status, `${path}.status`),
    } as ResourceCell;
    validateCellEvidence(cell, path);
    return cell;
  });
  return cells.sort(
    (left, right) =>
      left.chainId - right.chainId || compareAscii(left.resourceId, right.resourceId),
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
    const mismatchEntries = snapshotArray(record.mismatches);
    if (mismatchEntries === null || mismatchEntries.length === 0) {
      throw new MoesiPlanError(
        "invalid_cell",
        `${path}.mismatches`,
        "at least one mismatch is required",
      );
    }
    const seen = new Set<string>();
    const mismatches = mapArrayElements(mismatchEntries, (entry, index) => {
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
    mismatches.sort((left, right) => compareAscii(left.id, right.id));
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
  const entries = snapshotArray(value);
  if (entries === null || entries.length === 0) {
    throw new MoesiPlanError(
      "invalid_snapshot",
      "plan.snapshots",
      "at least one snapshot is required",
    );
  }
  if (entries.length > MAX_PLAN_CHAINS) {
    throw new MoesiPlanError(
      "invalid_snapshot",
      "plan.snapshots",
      `at most ${MAX_PLAN_CHAINS} chain snapshots are allowed`,
    );
  }
  const seen = new Set<number>();
  const snapshots = mapArrayElements(entries, (entry, index) => {
    const path = `plan.snapshots[${index}]`;
    const record = asRecord(entry, path, "invalid_snapshot");
    exactKeys(record, ["chainId", "blockNumber", "blockHash"], path);
    const chainId = parseChainId(record.chainId, `${path}.chainId`);
    if (seen.has(chainId)) {
      throw new MoesiPlanError("duplicate_chain", `${path}.chainId`, `duplicate chain ${chainId}`);
    }
    seen.add(chainId);
    if (
      typeof record.blockNumber !== "string" ||
      !UINT256_PATTERN.test(record.blockNumber) ||
      BigInt(record.blockNumber) > MAX_UINT256
    ) {
      throw new MoesiPlanError(
        "invalid_snapshot",
        `${path}.blockNumber`,
        "blockNumber must be a canonical decimal uint256 string",
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

function validateCellCoverage(
  manifest: MoesiManifest,
  snapshots: readonly ChainSnapshot[],
  cells: readonly ResourceCell[],
): void {
  const expectedResourceIds = manifest.contracts.map(({ id }) => id).sort(compareAscii);
  for (const snapshot of snapshots) {
    const resourceIds = cells
      .filter((cell) => cell.chainId === snapshot.chainId)
      .map((cell) => cell.resourceId)
      .sort(compareAscii);
    if (
      resourceIds.length !== expectedResourceIds.length ||
      resourceIds.some((resourceId, index) => resourceId !== expectedResourceIds[index])
    ) {
      throw new MoesiPlanError(
        "missing_cell",
        "plan.cells",
        `chain ${snapshot.chainId} does not have the complete resource set`,
      );
    }
  }
}

function validateManifestCells(manifest: MoesiManifest, cells: readonly ResourceCell[]): void {
  const resources = new Map(manifest.contracts.map((resource) => [resource.id, resource]));
  for (const cell of cells) {
    const resource = resources.get(cell.resourceId);
    if (!resource) {
      throw new MoesiPlanError(
        "manifest_mismatch",
        "plan.cells",
        `cell ${cell.chainId}:${cell.resourceId} is not declared by the manifest`,
      );
    }
    const caller = compileConfigurationCaller(resource);
    const expectedConfiguration = resource.configuration.map(
      ({ id, readData, expectedResult }) => ({
        id,
        readData,
        caller,
        expectedResult,
      }),
    );
    if (
      cell.address !== deriveResourceAddress(resource) ||
      cell.expectedRuntimeCodeHash !== resource.expectedRuntimeCodeHash ||
      cell.configuration.length !== expectedConfiguration.length ||
      cell.configuration.some((configuration, index) => {
        const expected = expectedConfiguration[index];
        return (
          expected === undefined ||
          configuration.id !== expected.id ||
          configuration.readData !== expected.readData ||
          configuration.caller !== expected.caller ||
          configuration.expectedResult !== expected.expectedResult
        );
      })
    ) {
      throw new MoesiPlanError(
        "manifest_mismatch",
        "plan.cells",
        `cell ${cell.chainId}:${cell.resourceId} contradicts the manifest`,
      );
    }
  }
}

function parseSteps(value: unknown, pinnedChains: ReadonlySet<number>): DeploymentStep[] {
  const entries = snapshotArray(value);
  if (entries === null) {
    throw new MoesiPlanError("invalid_step", "plan.steps", "steps must be an array");
  }
  const seen = new Set<string>();
  const steps = mapArrayElements(entries, (entry, index) => {
    const path = `plan.steps[${index}]`;
    const record = asRecord(entry, path, "invalid_step");
    exactKeys(
      record,
      [
        "id",
        "resourceId",
        "chainId",
        "kind",
        "configurationId",
        "drift",
        "call",
        "postconditions",
        "sender",
        "enforcement",
      ],
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
    const postconditionEntries = snapshotArray(record.postconditions);
    if (postconditionEntries === null || postconditionEntries.length === 0) {
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
      postconditions: mapArrayElements(postconditionEntries, (condition, conditionIndex) =>
        parsePostcondition(condition, `${path}.postconditions[${conditionIndex}]`),
      ),
      sender: parseStepSender(record.sender, `${path}.sender`),
      enforcement: parseEnforcement(record.enforcement, `${path}.enforcement`),
    };
  });
  return orderDeploymentSteps(steps);
}

function parseStepSender(value: unknown, path: string): StepSender | null {
  if (value === null) return null;
  const record = asRecord(value, path, "invalid_sender");
  if (record.kind === "reviewed-owner-eoa") {
    exactKeys(record, ["kind", "address"], path);
    return {
      kind: "reviewed-owner-eoa",
      address: parseAddress(record.address, `${path}.address`, "invalid_step"),
    };
  }
  if (record.kind === "logical-smart-account") {
    exactKeys(record, ["kind", "accountId"], path);
    if (typeof record.accountId !== "string" || !ACCOUNT_ID_PATTERN.test(record.accountId)) {
      throw new MoesiPlanError("invalid_sender", `${path}.accountId`, "account id is invalid");
    }
    return { kind: "logical-smart-account", accountId: record.accountId };
  }
  throw new MoesiPlanError("invalid_sender", `${path}.kind`, "step sender kind is invalid");
}

function parseEnforcement(value: unknown, path: string): PlanEnforcement {
  const record = asRecord(value, path, "invalid_enforcement");
  exactKeys(record, ["callScope", "expiry", "operationLimit"], path);
  if (
    record.callScope !== "required-onchain" &&
    record.callScope !== "interactive-review-sufficient"
  ) {
    throw new MoesiPlanError("invalid_enforcement", `${path}.callScope`, "callScope is invalid");
  }
  if (record.expiry !== "required" && record.expiry !== "optional") {
    throw new MoesiPlanError("invalid_enforcement", `${path}.expiry`, "expiry is invalid");
  }
  if (record.operationLimit !== "required" && record.operationLimit !== "optional") {
    throw new MoesiPlanError(
      "invalid_enforcement",
      `${path}.operationLimit`,
      "operationLimit is invalid",
    );
  }
  return {
    callScope: record.callScope,
    expiry: record.expiry,
    operationLimit: record.operationLimit,
  };
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
  manifest: MoesiManifest,
  cells: readonly ResourceCell[],
  steps: readonly DeploymentStep[],
): void {
  const cellsByKey = new Map(cells.map((cell) => [`${cell.chainId}:${cell.resourceId}`, cell]));
  const resources = new Map(manifest.contracts.map((resource) => [resource.id, resource]));
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
    const resource = resources.get(step.resourceId);
    if (!resource) {
      throw new MoesiPlanError(
        "manifest_mismatch",
        "plan.steps",
        `step ${step.id} is not declared by the manifest`,
      );
    }
    if (
      hashCanonical(step.sender) !== hashCanonical(compileResourceSender(resource.sender)) ||
      hashCanonical(step.enforcement) !== hashCanonical(compileResourceEnforcement(resource))
    ) {
      throw new MoesiPlanError(
        "manifest_mismatch",
        "plan.steps",
        `step ${step.id} has sender or enforcement requirements that contradict the manifest`,
      );
    }
    if (step.kind === "deploy") {
      const expectedCall = compileDeploymentCall(resource);
      if (
        step.id !== `${resource.id}:deploy` ||
        cell.status.kind !== "missing" ||
        step.drift !== "missing" ||
        step.configurationId !== null ||
        hashCanonical(step.call) !== hashCanonical(expectedCall) ||
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
    const rule = resource.configuration.find(({ id }) => id === step.configurationId);
    const postcondition = step.postconditions[0];
    const configurationMatchesCell =
      (cell.status.kind === "missing" && step.drift === "missing") ||
      (cell.status.kind === "configuration-drift" &&
        step.drift === "configuration-drift" &&
        mismatch !== undefined);
    if (
      step.id !== `${resource.id}:configure:${step.configurationId}` ||
      step.configurationId === null ||
      !configurationMatchesCell ||
      !configuration ||
      !rule ||
      (mismatch !== undefined && mismatch.expectedResult !== configuration.expectedResult) ||
      hashCanonical(step.call) !== hashCanonical(compileConfigurationCall(cell.address, rule)) ||
      step.postconditions.length !== 1 ||
      postcondition?.kind !== "static-call" ||
      postcondition.target !== cell.address ||
      postcondition.data !== configuration.readData ||
      postcondition.caller !== configuration.caller ||
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
    if (cell.status.kind === "missing") {
      const deployments = owned.filter(({ kind }) => kind === "deploy");
      const configurationIds = owned
        .filter(({ kind }) => kind === "configure")
        .map(({ configurationId }) => configurationId)
        .sort((left, right) => compareAscii(left ?? "", right ?? ""));
      const expectedConfigurationIds = cell.configuration
        .map(({ id }) => id)
        .sort((left, right) => compareAscii(left, right));
      if (
        deployments.length !== 1 ||
        configurationIds.length !== expectedConfigurationIds.length ||
        configurationIds.some((id, index) => id !== expectedConfigurationIds[index])
      ) {
        throw new MoesiPlanError(
          "missing_step",
          "plan.steps",
          `missing cell ${cell.chainId}:${cell.resourceId} lacks exact convergence steps`,
        );
      }
    } else if (cell.status.kind === "configuration-drift") {
      const configurationIds = owned
        .filter(({ kind }) => kind === "configure")
        .map(({ configurationId }) => configurationId)
        .sort((left, right) => compareAscii(left ?? "", right ?? ""));
      const mismatchIds = cell.status.mismatches
        .map(({ id }) => id)
        .sort((left, right) => compareAscii(left, right));
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
    } else if (owned.length > 0) {
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
  if (
    typeof record.value !== "string" ||
    !UINT256_PATTERN.test(record.value) ||
    BigInt(record.value) > MAX_UINT256
  ) {
    throw new MoesiPlanError(
      "invalid_call",
      `${path}.value`,
      "call value must be a canonical decimal uint256 string",
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
    exactKeys(record, ["kind", "target", "data", "caller", "expectedResult"], path);
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
      caller: parseAddress(record.caller, `${path}.caller`, "invalid_postcondition"),
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

function parseChainId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MoesiPlanError("invalid_chain", path, "chain id must be a positive safe integer");
  }
  return value;
}

function parseAddress(
  value: unknown,
  path: string,
  code: "invalid_call" | "invalid_postcondition" | "invalid_cell" | "invalid_step",
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
  const entries = snapshotArray(value);
  if (entries === null) {
    throw new MoesiPlanError("invalid_cell", path, "configuration must be an array");
  }
  const seen = new Set<string>();
  const configuration = mapArrayElements(entries, (entry, index) => {
    const itemPath = `${path}[${index}]`;
    const record = asRecord(entry, itemPath, "invalid_cell");
    exactKeys(record, ["id", "readData", "caller", "expectedResult"], itemPath);
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
      caller: parseAddress(record.caller, `${itemPath}.caller`, "invalid_cell"),
      expectedResult: parseHex(record.expectedResult, `${itemPath}.expectedResult`, "invalid_cell"),
    };
  });
  return configuration.sort((left, right) => compareAscii(left.id, right.id));
}

function parsePlanManifest(value: unknown): ReturnType<typeof parseManifest> {
  try {
    return parseManifest(value as MoesiManifest);
  } catch {
    throw new MoesiPlanError("invalid_manifest", "plan.manifest", "plan manifest is invalid");
  }
}

function parseConfigurationResults(
  value: unknown,
  path: string,
): Array<{ id: string; result: Hex }> {
  const entries = snapshotArray(value);
  if (entries === null) {
    throw new MoesiPlanError("invalid_cell", path, "configurationResults must be an array");
  }
  const seen = new Set<string>();
  const results = mapArrayElements(entries, (entry, index) => {
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
  return results.sort((left, right) => compareAscii(left.id, right.id));
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
