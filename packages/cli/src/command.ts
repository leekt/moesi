import { readFile } from "node:fs/promises";
import {
  createMoesi,
  type DeploymentRunRecord,
  type DeploymentRunStore,
  deploymentRunNeedsRecovery,
  MoesiManifestError,
  MoesiPlanningError,
  MoesiRunError,
  parseDeploymentRunId,
  parseDeploymentRunRecord,
  type ReviewedPlan,
} from "moesi";
import { CliError, type CliErrorCode } from "./errors.js";
import { type CliFetch, createRpcObservationAdapter, type RpcChainBinding } from "./rpc.js";
import { createFileDeploymentRunStore } from "./run-store.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly fetch: CliFetch;
  readonly createRunStore?: (directory: string) => DeploymentRunStore;
}

interface PlanArguments {
  readonly kind: "plan";
  readonly manifestPath: string;
  readonly chains: readonly RpcChainBinding[];
  readonly json: boolean;
}

interface HelpArguments {
  readonly kind: "help";
}

interface StatusArguments {
  readonly kind: "status";
  readonly runId: string;
  readonly storeDirectory: string;
  readonly json: boolean;
}

type ParsedArguments = PlanArguments | StatusArguments | HelpArguments;

const HELP = `Usage:
  moesi plan --manifest <path> --chain <chainId>=<rpcUrl> [--chain ...] [--json]
  moesi status --run <runId> --store <directory> [--json]

Commands:
  plan    Observe pinned state and produce a reviewed deployment plan.
  status  Read canonical persisted DeploymentRun execution state.
`;

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFile(path, "utf8"),
    fetch: globalThis.fetch,
    createRunStore: (directory) => createFileDeploymentRunStore({ directory }),
  },
): Promise<number> {
  let jsonOutput = argv.includes("--json");
  try {
    const arguments_ = parseArguments(argv);
    if (arguments_.kind === "help") {
      io.stdout(HELP);
      return 0;
    }
    jsonOutput = arguments_.json;
    if (arguments_.kind === "status") {
      const store = (
        io.createRunStore ?? ((directory) => createFileDeploymentRunStore({ directory }))
      )(arguments_.storeDirectory);
      const value = await store.get(arguments_.runId);
      if (value === undefined) {
        throw new MoesiRunError("run_not_found", "deployment run does not exist");
      }
      const record = parseDeploymentRunRecord(value);
      if (record.runId !== arguments_.runId) {
        throw new MoesiRunError(
          "run_record_invalid",
          "deployment run store returned a different run",
        );
      }
      io.stdout(jsonOutput ? renderStatusJson(record) : renderStatusHuman(record));
      return 0;
    }
    let source: string;
    try {
      source = await io.readFile(arguments_.manifestPath);
    } catch {
      throw new CliError("manifest_read_failed", "manifest could not be read");
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(source);
    } catch {
      throw new CliError("manifest_json_invalid", "manifest is not valid JSON");
    }
    const observer = createRpcObservationAdapter(arguments_.chains, io.fetch);
    const plan = await createMoesi({ observer }).plan({
      manifest: manifest as never,
      chains: arguments_.chains.map(({ chainId }) => chainId),
    });
    io.stdout(jsonOutput ? renderJson(plan) : renderHuman(plan));
    return exitCodeFor(plan);
  } catch (error) {
    const code = errorCode(error);
    io.stderr(
      jsonOutput
        ? `${JSON.stringify({ version: "moesi.cli-error/v1", error: { code } })}\n`
        : `MOESI_CLI_ERROR ${code}\n`,
    );
    return 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
    return { kind: "help" };
  }
  if (argv[0] === "status") return parseStatusArguments(argv);
  if (argv[0] !== "plan") throw new CliError("invalid_arguments", "unknown command");

  let manifestPath: string | undefined;
  let json = false;
  const chains: RpcChainBinding[] = [];
  const seenChains = new Set<number>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--manifest") {
      if (manifestPath !== undefined) {
        throw new CliError("invalid_arguments", "duplicate --manifest");
      }
      const value = argv[index + 1];
      if (!value) throw new CliError("invalid_arguments", "missing manifest path");
      manifestPath = value;
      index += 1;
      continue;
    }
    if (argument === "--chain") {
      const value = argv[index + 1];
      if (!value) throw new CliError("invalid_arguments", "missing chain binding");
      const binding = parseChainBinding(value);
      if (seenChains.has(binding.chainId)) {
        throw new CliError("invalid_arguments", "duplicate chain binding");
      }
      seenChains.add(binding.chainId);
      chains.push(binding);
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }
  if (!manifestPath || chains.length === 0) {
    throw new CliError("invalid_arguments", "manifest and chain are required");
  }
  chains.sort((left, right) => left.chainId - right.chainId);
  return { kind: "plan", manifestPath, chains, json };
}

