import { readFile } from "node:fs/promises";
import {
  createMoesi,
  type DeploymentRunRecord,
  type DeploymentRunStore,
  deploymentRunNeedsRecovery,
  type ExecutionPacking,
  MAX_MANIFEST_TEXT_BYTES,
  MoesiExecutionError,
  type MoesiManifest,
  MoesiManifestError,
  MoesiPlanError,
  MoesiPlanningError,
  MoesiRunError,
  parseDeploymentRunId,
  parseDeploymentRunRecord,
  parseManifestText,
  parseReviewedPlan,
  type ReviewedPlan,
} from "moesi";
import { checkFleetParity, MoesiFleetParityError, parseFleetBaseline } from "moesi/fleet";
import { callCheckEvidence, configurationEvidence, storageCheckEvidence } from "./cell-evidence.js";
import { type CliCetaneRuntimeFactory, createCliCetaneRuntime } from "./cetane-runtime.js";
import { renderErrorHuman } from "./error-output.js";
import { CliError, type CliErrorCode } from "./errors.js";
import {
  createCliExecutionReview,
  executionReviewFromRecord,
  renderExecutionReviewHuman,
  renderExecutionReviewJson,
  renderRunHuman,
  renderRunJson,
} from "./execution-output.js";
import { planGuidance, statusGuidance } from "./guidance.js";
import { type CliCommand, COMMANDS, renderHelp } from "./help.js";
import {
  CLI_PLAN_VERSION,
  renderInspectionHuman,
  renderInspectionJson,
  renderPlanArtifact,
} from "./inspection-output.js";
import { moduleEvidenceLines } from "./module-output.js";
import { type CliOAAthRuntimeFactory, createCliOAAthRuntime } from "./oaath-runtime.js";
import { errorObservationCause, formatObservationCause } from "./observation-output.js";
import { renderParityHuman } from "./parity-output.js";
import { writePlanFile } from "./plan-file.js";
import { type CliFetch, createRpcObservationAdapter, type RpcChainBinding } from "./rpc.js";
import { createFileDeploymentRunStore } from "./run-store.js";
import {
  renderVerificationHuman,
  renderVerificationJson,
  verificationExitCode,
} from "./verification-output.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly readStdin?: () => Promise<string>;
  readonly fetch: CliFetch;
  readonly writePlanFile?: (path: string, source: string) => Promise<void>;
  readonly interactive?: boolean;
  readonly createRunStore?: (directory: string) => DeploymentRunStore;
  readonly readEnv?: (name: string) => string | undefined;
  readonly createCetaneRuntime?: CliCetaneRuntimeFactory;
  readonly createOAAthRuntime?: CliOAAthRuntimeFactory;
  readonly installSignalHandlers?: (handler: (signal: "SIGINT" | "SIGTERM") => void) => () => void;
}

interface PlanArguments {
  readonly kind: "plan";
  readonly manifestPath: string;
  readonly outputPath: string | null;
  readonly chains: readonly RpcChainBinding[];
  readonly peerChains: readonly RpcChainBinding[];
  readonly json: boolean;
}

interface ParityArguments extends Omit<PlanArguments, "kind" | "outputPath"> {
  readonly kind: "check-parity";
  readonly baselinePath: string;
}

interface HelpArguments {
  readonly kind: "help";
  readonly command: CliCommand | null;
}

interface InspectArguments {
  readonly kind: "inspect";
  readonly planPath: string;
  readonly json: boolean;
}

interface VerifyArguments {
  readonly kind: "verify";
  readonly planPath: string;
  readonly chains: readonly RpcChainBinding[];
  readonly peerChains: readonly RpcChainBinding[];
  readonly json: boolean;
}

interface StatusArguments {
  readonly kind: "status";
  readonly runId: string;
  readonly storeDirectory: string;
  readonly json: boolean;
}

interface SignerBinding {
  readonly chainId: number;
  readonly environmentName: string;
}

interface ExecutionCommon {
  readonly chains: readonly RpcChainBinding[];
  readonly peerChains: readonly RpcChainBinding[];
  readonly storeDirectory: string;
  readonly observeAttempts: number;
  readonly observeDelayMs: number;
  readonly json: boolean;
}

type ExecutionOptions = ExecutionCommon &
  (
    | {
        readonly provider: "cetane";
        readonly signers: readonly SignerBinding[];
        readonly confirmations: number;
      }
    | { readonly provider: "oaath"; readonly clientModule: string }
  );

interface AuthorizeArguments {
  readonly packing: ExecutionPacking;
  readonly kind: "authorize";
  readonly planPath: string;
  readonly clientModule: string;
  readonly json: boolean;
}

type ApplyArguments = ExecutionOptions & {
  readonly kind: "apply";
  readonly planPath: string;
  readonly acceptedReview: string | null;
  readonly packing: ExecutionPacking | undefined;
};

type ResumeArguments = ExecutionOptions & {
  readonly kind: "resume";
  readonly observeOnly: boolean;
  readonly runId: string;
};

