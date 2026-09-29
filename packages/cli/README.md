# @moesi/cli

`@moesi/cli` is the deployment-focused command line interface for Moesi.

Each command supports `--help`. The current source tree is a pre-release rebuild;
see the [repository quick start](https://github.com/leekt/moesi#start-from-this-checkout)
for building it locally.

```sh
# Save the artifact used by all later steps. Exit 2 means changes were found.
moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --out ./plan.json
moesi inspect --plan ./plan.json

# Supply MOESI_DEPLOYER_KEY through your secret manager first.
# This invocation only reviews the provider; it creates no run and sends nothing.
moesi apply --plan ./plan.json --provider viem --chain 8453=https://rpc.example \
  --signer 8453=MOESI_DEPLOYER_KEY --confirmations 2 --store ./.moesi/runs

# Inspect the review, then repeat that exact command with --accept-review <reviewId>.
# After execution, use the run ID printed by apply and the same store directory.
moesi status --run <runId> --store ./.moesi/runs
moesi resume --run <runId> --provider viem --chain 8453=https://rpc.example \
  --confirmations 2 --store ./.moesi/runs
moesi verify --plan ./plan.json --chain 8453=https://rpc.example
```

Repeat `--chain` for multiple chains. Replace angle-bracket placeholders with the
full printed IDs; they are not literal shell arguments. `plan --out` atomically
saves a private artifact and never replaces an existing file or symlink. Choose
a new path for each fresh plan. The parent directory must already exist. Add
`--json` for machine output; with `plan --out --json`, stdout equals the saved file.

| Command | Exit 0 | Exit 2 | Exit 3 |
| --- | --- | --- | --- |
| plan | Converged | Changes planned | Blocked or partial plan |
| inspect | Valid artifact, any disposition | — | — |
| apply | Converged | Provider review requires acceptance | Blocked or incomplete |
| resume | Converged | — | Incomplete; inspect recovery evidence |
| status | Saved run read, any execution state | — | — |
| verify | Converged | Drifted | Unreadable |

Invalid input or command failure exits 1. A safe stop exits 130 for SIGINT or 143
for SIGTERM. Planning and review intentionally return 2, so handle that code in
scripts instead of chaining the lifecycle with `&&` or unhandled `set -e`.
JSON errors retain `moesi.cli-error/v1` on stderr. Human errors explain recovery
and retain the structured code. RPC URLs and raw provider errors are not printed.
Interactive execution shows the run ID and safe-stop feedback on stderr;
`--json` output never contains progress prose.

Recovery depends on the saved step state:

- `submitted`: resume observes the retained reference without resending it.
- `pending`: reachable untouched work may be submitted; supply the original signers.
- `submission-requested`: submission is ambiguous. Preserve the store and reconcile
  the sender's transaction history. Resume cannot safely resend this step.
- `failed`: investigate retained references and current state before a fresh plan.
- `finalized` or `satisfied`: execution evidence alone is not fresh convergence.
  Run `verify`; `status` is deliberately offline.

`--confirmations` accepts 1–64 and must be the original value when resuming.
`--observe-attempts` accepts 1–64 (default 16), and `--observe-delay-ms` accepts
0–60000 (default 1000). Exhausting observation attempts leaves submitted work
recoverable; it does not mean the transaction reverted. Human status includes
the saved provider route, including the viem confirmation count.

`inspect` strictly reads and reparses one `moesi.cli-plan/v1` artifact, then
prints its complete normalized manifest, pinned snapshots, canonical factory
capabilities, runtime and configuration cells, ordered steps, exact calls,
postconditions, and provider-neutral execution requirements. It performs no
RPC or other network access and needs no execution provider, signer,
environment access, Run store, or signal handler. Every valid plan disposition
exits 0. JSON output is the canonical `moesi.cli-plan/v1` wrapper.

Runtime code is read with `eth_getCode`; managed configuration and read-only
call checks use `eth_call`, while storage checks use `eth_getStorageAt`. All use
the captured block hash with `requireCanonical: true`. A call check sends
exactly `{ from: caller, to: resourceAddress, data: readData }` plus that
EIP-1898 block selector. A storage check sends exactly three parameters: the
resource address, canonical 32-byte slot, and the EIP-1898 selector. Neither
supplies a signer or execution route.
Every RPC binding is first matched to its declared chain with `eth_chainId`.
Configuration drift is emitted as reviewed remediation calldata; unreadable
configuration evidence blocks planning.

Every manifest resource is explicitly `managed` or `external` and declares
exact read-only `checks` (id, simulation caller, calldata, expected result) and
`storageChecks` (id, 32-byte slot, expected word). Managed resources may also
own deployment and repairable configuration work. Attestation-only managed
drift is blocked; configuration-only drift is actionable; mixed drift is
partial and contains only the configuration calls. External resources remain
verify-only and contribute no factory capability, repair call, step, execution
requirement, sender, or enforcement authority.
Human plan, inspect, verify, and first-pass apply-review output preserve the
resource kind. Inspection uses generic `manifest-call-check`, `call-check`,
`manifest-storage-check`, and `storage-check` labels with explicit observation
and mismatch lines for either kind. First-pass apply JSON retains every exact
reviewed call and storage check, and human review prints its definition,
observed mismatch or unreadable reason, `remediation=none`, and
`execution-authority=none` before approval. Literal checks can express
owner/admin calls or proxy slots; the CLI does not claim inferred ownership,
proxy semantics, upgrades, or repair authority.

Every managed deployment must declare `requiresRuntime`; use
`requiresRuntime: []` when it has no prerequisite. Each ID gates deployment on
exact same-chain runtime identity only. Missing managed prerequisites are
scheduled before dependents, while missing, wrong-code, or runtime-unreadable
targets leave the dependent blocked. Later storage, call, or configuration
drift does not broaden this runtime-only edge. Human plan, inspect, and
first-pass apply review show the exact IDs and whether a missing deployment is
scheduled or blocked.

`verify` strictly reads a `moesi.cli-plan/v1` artifact and requires its chain
set to exactly match the supplied RPC bindings before making an RPC request. It
then captures fresh pinned snapshots and reports runtime, read-only call and
storage attestations, and configuration evidence directly from the
provider-neutral core verifier.
Verification needs
no execution provider, signer, environment access, Run store, or signal
handler. JSON output is the canonical `moesi.verification-result/v1` object.

The `create2-factory-v1` strategy uses the canonical Arachnid deterministic
deployment proxy. Human and JSON planning output retain the pinned factory
capability; unavailable or mismatched factory code blocks missing deployments
before signing.

The `createx-create2-v1` strategy uses the canonical CreateX factory with an
exact 11-byte entropy and a required `owner-eoa` sender. Human plan, inspect,
and first-pass apply output name the strategy; offline inspect also shows the
normalized entropy, and capability output distinguishes the CreateX factory
from the Arachnid proxy. The separate `createx-create2-unguarded-v1` and `createx-create3-unguarded-v1`
strategies accept the same 11-byte entropy without a sender-bound salt. CREATE3
addresses are independent of init code. Custom factories, arbitrary raw salts,
and other guard shapes are rejected.

`status` reads the canonical append-only DeploymentRun revisions without RPC,
provider, or signer access. It reports execution progress and retained provider
references; semantic convergence is explicitly `not-recorded` because that
requires fresh chain observation. A missing or malformed store fails closed and
read-only status does not create the directory.

`apply` requires the explicit `viem` provider. `--signer` names an environment
variable containing a private key; private keys are never accepted as command
arguments or printed. The first invocation only renders the exact provider
review and exits 2. It creates no Run and submits nothing. A second invocation
must pass that review's `--accept-review` digest, which binds the exact plan,
sender, route, enforcement, confirmation policy, and local store identity.

Viem references retain both the transaction hash and reviewed confirmation
count. `resume` can therefore observe submitted work in a fresh process without
a signer or second send. If untouched pending work remains reachable, signers
for the original reviewed requirements are required before it may continue.
There is no implicit provider or provider fallback.

The first SIGINT or SIGTERM requests a safe stop without deleting or
reclassifying durable progress. Handlers are removed after that request so a
second signal uses Node's default hard termination.
