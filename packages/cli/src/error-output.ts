import { MoesiManifestError } from "moesi";
import { CliError } from "./errors.js";

// Only fixed, reviewed copy crosses this boundary. Never render Error.message,
// arbitrary property names, paths, URLs, or upstream diagnostics.
const ARGUMENT_HELP = new Map<string, string>([
  ["unknown command", "Unknown command. Run moesi --help to see available commands."],
  ["unknown argument", "Unknown option. Run moesi <command> --help to see supported options."],
  [
    "manifest and chain are required",
    "Provide --manifest <path> and at least one --chain <chainId>=<rpcUrl>.",
  ],
  ["plan and chain are required", "Provide --plan <path> and the plan's exact --chain bindings."],
  ["plan is required", "Provide --plan <path> using the artifact saved by moesi plan."],
  ["run is required", "Provide --run <runId> using the ID printed by apply."],
  ["run and store are required", "Provide --run <runId> and the original --store <directory>."],
  [
    "provider, chain, and store are required",
    "Provide --provider <cetane|oaath>, --chain, and --store. See moesi apply --help or moesi resume --help for provider-specific options.",
  ],
  [
    "chain bindings must exactly match the reviewed plan",
    "Supply exactly one --chain binding for each chain in the saved plan, with no extra chains.",
  ],
  [
    "signer chain is not in the reviewed plan",
    "Remove signer bindings for chains outside the saved plan.",
  ],
  [
    "select cetane or oaath explicitly",
    "Select --provider cetane for direct transactions or --provider oaath for smart-account execution.",
  ],
  [
    "chain binding is invalid",
    "Use --chain <chainId>=<rpcUrl>, with a positive chain ID and an HTTP(S) URL.",
  ],
  ["chain id is invalid", "Use a positive integer chain ID in --chain <chainId>=<rpcUrl>."],
  ["RPC URL is invalid", "Use an HTTP(S) RPC URL without a username or password in the URL."],
  [
    "signer binding is invalid",
    "Use --signer <chainId>=<environmentVariable>. Supply the private key through that variable, never as an argument.",
  ],
  ["run id is invalid", "Use the full 0x-prefixed run ID printed by apply."],
  [
    "execution review id is invalid",
    "Use the full 0x-prefixed review ID from the first apply invocation.",
  ],
  [
    "numeric option is invalid",
    "Use whole numbers: --confirmations 1–64, --observe-attempts 1–64, and --observe-delay-ms 0–60000.",
  ],
]);

for (const option of [
  "json",
  "manifest",
  "out",
  "plan",
  "run",
  "provider",
  "confirmations",
  "store",
  "accept-review",
  "oaath-client",
  "packing",
  "baseline",
  "observe-attempts",
  "observe-delay-ms",
]) {
  ARGUMENT_HELP.set(`duplicate --${option}`, `Supply --${option} only once.`);
}
ARGUMENT_HELP.set("duplicate chain binding", "Supply each chain ID only once with --chain.");
ARGUMENT_HELP.set("duplicate signer binding", "Supply each chain ID only once with --signer.");
for (const [label, option] of [
  ["manifest path", "--manifest"],
  ["baseline path", "--baseline"],
  ["OAAth client module", "--oaath-client"],
  ["plan path", "--plan"],
  ["output path", "--out"],
  ["store directory", "--store"],
  ["run id", "--run"],
  ["provider", "--provider"],
  ["chain binding", "--chain"],
  ["signer binding", "--signer"],
  ["confirmation count", "--confirmations"],
  ["observation attempts", "--observe-attempts"],
  ["observation delay", "--observe-delay-ms"],
  ["execution review id", "--accept-review"],
]) {
  // Preserve the more specific format advice above when it exists.
  if (!ARGUMENT_HELP.has(`${label} is invalid`)) {
    ARGUMENT_HELP.set(
      `${label} is invalid`,
      `Provide a value after ${option}. Use ./ for paths that start with a hyphen.`,
    );
  }
}