type ParsedArguments =
  | PlanArguments
  | ParityArguments
  | AuthorizeArguments
  | InspectArguments
  | VerifyArguments
  | StatusArguments
  | ApplyArguments
  | ResumeArguments
  | HelpArguments;

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    interactive: process.stderr.isTTY === true,
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFile(path, "utf8"),
    readStdin: readProcessStdin,
    fetch: globalThis.fetch,
    createRunStore: (directory) => createFileDeploymentRunStore({ directory }),
    readEnv: (name) => process.env[name],
    createCetaneRuntime: createCliCetaneRuntime,
    installSignalHandlers: installProcessSignalHandlers,
  },
): Promise<number> {
  let jsonOutput = argv.includes("--json");
  try {
    const arguments_ = parseArguments(argv);
    if (arguments_.kind === "help") {
      io.stdout(renderHelp(arguments_.command));
      return 0;
    }
    jsonOutput = arguments_.json;
    if (arguments_.kind === "inspect") return await runInspect(arguments_, io);
    if (arguments_.kind === "verify") return await runVerify(arguments_, io);
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
    if (arguments_.kind === "authorize") return await runAuthorize(arguments_, io);
    if (arguments_.kind === "apply") return await runApply(arguments_, io);
    if (arguments_.kind === "resume") return await runResume(arguments_, io);
    let source: string;
    try {
      source =
        arguments_.manifestPath === "-"
          ? await (io.readStdin ?? readProcessStdin)()
          : await io.readFile(arguments_.manifestPath);
    } catch (error) {
      if (error instanceof MoesiManifestError) throw error;
      throw new CliError("manifest_read_failed", "manifest could not be read");
    }
    const manifest = parseManifestText(source);
    if (arguments_.kind === "check-parity") return await runCheckParity(arguments_, manifest, io);
    assertPeerChainCoverage(
      manifest.contracts.flatMap((resource) =>
        resource.kind === "managed"
          ? resource.configuration.flatMap((row) => (row.after ?? []).map((peer) => peer.chainId))
          : [],
      ),
      arguments_,
    );
    const observer = createRpcObservationAdapter(observationBindings(arguments_), io.fetch);
    const plan = await createMoesi({ observer }).plan({
      manifest,
      chains: arguments_.chains.map(({ chainId }) => chainId),
    });
    if (arguments_.outputPath !== null) {
      await (io.writePlanFile ?? writePlanFile)(arguments_.outputPath, renderPlanArtifact(plan));
    }
    io.stdout(jsonOutput ? renderJson(plan) : renderHuman(plan));
    if (!jsonOutput && arguments_.outputPath !== null) {
      io.stdout("Plan saved. Inspect the saved file with moesi inspect --plan <path>.\n");
    }
    return exitCodeFor(plan);
  } catch (error) {
    const code = errorCode(error);
    const cause = errorObservationCause(error);
    io.stderr(
      jsonOutput
        ? `${JSON.stringify({ version: "moesi.cli-error/v2", error: { code, ...(cause ? { cause } : {}) } })}\n`
        : `${renderErrorHuman(code, error).trimEnd()}${formatObservationCause(cause)}\n`,
    );
    return 1;
  }
}

async function runCheckParity(
  arguments_: ParityArguments,
  manifest: MoesiManifest,
  io: CliIo,
): Promise<number> {
  let source: string;
  try {
    source = await io.readFile(arguments_.baselinePath);
  } catch {
    throw new CliError("fleet_baseline_read_failed", "fleet baseline could not be read");
  }
  if (Buffer.byteLength(source, "utf8") > 32 * 1024 * 1024)
    throw new CliError("fleet_baseline_too_large", "fleet baseline exceeds the byte limit");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError("fleet_baseline_json_invalid", "fleet baseline is not JSON");
  }
  const baseline = parseFleetBaseline(value);
  const chains = arguments_.chains.map(({ chainId }) => chainId);
  assertPeerChainCoverage(
    [
      ...manifest.contracts.flatMap((resource) =>
        resource.kind === "managed"
          ? resource.configuration.flatMap((row) => (row.after ?? []).map((peer) => peer.chainId))
          : [],
      ),
      ...baseline.cells
        .filter((cell) => chains.includes(cell.chainId))
        .flatMap((cell) =>
          cell.configuration.flatMap((row) => row.after.map((peer) => peer.chainId)),
        ),
    ],
    arguments_,
  );
  const result = await checkFleetParity({
    baseline,
    manifest,
    chains,
    observer: createRpcObservationAdapter(observationBindings(arguments_), io.fetch),
  });
  io.stdout(arguments_.json ? `${JSON.stringify(result)}\n` : renderParityHuman(result));
  return result.status === "match" ? 0 : result.status === "different" ? 2 : 3;
}

async function readProcessStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let source = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = String(chunk);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_MANIFEST_TEXT_BYTES)
      throw new MoesiManifestError(
        "manifest_source_too_large",
        "manifest",
        "manifest source exceeds the byte limit",
      );
    source += text;
  }
  return source;
}

async function runInspect(arguments_: InspectArguments, io: CliIo): Promise<0> {
  const plan = await readPlanArtifact(arguments_.planPath, io);
  io.stdout(arguments_.json ? renderInspectionJson(plan) : renderInspectionHuman(plan));
  return 0;
}

async function runVerify(arguments_: VerifyArguments, io: CliIo): Promise<number> {
  const plan = await readPlanArtifact(arguments_.planPath, io);
  assertExactChainCoverage(
    plan.snapshots.map(({ chainId }) => chainId),
    arguments_.chains,
  );
  assertPeerChainCoverage(
    plan.peers.map((peer) => peer.chainId),
    arguments_,
  );
  const observer = createRpcObservationAdapter(observationBindings(arguments_), io.fetch);
  const result = await createMoesi({ observer }).verify({ plan });
  io.stdout(
    arguments_.json ? renderVerificationJson(result) : renderVerificationHuman(result, plan),
  );
  return verificationExitCode(result);
}

async function runAuthorize(arguments_: AuthorizeArguments, io: CliIo): Promise<number> {
  const plan = await readPlanArtifact(arguments_.planPath, io);
  if (plan.steps.length === 0)
    throw new CliError("invalid_arguments", "plan has no calls to authorize");
  const runtime = await (io.createOAAthRuntime ?? createCliOAAthRuntime)(arguments_.clientModule);
  try {
    const permission = await runtime.authorize(plan, arguments_.packing);
    io.stdout(
      arguments_.json
        ? `${JSON.stringify({ version: "moesi.cli-permission/v2", packing: arguments_.packing, providerId: "oaath", planId: plan.planId, ...permission })}\n`
        : `OAAth permission ${permission.status}\nplan ${plan.planId}\ngrant-reference ${permission.grantReference}\nexecution not-started\n`,
    );
    return 0;
  } finally {
    await closeExecutionRuntime(runtime, io, arguments_.json);
  }
}