function parseStatusArguments(argv: readonly string[]): StatusArguments {
  let runId: string | undefined;
  let storeDirectory: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--run") {
      if (runId !== undefined) throw new CliError("invalid_arguments", "duplicate --run");
      const value = argv[index + 1];
      if (!value) throw new CliError("invalid_arguments", "missing run id");
      try {
        runId = parseDeploymentRunId(value);
      } catch {
        throw new CliError("invalid_arguments", "run id is invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--store") {
      if (storeDirectory !== undefined) {
        throw new CliError("invalid_arguments", "duplicate --store");
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("-") || value.includes("\0")) {
        throw new CliError("invalid_arguments", "store directory is invalid");
      }
      storeDirectory = value;
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }
  if (runId === undefined || storeDirectory === undefined) {
    throw new CliError("invalid_arguments", "run and store are required");
  }
  return { kind: "status", runId, storeDirectory, json };
}

function parseChainBinding(value: string): RpcChainBinding {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliError("invalid_arguments", "chain binding is invalid");
  }
  const chainText = value.slice(0, separator);
  if (!/^[1-9][0-9]*$/.test(chainText)) {
    throw new CliError("invalid_arguments", "chain id is invalid");
  }
  const chainId = Number(chainText);
  if (!Number.isSafeInteger(chainId)) {
    throw new CliError("invalid_arguments", "chain id is invalid");
  }
  const urlText = value.slice(separator + 1);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new CliError("invalid_arguments", "RPC URL is invalid");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new CliError("invalid_arguments", "RPC URL is invalid");
  }
  return { chainId, url: url.toString() };
}

function renderHuman(plan: ReviewedPlan): string {
  const blocked = plan.cells.filter(
    ({ status }) => status.kind === "bytecode-drift" || status.kind === "unreadable",
  ).length;
  const lines = [
    `Moesi plan ${plan.planId}`,
    `disposition ${plan.disposition}`,
    `manifest ${plan.manifestHash}`,
    `chains ${plan.snapshots.length}`,
    `steps ${plan.steps.length}`,
    `blocked ${blocked}`,
  ];
  for (const cell of plan.cells) {
    lines.push(`${cell.chainId} ${cell.resourceId} ${cell.address} ${cell.status.kind}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderJson(plan: ReviewedPlan): string {
  return `${JSON.stringify({ version: "moesi.cli-plan/v1", plan })}\n`;
}

function renderStatusHuman(record: DeploymentRunRecord): string {
  const lines = [
    `Moesi run ${record.runId}`,
    `plan ${record.plan.planId}`,
    `provider ${record.providerId}`,
    `revision ${record.revision}`,
    `execution ${executionState(record)}`,
    "convergence not-recorded",
  ];
  for (const step of record.steps) {
    const reference = "reference" in step ? step.reference.reference : "-";
    const reason = step.phase === "failed" ? ` ${step.reason}` : "";
    lines.push(`${step.chainId} ${step.stepId} ${step.phase} ${reference}${reason}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderStatusJson(record: DeploymentRunRecord): string {
  return `${JSON.stringify({
    version: "moesi.cli-status/v1",
    run: {
      runId: record.runId,
      planId: record.plan.planId,
      providerId: record.providerId,
      revision: record.revision,
      executionState: executionState(record),
      convergence: "not-recorded",
      steps: record.steps.map((step) => ({
        stepId: step.stepId,
        chainId: step.chainId,
        phase: step.phase,
        reason: step.phase === "failed" ? step.reason : null,
        reference: "reference" in step ? step.reference : null,
        providerEvidence:
          "providerEvidence" in step && step.providerEvidence !== null
            ? {
                providerEvidenceId: step.providerEvidence.providerEvidenceId,
                blockNumber: step.providerEvidence.blockNumber,
                blockHash: step.providerEvidence.blockHash,
              }
            : null,
      })),
    },
  })}\n`;
}

function executionState(
  record: DeploymentRunRecord,
): "recovery-required" | "failed" | "finalized" | "no-actions" {
  if (deploymentRunNeedsRecovery(record)) return "recovery-required";
  if (record.steps.some(({ phase }) => phase === "failed")) return "failed";
  if (record.steps.length === 0) return "no-actions";
  return "finalized";
}

function exitCodeFor(plan: ReviewedPlan): number {
  if (plan.disposition === "converged") return 0;
  if (plan.disposition === "changes") return 2;
  return 3;
}

function errorCode(
  error: unknown,
):
  | CliErrorCode
  | MoesiManifestError["code"]
  | MoesiPlanningError["code"]
  | MoesiRunError["code"]
  | "internal" {
  try {
    const descriptor =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")
        : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : undefined;
    if (typeof code !== "string") return "internal";
    if (error instanceof CliError && CLI_ERROR_CODES.has(code)) return code as CliErrorCode;
    if (error instanceof MoesiManifestError && MANIFEST_ERROR_CODES.has(code)) {
      return code as MoesiManifestError["code"];
    }
    if (error instanceof MoesiPlanningError && PLANNING_ERROR_CODES.has(code)) {
      return code as MoesiPlanningError["code"];
    }
    if (error instanceof MoesiRunError && RUN_ERROR_CODES.has(code)) {
      return code as MoesiRunError["code"];
    }
  } catch {
    return "internal";
  }
  return "internal";
}

const CLI_ERROR_CODES = new Set<string>([
  "invalid_arguments",
  "manifest_read_failed",
  "manifest_json_invalid",
  "internal",
]);
const MANIFEST_ERROR_CODES = new Set<string>([
  "invalid_manifest",
  "unsupported_manifest_version",
  "unknown_field",
  "duplicate_resource",
  "invalid_resource",
  "invalid_deployment",
  "invalid_sender",
  "invalid_enforcement",
]);
const PLANNING_ERROR_CODES = new Set<string>([
  "invalid_chains",
  "duplicate_chain",
  "snapshot_unreadable",
  "invalid_snapshot",
]);
const RUN_ERROR_CODES = new Set<string>([
  "run_store_required",
  "run_store_failed",
  "run_store_conflict",
  "run_not_found",
  "run_record_invalid",
  "run_plan_mismatch",
  "run_provider_mismatch",
]);
