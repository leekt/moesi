export const COMMANDS = [
  "plan",
  "check-parity",
  "inspect",
  "verify",
  "authorize",
  "apply",
  "resume",
  "status",
] as const;
export type CliCommand = (typeof COMMANDS)[number];

const USAGE: Record<CliCommand, string> = {
  plan: "moesi plan --manifest <path|-> --chain <chainId>=<rpcUrl> [--chain ...] [--peer-chain ...] [--out <path>] [--json]",
  "check-parity":
    "moesi check-parity --manifest <path|-> --baseline <path> --chain <chainId>=<rpcUrl> [--chain ...] [--peer-chain ...] [--json]",
  inspect: "moesi inspect --plan <path> [--json]",
  verify:
    "moesi verify --plan <path> --chain <chainId>=<rpcUrl> [--chain ...] [--peer-chain ...] [--json]",
  authorize:
    "moesi authorize --plan <path> --provider oaath --oaath-client <module.mjs> [--packing <per-step|per-chain>] [--json]",
  apply:
    "moesi apply --plan <path> --provider <viem|oaath> --chain <chainId>=<rpcUrl> [--chain ...]\n    [--peer-chain ...] --store <directory> [--packing <per-step|per-chain>]\n    [--accept-review <reviewId>] [--observe-attempts <count>] [--observe-delay-ms <ms>] [--json]\n  viem: --signer <chainId>=<privateKeyEnv> [--signer ...] --confirmations <count>\n  oaath: --oaath-client <module.mjs>",
  resume:
    "moesi resume --run <runId> --provider <viem|oaath> --chain <chainId>=<rpcUrl> [--chain ...]\n    [--peer-chain ...] --store <directory> [--observe-only] [--observe-attempts <count>] [--observe-delay-ms <ms>] [--json]\n  viem: [--signer <chainId>=<privateKeyEnv> ...] --confirmations <count>\n  oaath: --oaath-client <module.mjs>",
  status: "moesi status --run <runId> --store <directory> [--json]",
};

const DETAILS: Record<CliCommand, string> = {
  plan: `Observe pinned state and plan deployment and configuration changes. Sends nothing.
  --manifest accepts JSON or YAML; use - to read from stdin.
  --out saves the exact plan artifact for inspect, verify, and apply. It never overwrites a file.
  Without --out, use --json to capture the artifact on stdout.
  Repeat --chain for action chains; --peer-chain supplies required read-only peer chains.
  Exit 0: converged. Exit 2: changes. Exit 3: blocked, partial, or pending. Exit 1: error.`,
  "check-parity": `Compare current declarations with a resolved fleet baseline at shared pinned blocks.
  Declaration parity and live convergence are separate results. Sends nothing.
  --baseline is a current moesi.fleet-baseline artifact; --manifest accepts JSON, YAML, or stdin (-).
  Repeat --chain for action chains and --peer-chain for required read-only peers.
  Exit 0: declarations match. Exit 2: declarations differ. Exit 3: parity is unknown. Exit 1: error.
  Inspect the separate convergence result even when declarations match.`,
  inspect: `Read the saved plan offline, including exact calls, requirements, and evidence.
  No RPC, signer, or run store is needed. --json emits the canonical saved artifact.
  Exit 0: valid artifact, including blocked plans. Exit 1: error.`,
  verify: `Check the saved plan against fresh chain state. Sends nothing; no signer is needed.
  Supply exactly the plan's action chains and required read-only peers.
  Exit 0: converged. Exit 2: drifted. Exit 3: unreadable. Exit 1: error.`,
  authorize: `Explicitly request or reuse a session permission for the exact saved plan.
  --oaath-client runs your module's openOAAth() factory returning { oaath, ...providerOptions }.
  Use the same --packing for authorize and apply. No deployment calls are submitted.
  Owner-only clients need no session permission; use apply to review owner execution.
  Exit 0: requested or reused. Exit 1: unavailable or invalid permission request.`,
  apply: `First run: review only. No run is created and no deployment operation is submitted.
  Read the calls, sender, signer, enforcement, fallback, and blockers, then repeat
  the command with --accept-review <reviewId> to execute that exact decision.
  viem: --signer names an environment variable, never a private key. --confirmations is required (1–64).
  oaath: --oaath-client opens the configured SDK, account, and wallet; do not supply viem signer flags.
  --packing defaults to per-chain for OAAth and per-step for viem. Atomic batches keep one reference.
  --observe-attempts: 1–64 (default 16). --observe-delay-ms: 0–60000 (default 1000).
  A partial plan executes its scheduled calls; unresolved blockers remain.
  Exit 0: converged. Exit 2: review required. Exit 3: blocked or incomplete. Exit 1: error.`,
  resume: `Recover a saved run using its original provider, chains, and store.
  Retained operations are observed without resubmitting or requiring their original signer.
  Reachable pending work requires the reviewed authority and may submit new operations.
  --observe-only preserves untouched work and never reviews, prepares, or submits operations.
  A possible submission with no retained reference stays ambiguous; resume cannot resend it.
  viem: --confirmations (1–64) must match the original review; supply signers only for pending work.
  oaath: reopen the same SDK account and durable stores through --oaath-client.
  Packing is retained from the run; resume does not accept --packing.
  --observe-attempts: 1–64 (default 16). --observe-delay-ms: 0–60000 (default 1000).
  Exit 0: converged. Exit 3: incomplete. Exit 1: error.`,
  status: `Read saved execution progress offline. No RPC or signer is needed.
  Use the run ID printed by apply and the same --store directory.
  Status does not verify current chain state; use verify for fresh convergence evidence.
  Exit 0: readable run, including failed or pending runs. Exit 1: error.`,
};

export function renderHelp(command: CliCommand | null): string {
  if (command !== null) return `Usage:\n  ${USAGE[command]}\n\n${DETAILS[command]}\n`;
  return `Moesi — plan, review, execute, and verify onchain changes.

Usage:
  moesi <command> --help

Commands:
  moesi plan          Observe pinned state and save a deployment plan.
  moesi check-parity  Compare fleet declarations and live state at shared pins.
  moesi inspect       Read the exact plan offline, including calls and blockers.
  moesi verify        Check fresh chain state without a signer.
  moesi authorize     Request or reuse an OAAth session permission.
  moesi apply         Review first; execute after explicit acceptance.
  moesi resume        Recover saved operations without resending them.
  moesi status        Read saved execution progress offline.

Start:
  moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --out ./plan.json
  moesi inspect --plan ./plan.json

Planning exits 2 when it finds changes; that is a reviewable result.
Use --json for machine output. Errors go to stderr; exit 1 indicates invalid input or failure.
Apply and resume stop safely on the first Ctrl+C; a second interrupt terminates immediately.
`;
}