async function runApply(arguments_: ApplyArguments, io: CliIo): Promise<number> {
  const plan = await readPlanArtifact(arguments_.planPath, io);
  assertExactChainCoverage(
    plan.snapshots.map(({ chainId }) => chainId),
    arguments_.chains,
  );
  assertPeerChainCoverage(
    plan.peers.map((peer) => peer.chainId),
    arguments_,
  );
  const store = createRunStore(arguments_.storeDirectory, io);
  const runtime = await createExecutionRuntime(
    arguments_,
    new Set(plan.requirements.map((r) => r.chainId)),
    new Set(plan.snapshots.map((r) => r.chainId)),
    io,
  );
  try {
    const client = createMoesi({ observer: runtime.observer, runStore: store });
    const executionReview = await client.reviewExecution({
      plan,
      provider: runtime.provider,
      ...(arguments_.packing === undefined ? {} : { packing: arguments_.packing }),
    });
    const review = createCliExecutionReview(plan, executionReview, arguments_.storeDirectory);

    if (executionReview.provider.status === "blocked") {
      io.stdout(
        arguments_.json
          ? renderExecutionReviewJson(review)
          : renderExecutionReviewHuman(review, false),
      );
      return 3;
    }
    if (plan.steps.length === 0) {
      io.stdout(
        arguments_.json
          ? renderExecutionReviewJson(review)
          : renderExecutionReviewHuman(review, false),
      );
      return plan.disposition === "converged" ? 0 : 3;
    }
    if (arguments_.acceptedReview === null) {
      io.stdout(
        arguments_.json
          ? renderExecutionReviewJson(review)
          : renderExecutionReviewHuman(review, true),
      );
      return 2;
    }
    if (arguments_.acceptedReview !== review.reviewId) {
      throw new CliError(
        "execution_review_mismatch",
        "accepted execution review does not match the current provider decision",
      );
    }

    const run = client.apply({
      plan,
      provider: runtime.provider,
      executionReview,
      observeTiming: {
        attempts: arguments_.observeAttempts,
        delayMs: arguments_.observeDelayMs,
      },
    });
    const { result, stoppedBy } = await waitForRun(run, io, arguments_.json);
    io.stdout(
      arguments_.json
        ? renderRunJson(review, run, result, stoppedBy)
        : renderRunHuman(review, run, result, stoppedBy),
    );
    if (stoppedBy !== null) return stoppedBy === "SIGINT" ? 130 : 143;
    return result.status === "converged" ? 0 : 3;
  } finally {
    await closeExecutionRuntime(runtime, io, arguments_.json);
  }
}

async function runResume(arguments_: ResumeArguments, io: CliIo): Promise<number> {
  const store = createRunStore(arguments_.storeDirectory, io);
  const record = await loadRunRecord(store, arguments_.runId);
  if (record.providerId !== arguments_.provider) {
    throw new MoesiRunError("run_provider_mismatch", "deployment run uses a different provider");
  }
  assertExactChainCoverage(
    record.plan.snapshots.map(({ chainId }) => chainId),
    arguments_.chains,
  );
  assertPeerChainCoverage(
    record.plan.peers.map((peer) => peer.chainId),
    arguments_,
  );
  if (arguments_.provider === "cetane")
    assertCetaneConfirmationPolicy(record, arguments_.confirmations);
  const needsPendingPreflight = !arguments_.observeOnly && hasReachablePendingOperation(record);
  const runtime = await createExecutionRuntime(
    arguments_,
    needsPendingPreflight
      ? new Set(record.plan.requirements.map(({ chainId }) => chainId))
      : new Set(),
    new Set(record.plan.snapshots.map(({ chainId }) => chainId)),
    io,
  );
  try {
    const client = createMoesi({ observer: runtime.observer, runStore: store });
    const run = await client.resume({
      mode: arguments_.observeOnly ? "observe-only" : "continue",
      runId: record.runId,
      provider: runtime.provider,
      observeTiming: {
        attempts: arguments_.observeAttempts,
        delayMs: arguments_.observeDelayMs,
      },
    });
    const { result, stoppedBy } = await waitForRun(
      run,
      io,
      arguments_.json,
      arguments_.observeOnly,
    );
    const review = executionReviewFromRecord(record, arguments_.storeDirectory);
    io.stdout(
      arguments_.json
        ? renderRunJson(review, run, result, stoppedBy)
        : renderRunHuman(review, run, result, stoppedBy),
    );
    if (stoppedBy !== null) return stoppedBy === "SIGINT" ? 130 : 143;
    return result.status === "converged" ? 0 : 3;
  } finally {
    await closeExecutionRuntime(runtime, io, arguments_.json);
  }
}

async function closeExecutionRuntime(
  runtime: { readonly close: () => Promise<void> },
  io: CliIo,
  json: boolean,
): Promise<void> {
  try {
    await runtime.close();
  } catch {
    // Cleanup cannot change the permission/operation outcome or authorize a retry.
    // Keep stdout and the exit status authoritative, with only a fixed diagnostic.
    io.stderr(
      json
        ? `${JSON.stringify({ version: "moesi.cli-warning/v1", warning: { code: "runtime_cleanup_failed" } })}\n`
        : "warning: runtime_cleanup_failed. Runtime resources could not be closed. Preserve the SDK stores and inspect the saved Run before continuing execution.\n",
    );
  }
}

async function waitForRun(
  run: ReturnType<ReturnType<typeof createMoesi>["apply"]>,
  io: CliIo,
  json: boolean,
  observeOnly = false,
): Promise<{
  readonly result: Awaited<ReturnType<typeof run.wait>>;
  readonly stoppedBy: "SIGINT" | "SIGTERM" | null;
}> {
  const showProgress = io.interactive === true && !json;
  if (showProgress) {
    io.stderr(
      `Run ${run.runId}: ${observeOnly ? "observing saved operations without starting pending work" : "checking saved progress and executing reviewed work"}.\n`,
    );
    io.stderr("Waiting for execution and fresh verification. Press Ctrl+C once to stop safely.\n");
  }
  let stoppedBy: "SIGINT" | "SIGTERM" | null = null;
  let disarmRequested = false;
  let remove = () => {
    disarmRequested = true;
  };
  const installed =
    io.installSignalHandlers?.((signal) => {
      if (stoppedBy !== null) return;
      stoppedBy = signal;
      run.requestStop();
      if (showProgress)
        io.stderr("Stop requested. Waiting for the current operation to reach a safe boundary.\n");
      remove();
    }) ?? (() => {});
  remove = installed;
  if (disarmRequested) remove();
  try {
    return { result: await run.wait(), stoppedBy };
  } finally {
    remove();
  }
}

