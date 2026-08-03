import { readFile } from "node:fs/promises";
import { createMoesi, MoesiManifestError, MoesiPlanningError, type ReviewedPlan } from "moesi";
import { CliError, type CliErrorCode } from "./errors.js";
import { type CliFetch, createRpcObservationAdapter, type RpcChainBinding } from "./rpc.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readFile: (path: string) => Promise<string>;
  readonly fetch: CliFetch;
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

type ParsedArguments = PlanArguments | HelpArguments;

const HELP = `Usage:
  moesi plan --manifest <path> --chain <chainId>=<rpcUrl> [--chain ...] [--json]

Commands:
  plan    Observe pinned state and produce a reviewed deployment plan.
`;

export async function runCli(
  argv: readonly string[],
  io: CliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readFile: (path) => readFile(path, "utf8"),
    fetch: globalThis.fetch,
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
  return `${JSON.stringify({ version: "moesi.cli-plan/v1", plan }, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  )}\n`;
}

function exitCodeFor(plan: ReviewedPlan): number {
  if (plan.disposition === "converged") return 0;
  if (plan.disposition === "changes") return 2;
  return 3;
}

function errorCode(
  error: unknown,
): CliErrorCode | MoesiManifestError["code"] | MoesiPlanningError["code"] {
  if (error instanceof CliError) return error.code;
  if (error instanceof MoesiManifestError || error instanceof MoesiPlanningError) return error.code;
  return "internal";
}