const ERROR_HELP: Readonly<Record<string, string>> = {
  invalid_manifest_document:
    "The manifest must be one valid JSON or YAML document without duplicate fields or custom tags.",
  manifest_source_too_large:
    "The manifest exceeds the input limit. Reduce it or compile a smaller fleet selection before planning.",
  unsupported_plan_artifact_version:
    "The saved CLI plan version is unsupported. Create a fresh artifact with moesi plan --out <path>.",
  fleet_baseline_read_failed:
    "The fleet baseline could not be read. Check --baseline and its read permissions.",
  fleet_baseline_json_invalid:
    "The fleet baseline is not valid JSON. Recreate it from the resolved fleet declarations.",
  fleet_baseline_too_large:
    "The fleet baseline exceeds the input limit. Select a smaller fleet group.",
  oaath_adapter_unavailable:
    "Install @moesi/oaath and its exact compatible @oaath/sdk peer in the CLI application.",
  oaath_client_invalid:
    "The client module could not provide valid OAAth options. Export openOAAth() returning { oaath, account?, owner?, signer?, sender? }.",
  oaath_permission_failed:
    "OAAth could not request or reuse permission. Check the SDK account and authorization configuration, then review existing authority before retrying.",
  oaath_permission_unavailable:
    "Owner execution needs no session permission. Run apply to estimate and review the owner operation.",
  oaath_cleanup_failed:
    "OAAth could not close its runtime resources. Preserve the SDK stores and inspect saved execution before retrying.",
  invalid_arguments: "Check the command's options with moesi <command> --help.",
  manifest_read_failed:
    "The manifest could not be read. Check --manifest and the file's read permissions.",
  manifest_json_invalid: "The manifest is not valid JSON. Fix its JSON syntax and run plan again.",
  plan_read_failed:
    "The saved plan could not be read. Check --plan; create an artifact with moesi plan --out <path>.",
  plan_json_invalid: "The saved plan is not valid JSON. Recreate it with moesi plan --out <path>.",
  plan_artifact_invalid:
    "This file is not a current CLI plan artifact. Recreate it with moesi plan --out <path>.",
  plan_output_exists:
    "The output file already exists. Choose a new --out path to preserve the existing plan.",
  plan_write_failed:
    "The plan could not be saved. Check the --out parent directory and write permissions.",
  signer_unavailable:
    "A required signer is unavailable. Bind each action chain with --signer <chainId>=<environmentVariable> and set that variable in this process.",
  signer_invalid:
    "The signer variable does not contain a valid private key. Check it in your secret manager; do not paste the key into the command.",
  execution_review_mismatch:
    "The accepted review no longer matches. Repeat apply without --accept-review, inspect the new decision, then accept its review ID.",
  unsupported_manifest_version:
    "The manifest version is unsupported. Recreate it using the current moesi.manifest/v8 schema.",
  unsupported_plan_version:
    "The plan version is unsupported. Create and review a fresh plan with this version of Moesi.",
  invalid_manifest:
    "The manifest is invalid. Use the current schema with at least one contract and all required fields.",
  unknown_field:
    "The input contains an unsupported field. Check the current schema; recreate saved plans instead of editing them.",
  duplicate_resource:
    "Resources must have unique IDs and target addresses. Remove or correct the duplicate in the manifest.",
  invalid_resource:
    "A resource is invalid. Check its kind, ID, address, runtime hash, and required check arrays.",
  invalid_deployment:
    "A deployment is invalid. Check the strategy's fields, exact byte lengths, and requiresRuntime IDs; dependencies must not form a cycle.",
  invalid_sender:
    "A sender is invalid. Check the sender kind and address; sender-protected CreateX requires an explicit nonzero owner or smart-account address.",
  invalid_enforcement:
    "The enforcement requirements are invalid. Check their fields against the current manifest schema.",
  invalid_chains: "Provide at least one unique positive chain ID.",
  invalid_chain: "A chain ID is invalid. Check the chain bindings and recreate the plan if needed.",
  duplicate_chain: "A chain is listed more than once. Supply each chain ID once.",
  snapshot_unreadable:
    "A chain snapshot could not be read. Check RPC connectivity, the declared chain ID, and support for pinned block reads, then retry.",
  invalid_snapshot:
    "Snapshot evidence is invalid. Check the RPC's block responses and create a fresh plan.",
  provider_review_failed:
    "The provider could not complete its review. Check RPC connectivity and signer availability, then review again.",
  provider_review_blocked:
    "The provider cannot execute this plan. Resolve the review's block reasons before accepting a new review.",
  provider_review_invalid:
    "The provider returned an invalid review. Check the provider configuration before reviewing again.",
  provider_invalid: "The execution provider is invalid. Check the provider configuration.",
  provider_mismatch:
    "The provider differs from the reviewed decision. Review the selected provider again.",
  plan_mismatch: "The plan differs from the reviewed decision. Review the exact saved plan again.",
  plan_snapshot_unverifiable:
    "The planning snapshot could not be verified on the current chain. Check the RPC and recreate an old or reorganized plan before accepting a fresh review.",
  execution_ancestry_unverifiable:
    "The execution block lineage could not be verified. Inspect the saved run and retained transactions before deciding how to recover.",
  provider_prepare_failed:
    "The provider could not prepare execution. Check its RPC and signer configuration, then inspect status before retrying.",
  run_store_required:
    "Execution requires a run store. Provide --store <directory> and retain it for recovery.",
  invalid_resume_mode:
    "Select continue or observe-only for run recovery. Use --observe-only in the CLI to leave untouched work pending.",
  run_store_failed:
    "The run store could not be read or updated. Check its permissions and available space. Preserve its files; inspect status before any retry.",
  run_store_conflict:
    "This run already exists or another process updated it. Read status and use resume with the same store; do not delete the store to retry.",
  run_not_found:
    "No saved run was found. Check the run ID and original --store directory. A review-only apply does not create a run.",
  run_record_invalid:
    "The saved run is invalid or unsupported. Preserve it and investigate retained transactions before creating new work.",
  run_plan_mismatch:
    "The saved run does not match this plan. Use the run's original plan and store.",
  run_provider_mismatch:
    "The provider or confirmation count differs from the saved run. Resume with its original provider and --confirmations value.",
  internal:
    "Moesi could not complete the command. If execution may have started, inspect status with the original store before retrying.",
};