function installProcessSignalHandlers(handler: (signal: "SIGINT" | "SIGTERM") => void): () => void {
  const interrupt = () => handler("SIGINT");
  const terminate = () => handler("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  return () => {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  };
}

async function readPlanArtifact(path: string, io: CliIo): Promise<ReviewedPlan> {
  let source: string;
  try {
    source = await io.readFile(path);
  } catch {
    throw new CliError("plan_read_failed", "reviewed plan could not be read");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError("plan_json_invalid", "reviewed plan is not valid JSON");
  }
  const artifact = plainRecord(value);
  if (
    typeof artifact?.version === "string" &&
    artifact.version.startsWith("moesi.cli-plan/") &&
    artifact.version !== CLI_PLAN_VERSION
  ) {
    throw new CliError(
      "unsupported_plan_artifact_version",
      "reviewed plan artifact version is unsupported",
    );
  }
  if (
    artifact === null ||
    !exactKeys(artifact, ["version", "plan"]) ||
    artifact.version !== CLI_PLAN_VERSION
  ) {
    throw new CliError("plan_artifact_invalid", "reviewed plan artifact is invalid");
  }
  return parseReviewedPlan(artifact.plan as ReviewedPlan);
}

async function loadRunRecord(
  store: DeploymentRunStore,
  runId: string,
): Promise<DeploymentRunRecord> {
  const value = await store.get(runId);
  if (value === undefined) {
    throw new MoesiRunError("run_not_found", "deployment run does not exist");
  }
  const record = parseDeploymentRunRecord(value);
  if (record.runId !== runId) {
    throw new MoesiRunError("run_record_invalid", "deployment run store returned another run");
  }
  return record;
}

function createRunStore(directory: string, io: CliIo): DeploymentRunStore {
  return (io.createRunStore ?? ((path) => createFileDeploymentRunStore({ directory: path })))(
    directory,
  );
}

async function createExecutionRuntime(
  arguments_: ExecutionOptions,
  required: ReadonlySet<number>,
  allowed: ReadonlySet<number>,
  io: CliIo,
) {
  if (arguments_.provider === "cetane") {
    const privateKeys = readSignerKeys(arguments_.signers, required, allowed, io);
    return { ...createCetaneRuntime(arguments_, privateKeys, io), close: async () => {} };
  }
  const runtime = await (io.createOAAthRuntime ?? createCliOAAthRuntime)(arguments_.clientModule);
  return {
    ...runtime,
    observer: createRpcObservationAdapter(observationBindings(arguments_), io.fetch),
  };
}

function createCetaneRuntime(
  arguments_: Extract<ExecutionOptions, { readonly provider: "cetane" }>,
  privateKeys: ReadonlyMap<number, string>,
  io: CliIo,
) {
  return (io.createCetaneRuntime ?? createCliCetaneRuntime)({
    chains: observationBindings(arguments_),
    privateKeys,
    confirmations: arguments_.confirmations,
  });
}

function observationBindings(
  input: Pick<ExecutionCommon, "chains" | "peerChains">,
): readonly RpcChainBinding[] {
  return [...input.chains, ...input.peerChains].sort((a, b) => a.chainId - b.chainId);
}

function assertPeerChainCoverage(
  required: readonly number[],
  input: Pick<ExecutionCommon, "chains" | "peerChains">,
): void {
  const planned = new Set(input.chains.map(({ chainId }) => chainId));
  assertExactChainCoverage(
    required.filter((chainId) => !planned.has(chainId)),
    input.peerChains,
  );
}

function assertExactChainCoverage(
  expectedChainIds: readonly number[],
  bindings: readonly RpcChainBinding[],
): void {
  const expected = [...new Set(expectedChainIds)].sort((left, right) => left - right);
  const actual = bindings.map(({ chainId }) => chainId);
  if (
    expected.length !== actual.length ||
    expected.some((chainId, index) => chainId !== actual[index])
  ) {
    throw new CliError("invalid_arguments", "chain bindings must exactly match the reviewed plan");
  }
}

function readSignerKeys(
  signers: readonly SignerBinding[],
  requiredChains: ReadonlySet<number>,
  allowedChains: ReadonlySet<number>,
  io: CliIo,
): ReadonlyMap<number, string> {
  const values = new Map<number, string>();
  for (const signer of signers) {
    if (!allowedChains.has(signer.chainId)) {
      throw new CliError("invalid_arguments", "signer chain is not in the reviewed plan");
    }
    let value: string | undefined;
    try {
      value = (io.readEnv ?? ((name) => process.env[name]))(signer.environmentName);
    } catch {
      throw new CliError("signer_unavailable", "signer environment is unavailable");
    }
    if (value === undefined || value.length === 0) {
      throw new CliError("signer_unavailable", "signer environment is unavailable");
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new CliError("signer_invalid", "signer private key is invalid");
    }
    values.set(signer.chainId, value);
  }
  for (const chainId of requiredChains) {
    if (!values.has(chainId)) {
      throw new CliError("signer_unavailable", "a required chain signer is unavailable");
    }
  }
  return values;
}

function assertCetaneConfirmationPolicy(record: DeploymentRunRecord, confirmations: number): void {
  const expectedRoute = `cetane-direct-eoa:confirmations-${confirmations}`;
  const expectedReference = new RegExp(
    `^cetane-tx-v1:(0x[0-9a-f]{64}):confirmations-${confirmations}$`,
  );
  const referencesMatch = record.operations.every((step) => {
    if (
      step.phase === "pending" ||
      step.phase === "submission-requested" ||
      step.phase === "satisfied"
    ) {
      return true;
    }
    const match = expectedReference.exec(step.reference.reference);
    if (match === null) return false;
    return !(
      "providerEvidence" in step &&
      step.providerEvidence !== null &&
      step.providerEvidence.providerEvidenceId !== match[1]
    );
  });
  if (
    record.executionReview.provider.chains.some(({ route }) => route !== expectedRoute) ||
    !referencesMatch
  ) {
    throw new MoesiRunError(
      "run_provider_mismatch",
      "cetane confirmation policy differs from the durable execution review",
    );
  }
}

function hasReachablePendingOperation(record: DeploymentRunRecord): boolean {
  for (const chainId of new Set(record.operations.map((step) => step.chainId))) {
    for (const step of record.operations.filter((candidate) => candidate.chainId === chainId)) {
      if (step.phase === "submission-requested" || step.phase === "failed") break;
      if (step.phase === "pending") return true;
    }
  }
  return false;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(record);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
    return { kind: "help", command: null };
  }
  const command = COMMANDS.find((candidate) => candidate === argv[0]);
  if (command !== undefined && (argv.includes("--help") || argv.includes("-h"))) {
    return { kind: "help", command };
  }
  if (argv[0] === "authorize") return parseAuthorizeArguments(argv);
  if (argv[0] === "status") return parseStatusArguments(argv);
  if (argv[0] === "inspect") return parseInspectArguments(argv);
  if (argv[0] === "verify") return parseVerifyArguments(argv);
  if (argv[0] === "apply" || argv[0] === "resume") {
    return parseExecutionArguments(argv, argv[0]);
  }
  if (argv[0] !== "plan" && argv[0] !== "check-parity")
    throw new CliError("invalid_arguments", "unknown command");

  let manifestPath: string | undefined;
  let baselinePath: string | undefined;
  let outputPath: string | null = null;
  let json = false;
  const chains: RpcChainBinding[] = [];
  const peerChains: RpcChainBinding[] = [];
  const seenChains = new Set<number>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--baseline" && argv[0] === "check-parity") {
      if (baselinePath !== undefined)
        throw new CliError("invalid_arguments", "duplicate --baseline");
      baselinePath = requiredOptionValue(argv, index, "baseline path");
      index += 1;
      continue;
    }
    if (argument === "--manifest") {
      if (manifestPath !== undefined) {
        throw new CliError("invalid_arguments", "duplicate --manifest");
      }
      const value = requiredOptionValue(argv, index, "manifest path", true);
      manifestPath = value;
      index += 1;
      continue;
    }
    if (argument === "--out" && argv[0] === "plan") {
      if (outputPath !== null) throw new CliError("invalid_arguments", "duplicate --out");
      outputPath = requiredOptionValue(argv, index, "output path");
      index += 1;
      continue;
    }
    if (argument === "--chain" || argument === "--peer-chain") {
      const value = requiredOptionValue(argv, index, "chain binding");
      const binding = parseChainBinding(value);
      if (seenChains.has(binding.chainId)) {
        throw new CliError("invalid_arguments", "duplicate chain binding");
      }
      seenChains.add(binding.chainId);
      (argument === "--chain" ? chains : peerChains).push(binding);
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }
  if (!manifestPath || chains.length === 0) {
    throw new CliError("invalid_arguments", "manifest and chain are required");
  }
  chains.sort((left, right) => left.chainId - right.chainId);
  peerChains.sort((left, right) => left.chainId - right.chainId);
  if (argv[0] === "check-parity") {
    if (baselinePath === undefined) throw new CliError("invalid_arguments", "baseline is required");
    return { kind: "check-parity", manifestPath, baselinePath, chains, peerChains, json };
  }
  return { kind: "plan", manifestPath, outputPath, chains, peerChains, json };
}

