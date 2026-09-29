export const COMMANDS = ["plan", "inspect", "verify", "apply", "resume", "status"] as const;
export type CliCommand = (typeof COMMANDS)[number];

const USAGE: Record<CliCommand, string> = {
  plan: "moesi plan --manifest <path> --chain <chainId>=<rpcUrl> [--chain ...] [--out <path>] [--json]",
  inspect: "moesi inspect --plan <path> [--json]",
  verify: "moesi verify --plan <path> --chain <chainId>=<rpcUrl> [--chain ...] [--json]",
  apply:
    "moesi apply --plan <path> --provider viem --chain <chainId>=<rpcUrl> [--chain ...]\n    [--signer <chainId>=<privateKeyEnv> ...] --confirmations <count> --store <directory>\n    [--accept-review <reviewId>] [--observe-attempts <count>] [--observe-delay-ms <ms>] [--json]",
  resume:
    "moesi resume --run <runId> --provider viem --chain <chainId>=<rpcUrl> [--chain ...]\n    [--signer <chainId>=<privateKeyEnv> ...] --confirmations <count> --store <directory>\n    [--observe-attempts <count>] [--observe-delay-ms <ms>] [--json]",
  status: "moesi status --run <runId> --store <directory> [--json]",
};

const DETAILS: Record<CliCommand, string> = {
  plan: `Observe chain state and plan deployment and configuration changes. Sends nothing.
  --out saves the exact plan artifact for inspect, verify, and apply. It never overwrites a file.
  Without --out, use --json to capture the artifact on stdout.
  Repeat --chain for each chain; URLs must use HTTP(S).
  Exit 0: converged. Exit 2: changes. Exit 3: blocked or partial. Exit 1: error.`,
  inspect: `Read the saved plan offline, including exact calls, requirements, and evidence.
  No RPC, signer, or run store is needed. --json emits the canonical saved artifact.
  Exit 0: valid artifact, including blocked plans. Exit 1: error.`,
  verify: `Check the saved plan against fresh chain state. Sends nothing; no signer is needed.
  Supply exactly the chains in the saved plan.
  Exit 0: converged. Exit 2: drifted. Exit 3: unreadable. Exit 1: error.`,
  apply: `First run: review only. No run is created and no transaction is submitted.
  Read the calls, sender, enforcement, and blockers, then repeat the same command
  with --accept-review <reviewId> to execute that exact decision.
  --signer names an environment variable, never a private key. Required for each action chain.
  --confirmations: 1–64, required. Bound into the review and retained for resume.
  --observe-attempts: 1–64 (default 16). --observe-delay-ms: 0–60000 (default 1000).
  A partial plan executes only its scheduled calls; unresolved blockers remain.
  Exit 0: converged. Exit 2: review required. Exit 3: blocked or incomplete. Exit 1: error.`,
  resume: `Recover a saved run using its original provider, chains, store, and confirmation count.
  Submitted transactions are observed without resubmitting or requiring a signer.
  Reachable pending work requires the original reviewed signers and may submit new transactions.
  A possible submission with no retained reference stays ambiguous; resume cannot resend it.
  --confirmations: 1–64, required. Must match the original review.
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
  moesi plan     Observe pinned state and save a deployment plan.
  moesi inspect  Read the exact plan offline, including calls and blockers.
  moesi verify   Check fresh chain state without a signer.
  moesi apply    Review first; execute only after explicit acceptance.
  moesi resume   Recover a saved run without resending submitted transactions.
  moesi status   Read saved execution progress offline.

Start:
  moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --out ./plan.json
  moesi inspect --plan ./plan.json

Planning exits 2 when it finds changes; that is a reviewable result, not an error.
Use --json for machine output. Errors go to stderr; exit 1 indicates invalid input or failure.
Apply and resume stop safely on the first Ctrl+C; a second interrupt terminates immediately.
`;
}