export function renderErrorHuman(code: string, error: unknown): string {
  let help = Object.hasOwn(ERROR_HELP, code)
    ? ERROR_HELP[code]!
    : "Moesi could not complete the command. Check the structured error code and run moesi <command> --help.";
  if (code === "invalid_arguments") {
    try {
      if (error instanceof CliError) {
        const message = Object.getOwnPropertyDescriptor(error, "message")?.value;
        if (typeof message === "string") help = ARGUMENT_HELP.get(message) ?? help;
      }
    } catch {
      /* Untrusted error objects cannot change the safe fallback. */
    }
  }
  return `${help}\n${manifestLocation(error)}MOESI_CLI_ERROR ${code}\n`;
}

function manifestLocation(error: unknown): string {
  try {
    if (!(error instanceof MoesiManifestError)) return "";
    const path = Object.getOwnPropertyDescriptor(error, "path")?.value;
    // Unknown keys can themselves contain secrets. Display only schema-owned
    // path segments, stopping before an unrecognized name.
    if (typeof path !== "string" || !path.startsWith("manifest.")) return "";
    const segments = path.split(".");
    const safe = ["manifest"];
    for (const segment of segments.slice(1)) {
      if (
        !/^(?:version|contracts|kind|id|address|deployment|requiresRuntime|salt|entropy|initCode|value|expectedRuntimeCodeHash|configuration|checks|storageChecks|caller|readData|writeData|expectedResult|slot|expectedWord|sender|accountId|enforcement|calls|expiry|operationCount)(?:\[[0-9]{1,6}\])?$/.test(
          segment,
        )
      )
        break;
      safe.push(segment);
    }
    return `Location: ${safe.join(".")}\n`;
  } catch {
    return "";
  }
}