function parseInspectArguments(argv: readonly string[]): InspectArguments {
  let planPath: string | undefined;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--plan") {
      if (planPath !== undefined) throw new CliError("invalid_arguments", "duplicate --plan");
      planPath = requiredOptionValue(argv, index, "plan path");
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }
  if (planPath === undefined) throw new CliError("invalid_arguments", "plan is required");
  return { kind: "inspect", planPath, json };
}

function parseVerifyArguments(argv: readonly string[]): VerifyArguments {
  let planPath: string | undefined;
  let json = false;
  const chains: RpcChainBinding[] = [];
  const peerChains: RpcChainBinding[] = [];
  const seenChains = new Set<number>();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--plan") {
      if (planPath !== undefined) throw new CliError("invalid_arguments", "duplicate --plan");
      planPath = requiredOptionValue(argv, index, "plan path");
      index += 1;
      continue;
    }
    if (argument === "--chain" || argument === "--peer-chain") {
      const binding = parseChainBinding(requiredOptionValue(argv, index, "chain binding"));
      if (seenChains.has(binding.chainId)) {
        throw new CliError("invalid_arguments", "duplicate chain binding");
      }
      seenChains.add(binding.chainId);
      (argument === "--chain" ? chains : peerChains).push(binding);
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }
  if (planPath === undefined || chains.length === 0) {
    throw new CliError("invalid_arguments", "plan and chain are required");
  }
  chains.sort((left, right) => left.chainId - right.chainId);
  peerChains.sort((left, right) => left.chainId - right.chainId);
  return { kind: "verify", planPath, chains, peerChains, json };
}

function parseAuthorizeArguments(argv: readonly string[]): AuthorizeArguments {
  const options = new Map<string, string>();
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (
      option !== "--plan" &&
      option !== "--provider" &&
      option !== "--oaath-client" &&
      option !== "--packing"
    )
      throw new CliError("invalid_arguments", "unknown authorize option");
    if (options.has(option)) throw new CliError("invalid_arguments", "duplicate authorize option");
    options.set(option, requiredOptionValue(argv, index, option));
    index += 1;
  }
  const planPath = options.get("--plan");
  const clientModule = options.get("--oaath-client");
  if (!planPath || !clientModule || options.get("--provider") !== "oaath")
    throw new CliError("invalid_arguments", "authorize requires a plan and explicit OAAth client");
  return {
    kind: "authorize",
    planPath,
    clientModule,
    json,
    packing: parsePacking(options.get("--packing") ?? "per-chain"),
  };
}

function parseExecutionArguments(
  argv: readonly string[],
  kind: "apply" | "resume",
): ApplyArguments | ResumeArguments {
  let planPath: string | undefined;
  let runId: string | undefined;
  let provider: "cetane" | "oaath" | undefined;
  let clientModule: string | undefined;
  let storeDirectory: string | undefined;
  let confirmations: number | undefined;
  let acceptedReview: string | null = null;
  let packing: ExecutionPacking | undefined;
  let observeAttempts = 16;
  let observeDelayMs = 1_000;
  let observeAttemptsSet = false;
  let observeDelaySet = false;
  let json = false;
  let observeOnly = false;
  const chains: RpcChainBinding[] = [];
  const peerChains: RpcChainBinding[] = [];
  const signers: SignerBinding[] = [];
  const seenChains = new Set<number>();
  const seenSigners = new Set<number>();

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--observe-only" && kind === "resume") {
      if (observeOnly) throw new CliError("invalid_arguments", "duplicate --observe-only");
      observeOnly = true;
      continue;
    }
    if (argument === "--json") {
      if (json) throw new CliError("invalid_arguments", "duplicate --json");
      json = true;
      continue;
    }
    if (argument === "--plan" && kind === "apply") {
      if (planPath !== undefined) throw new CliError("invalid_arguments", "duplicate --plan");
      planPath = requiredOptionValue(argv, index, "plan path");
      index += 1;
      continue;
    }
    if (argument === "--run" && kind === "resume") {
      if (runId !== undefined) throw new CliError("invalid_arguments", "duplicate --run");
      const value = requiredOptionValue(argv, index, "run id");
      try {
        runId = parseDeploymentRunId(value);
      } catch {
        throw new CliError("invalid_arguments", "run id is invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--provider") {
      if (provider !== undefined) throw new CliError("invalid_arguments", "duplicate --provider");
      const value = requiredOptionValue(argv, index, "provider");
      if (value !== "cetane" && value !== "oaath") {
        throw new CliError("invalid_arguments", "select cetane or oaath explicitly");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (argument === "--chain" || argument === "--peer-chain") {
      const binding = parseChainBinding(requiredOptionValue(argv, index, "chain binding"));
      if (seenChains.has(binding.chainId)) {
        throw new CliError("invalid_arguments", "duplicate chain binding");
      }
      seenChains.add(binding.chainId);
      (argument === "--chain" ? chains : peerChains).push(binding);
      index += 1;
      continue;
    }
    if (argument === "--oaath-client") {
      if (clientModule !== undefined)
        throw new CliError("invalid_arguments", "duplicate --oaath-client");
      clientModule = requiredOptionValue(argv, index, "OAAth client module");
      index += 1;
      continue;
    }
    if (argument === "--signer") {
      const signer = parseSignerBinding(requiredOptionValue(argv, index, "signer binding"));
      if (seenSigners.has(signer.chainId)) {
        throw new CliError("invalid_arguments", "duplicate signer binding");
      }
      seenSigners.add(signer.chainId);
      signers.push(signer);
      index += 1;
      continue;
    }
    if (argument === "--confirmations") {
      if (confirmations !== undefined) {
        throw new CliError("invalid_arguments", "duplicate --confirmations");
      }
      confirmations = parseBoundedInteger(
        requiredOptionValue(argv, index, "confirmation count"),
        1,
        64,
      );
      index += 1;
      continue;
    }
    if (argument === "--store") {
      if (storeDirectory !== undefined) {
        throw new CliError("invalid_arguments", "duplicate --store");
      }
      const value = requiredOptionValue(argv, index, "store directory");
      if (value.includes("\0")) {
        throw new CliError("invalid_arguments", "store directory is invalid");
      }
      storeDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--packing" && kind === "apply") {
      if (packing !== undefined) throw new CliError("invalid_arguments", "duplicate --packing");
      packing = parsePacking(requiredOptionValue(argv, index, "packing"));
      index += 1;
      continue;
    }
    if (argument === "--accept-review" && kind === "apply") {
      if (acceptedReview !== null) {
        throw new CliError("invalid_arguments", "duplicate --accept-review");
      }
      const value = requiredOptionValue(argv, index, "execution review id");
      if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
        throw new CliError("invalid_arguments", "execution review id is invalid");
      }
      acceptedReview = value.toLowerCase();
      index += 1;
      continue;
    }
    if (argument === "--observe-attempts") {
      if (observeAttemptsSet) {
        throw new CliError("invalid_arguments", "duplicate --observe-attempts");
      }
      observeAttempts = parseBoundedInteger(
        requiredOptionValue(argv, index, "observation attempts"),
        1,
        64,
      );
      observeAttemptsSet = true;
      index += 1;
      continue;
    }
    if (argument === "--observe-delay-ms") {
      if (observeDelaySet) {
        throw new CliError("invalid_arguments", "duplicate --observe-delay-ms");
      }
      observeDelayMs = parseBoundedInteger(
        requiredOptionValue(argv, index, "observation delay"),
        0,
        60_000,
      );
      observeDelaySet = true;
      index += 1;
      continue;
    }
    throw new CliError("invalid_arguments", "unknown argument");
  }

  if (provider === undefined || storeDirectory === undefined || chains.length === 0) {
    throw new CliError("invalid_arguments", "provider, chain, and store are required");
  }
  chains.sort((left, right) => left.chainId - right.chainId);
  peerChains.sort((left, right) => left.chainId - right.chainId);
  signers.sort((left, right) => left.chainId - right.chainId);
  if (provider === "cetane" && (clientModule !== undefined || confirmations === undefined))
    throw new CliError(
      "invalid_arguments",
      "cetane requires confirmations and forbids OAAth configuration",
    );
  if (
    provider === "oaath" &&
    (clientModule === undefined || confirmations !== undefined || signers.length > 0)
  )
    throw new CliError(
      "invalid_arguments",
      "oaath requires its client module and forbids cetane signer/confirmation flags",
    );
  const base = { chains, peerChains, storeDirectory, observeAttempts, observeDelayMs, json };
  const common: ExecutionOptions =
    provider === "cetane"
      ? { ...base, provider, signers, confirmations: confirmations as number }
      : { ...base, provider, clientModule: clientModule as string };
  if (kind === "apply") {
    if (planPath === undefined) throw new CliError("invalid_arguments", "plan is required");
    return { kind, ...common, planPath, acceptedReview, packing };
  }
  if (runId === undefined) throw new CliError("invalid_arguments", "run is required");
  return { kind, ...common, runId, observeOnly };
}

function parsePacking(value: string): ExecutionPacking {
  if (value !== "per-step" && value !== "per-chain")
    throw new CliError("invalid_arguments", "packing must be per-step or per-chain");
  return value;
}

function requiredOptionValue(
  argv: readonly string[],
  optionIndex: number,
  label: string,
  allowStdin = false,
): string {
  const value = argv[optionIndex + 1];
  if (!value || (value.startsWith("-") && !(allowStdin && value === "-")) || value.includes("\0")) {
    throw new CliError("invalid_arguments", `${label} is invalid`);
  }
  return value;
}

function parseSignerBinding(value: string): SignerBinding {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new CliError("invalid_arguments", "signer binding is invalid");
  }
  const chainText = value.slice(0, separator);
  const environmentName = value.slice(separator + 1);
  if (!/^[1-9][0-9]*$/.test(chainText) || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(environmentName)) {
    throw new CliError("invalid_arguments", "signer binding is invalid");
  }
  const chainId = Number(chainText);
  if (!Number.isSafeInteger(chainId)) {
    throw new CliError("invalid_arguments", "signer binding is invalid");
  }
  return { chainId, environmentName };
}

function parseBoundedInteger(value: string, minimum: number, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new CliError("invalid_arguments", "numeric option is invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new CliError("invalid_arguments", "numeric option is invalid");
  }
  return parsed;
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
      const value = requiredOptionValue(argv, index, "run id");
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
  const resourcesById = new Map(
    plan.manifest.contracts.map((resource) => [resource.id, resource] as const),
  );
  const blocked = plan.cells.filter((cell) => {
    const resource = resourcesById.get(cell.resourceId);
    if (resource === undefined) throw new Error("reviewed plan cell has no manifest resource");
    return (
      (cell.status.kind === "module-drift" &&
        (cell.accountModules?.kind !== "drifted" ||
          !cell.accountModules.inventory.complete ||
          cell.accountModules.differences.some(
            ({ key, kind }) =>
              kind !== "unexpected" ||
              !plan.steps.some(
                (step) =>
                  step.chainId === cell.chainId &&
                  step.resourceId === cell.resourceId &&
                  step.id === `${cell.resourceId}:remove-module:${key}`,
              ),
          ))) ||
      cell.status.kind === "bytecode-drift" ||
      cell.status.kind === "unreadable" ||
      (cell.status.kind === "drift" &&
        (cell.status.callMismatches.length > 0 ||
          cell.status.storageMismatches.length > 0 ||
          cell.status.configurationMismatches.some(
            ({ id }) =>
              !plan.steps.some(
                (step) =>
                  step.chainId === cell.chainId &&
                  step.resourceId === cell.resourceId &&
                  step.kind === "configure" &&
                  step.configurationIds.includes(id),
              ),
          ))) ||
      (cell.status.kind === "missing" &&
        (resource.kind === "external" ||
          !plan.steps.some(
            (step) =>
              step.chainId === cell.chainId &&
              step.resourceId === cell.resourceId &&
              step.kind === "deploy",
          )))
    );
  }).length;
  const lines = [
    `Moesi plan ${plan.planId}`,
    planGuidance(plan.disposition),
    `disposition ${plan.disposition}`,
    `manifest ${plan.manifestHash}`,
    `chains ${plan.snapshots.length}`,
    `steps ${plan.steps.length}`,
    `blocked ${blocked}`,
  ];
  for (const cell of plan.cells) {
    const resource = resourcesById.get(cell.resourceId);
    if (resource === undefined) throw new Error("reviewed plan cell has no manifest resource");
    const deployment =
      resource.kind === "managed" && cell.status.kind === "missing"
        ? plan.steps.some(
            (step) =>
              step.chainId === cell.chainId &&
              step.resourceId === cell.resourceId &&
              step.kind === "deploy",
          )
          ? "scheduled"
          : "blocked"
        : "not-required";
    const prerequisites =
      resource.kind === "managed"
        ? ` deployment=${deployment} requires-runtime=${resource.deployment.requiresRuntime.join(",") || "none"} strategy=${resource.deployment.kind}`
        : "";
    lines.push(
      `${cell.chainId} ${cell.resourceId} ${cell.address} ${cell.status.kind} kind=${resource.kind}${prerequisites}${resource.kind === "external" ? (resource.accountModules?.removals?.length ? " mode=reviewed-module-removal" : " mode=verify-only execution-authority=none") : ""}`,
    );
    lines.push(...moduleEvidenceLines(`${cell.chainId} ${cell.resourceId}`, cell.accountModules));
    if (cell.status.kind === "unreadable" && cell.status.cause)
      lines.push(
        `observation ${cell.chainId} ${cell.resourceId}${formatObservationCause(cell.status.cause)}`,
      );
    for (const check of cell.storageChecks) {
      lines.push(
        `storage-check ${cell.chainId} ${cell.resourceId} ${check.id}${check.kind === "word" ? "" : ` kind=${check.kind}`} slot=${check.slot} expected=${check.expectedWord} remediation=none execution-authority=none`,
        formatPlanStorageEvidence(cell, check),
      );
    }
    for (const check of cell.checks) {
      lines.push(
        `call-check ${cell.chainId} ${cell.resourceId} ${check.id}${check.kind === "call" ? "" : ` kind=${check.kind} target=${check.target}`} simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult} remediation=none execution-authority=none`,
        formatPlanCallEvidence(cell, check),
      );
    }
    for (const configuration of cell.configuration) {
      lines.push(
        `configuration ${cell.chainId} ${cell.resourceId} ${configuration.id} simulation-caller=${configuration.caller} readData=${configuration.readData} expected=${configuration.expectedResult}${configuration.readiness ? ` readiness=${configuration.readiness}` : ""} remediation=write-action`,
        formatPlanConfigurationEvidence(cell, configuration),
      );
    }
  }
  for (const peer of plan.peers) {
    const detail =
      peer.status.kind === "unreadable"
        ? ` reason=${peer.status.reason}${formatObservationCause(peer.status.cause)}`
        : "observedRuntimeCodeHash" in peer.status
          ? ` observed=${peer.status.observedRuntimeCodeHash}`
          : "";
    lines.push(
      `peer ${peer.chainId} ${peer.address} status=${peer.status.kind} expected=${peer.expectedRuntimeCodeHash} snapshot=${peer.snapshot ? `${peer.snapshot.blockNumber}:${peer.snapshot.blockHash}` : "unavailable"}${detail}`,
    );
  }
  for (const capability of plan.capabilities) {
    const detail =
      capability.status.kind === "available" || capability.status.kind === "bytecode-drift"
        ? ` observed=${capability.status.observedRuntimeCodeHash}`
        : capability.status.kind === "unreadable"
          ? ` reason=${capability.status.reason}${formatObservationCause(capability.status.cause)}`
          : "";
    lines.push(
      `${capability.chainId} capability ${capability.kind} ${capability.status.kind} address=${capability.address} expected=${capability.expectedRuntimeCodeHash}${detail}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatPlanStorageEvidence(
  cell: ReviewedPlan["cells"][number],
  check: ReviewedPlan["cells"][number]["storageChecks"][number],
): string {
  const detail = `slot=${check.slot} expected=${check.expectedWord}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = storageCheckEvidence(cell, check.id);
  const label =
    evidence.kind === "drifted" ? "storage-check-mismatch" : "storage-check-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatPlanCallEvidence(
  cell: ReviewedPlan["cells"][number],
  check: ReviewedPlan["cells"][number]["checks"][number],
): string {
  const detail = `simulation-caller=${check.caller} readData=${check.readData} expected=${check.expectedResult}`;
  const boundary = "remediation=none execution-authority=none";
  const evidence = callCheckEvidence(cell, check.id);
  const label = evidence.kind === "drifted" ? "call-check-mismatch" : "call-check-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${check.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} ${boundary}`;
}

function formatPlanConfigurationEvidence(
  cell: ReviewedPlan["cells"][number],
  configuration: ReviewedPlan["cells"][number]["configuration"][number],
): string {
  const detail = `simulation-caller=${configuration.caller} readData=${configuration.readData} expected=${configuration.expectedResult}`;
  const evidence = configurationEvidence(cell, configuration.id);
  const label =
    evidence.kind === "drifted" ? "configuration-mismatch" : "configuration-observation";
  return `${label} ${cell.chainId} ${cell.resourceId} ${configuration.id} status=${evidence.kind} ${detail} observed=${evidence.observed}${formatEvidenceReason(evidence)} remediation=write-action`;
}

function formatEvidenceReason(
  evidence: ReturnType<
    typeof callCheckEvidence | typeof storageCheckEvidence | typeof configurationEvidence
  >,
): string {
  return evidence.kind === "unreadable" ? ` reason=${evidence.reason}` : "";
}

function renderJson(plan: ReviewedPlan): string {
  return renderPlanArtifact(plan);
}

function renderStatusHuman(record: DeploymentRunRecord): string {
  const lines = [
    `Moesi run ${record.runId}`,
    `plan ${record.plan.planId}`,
    `provider ${record.providerId}`,
    `revision ${record.revision}`,
    `execution ${executionState(record)}`,
    "convergence not-recorded",
    ...statusGuidance(record),
  ];
  for (const chain of record.executionReview.provider.chains) {
    lines.push(
      `reviewed-chain ${chain.chainId} sender=${chain.sender ?? "unavailable"} route=${chain.route}`,
    );
  }
  for (const step of record.operations) {
    const reference = "reference" in step ? step.reference.reference : "-";
    const reason = step.phase === "failed" ? ` ${step.reason}` : "";
    lines.push(
      `${step.chainId} ${step.operationId} ${step.phase} steps=${step.stepIds.join(",")} ${reference}${reason}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderStatusJson(record: DeploymentRunRecord): string {
  return `${JSON.stringify({
    version: "moesi.cli-status/v3",
    run: {
      runId: record.runId,
      planId: record.plan.planId,
      providerId: record.providerId,
      revision: record.revision,
      executionState: executionState(record),
      convergence: "not-recorded",
      packing: record.executionReview.packing,
      operations: record.operations.map((step) => ({
        operationId: step.operationId,
        stepIds: step.stepIds,
        chainId: step.chainId,
        phase: step.phase,
        reason: step.phase === "failed" ? step.reason : null,
        reference: "reference" in step ? step.reference : null,
        providerEvidence:
          "providerEvidence" in step && step.providerEvidence !== null
            ? {
                providerEvidenceId: step.providerEvidence.providerEvidenceId,
                submissionRoute: step.providerEvidence.submissionRoute,
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
  if (record.operations.some(({ phase }) => phase === "failed")) return "failed";
  if (record.operations.length === 0) return "no-actions";
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
  | MoesiFleetParityError["code"]
  | MoesiExecutionError["code"]
  | MoesiManifestError["code"]
  | MoesiPlanError["code"]
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
    if (error instanceof MoesiFleetParityError && PARITY_ERROR_CODES.has(code))
      return code as MoesiFleetParityError["code"];
    if (error instanceof CliError && CLI_ERROR_CODES.has(code)) return code as CliErrorCode;
    if (error instanceof MoesiExecutionError && EXECUTION_ERROR_CODES.has(code)) {
      return code as MoesiExecutionError["code"];
    }
    if (error instanceof MoesiManifestError && MANIFEST_ERROR_CODES.has(code)) {
      return code as MoesiManifestError["code"];
    }
    if (error instanceof MoesiPlanningError && PLANNING_ERROR_CODES.has(code)) {
      return code as MoesiPlanningError["code"];
    }
    if (error instanceof MoesiPlanError && PLAN_ERROR_CODES.has(code)) {
      return code as MoesiPlanError["code"];
    }
    if (error instanceof MoesiRunError && RUN_ERROR_CODES.has(code)) {
      return code as MoesiRunError["code"];
    }
  } catch {
    return "internal";
  }
  return "internal";
}

const PARITY_ERROR_CODES = new Set<string>([
  "unsupported_fleet_baseline_version",
  "invalid_fleet_baseline",
  "invalid_parity_request",
  "baseline_chain_missing",
]);
const CLI_ERROR_CODES = new Set<string>([
  "fleet_baseline_read_failed",
  "fleet_baseline_json_invalid",
  "fleet_baseline_too_large",
  "invalid_arguments",
  "manifest_read_failed",
  "plan_read_failed",
  "plan_json_invalid",
  "plan_artifact_invalid",
  "unsupported_plan_artifact_version",
  "plan_output_exists",
  "plan_write_failed",
  "signer_unavailable",
  "signer_invalid",
  "execution_review_mismatch",
  "oaath_adapter_unavailable",
  "oaath_client_invalid",
  "oaath_permission_failed",
  "oaath_permission_unavailable",
  "oaath_cleanup_failed",
  "internal",
]);
const EXECUTION_ERROR_CODES = new Set<string>([
  "provider_invalid",
  "provider_review_failed",
  "provider_review_invalid",
  "provider_review_blocked",
  "provider_mismatch",
  "plan_mismatch",
  "plan_snapshot_unverifiable",
  "execution_ancestry_unverifiable",
  "invalid_action",
  "provider_prepare_failed",
]);
const MANIFEST_ERROR_CODES = new Set<string>([
  "invalid_reference",
  "unknown_reference",
  "invalid_manifest_document",
  "manifest_source_too_large",
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
const PLAN_ERROR_CODES = new Set<string>([
  "invalid_record",
  "unknown_field",
  "unsupported_plan_version",
  "plan_identity_mismatch",
  "contradictory_plan",
  "invalid_manifest",
  "manifest_mismatch",
  "invalid_manifest_hash",
  "invalid_chain",
  "duplicate_chain",
  "invalid_snapshot",
  "invalid_capability",
  "invalid_peer",
  "duplicate_capability",
  "missing_capability",
  "unexpected_capability",
  "invalid_cell",
  "missing_cell",
  "duplicate_cell",
  "duplicate_step",
  "unpinned_chain",
  "orphan_step",
  "missing_step",
  "invalid_step",
  "invalid_call",
  "invalid_postcondition",
  "invalid_sender",
  "invalid_enforcement",
  "conflicting_senders",
  "invalid_requirements",
]);
const RUN_ERROR_CODES = new Set<string>([
  "run_store_required",
  "run_store_failed",
  "run_store_conflict",
  "run_not_found",
  "run_record_invalid",
  "unsupported_run_version",
  "run_plan_mismatch",
  "run_provider_mismatch",
]);
