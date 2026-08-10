# @moesi/cli

`@moesi/cli` is the deployment-focused command line interface for Moesi.

```sh
moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --json
moesi inspect --plan ./plan.json --json
moesi verify --plan ./plan.json --chain 8453=https://rpc.example --json
moesi apply --plan ./plan.json --provider viem --chain 8453=https://rpc.example \
  --signer 8453=MOESI_DEPLOYER_KEY --confirmations 2 --store ./.moesi/runs --json
moesi resume --run 0x... --provider viem --chain 8453=https://rpc.example \
  --confirmations 2 --store ./.moesi/runs --json
moesi status --run 0x... --store ./.moesi/runs --json
```

Repeat `--chain` for multiple chains. Planning exits 0 for converged, 2 for
changes, and 3 for blocked or partial state. Verification exits 0 for converged,
2 for drifted, and 3 for unreadable. Invalid input exits 1. RPC URLs and raw
provider diagnostics are not printed.

`inspect` strictly reads and reparses one `moesi.cli-plan/v1` artifact, then
prints its complete normalized manifest, pinned snapshots, canonical factory
capabilities, runtime and configuration cells, ordered steps, exact calls,
postconditions, and provider-neutral execution requirements. It performs no
RPC or other network access and needs no execution provider, signer,
environment access, Run store, or signal handler. Every valid plan disposition
exits 0. JSON output is the canonical `moesi.cli-plan/v1` wrapper.

Runtime code is read with `eth_getCode`; managed configuration and external
call checks use `eth_call`, while external storage checks use
`eth_getStorageAt`. All use the captured block hash with
`requireCanonical: true`. An external check sends exactly
`{ from: caller, to: externalAddress, data: readData }` plus that EIP-1898 block
selector. A storage check sends exactly three parameters: external address,
canonical 32-byte slot, and the EIP-1898 selector. Neither supplies a signer or
execution route.
Every RPC binding is first matched to its declared chain with `eth_chainId`.
Configuration drift is emitted as reviewed remediation calldata; unreadable
configuration evidence blocks planning.

Every manifest resource is explicitly `managed` or `external`. Managed
resources may own deployment and configuration work. An external resource adds
exact read-only `checks` (id, simulation caller, calldata, and expected result)
and `storageChecks` (id, 32-byte slot, and expected 32-byte word) to its id,
address, and runtime hash. It is verify-only and contributes no
factory capability, repair call, step, execution requirement, sender, or
enforcement authority. Missing or drifted external code and mismatched or
unreadable checks are blocked, while independent managed work remains visible
in a partial plan.
Human plan, inspect, verify, and first-pass apply-review output preserve the
resource kind and label external resources `execution-authority=none`.
Inspection uses `manifest-external-check`, `external-check`,
`manifest-external-storage-check`, and `external-storage-check`, with explicit
observation/mismatch lines. First-pass apply JSON retains every exact reviewed
call and storage check, and human review prints its definition, observed
mismatch or unreadable reason, `remediation=none`, and
`execution-authority=none` before approval.

`verify` strictly reads a `moesi.cli-plan/v1` artifact and requires its chain
set to exactly match the supplied RPC bindings before making an RPC request. It
then captures fresh pinned snapshots and reports runtime, configuration, and
external storage evidence directly from the provider-neutral core verifier.
Verification needs
no execution provider, signer, environment access, Run store, or signal
handler. JSON output is the canonical `moesi.verification-result/v1` object.

The `create2-factory-v1` strategy uses the canonical Arachnid deterministic
deployment proxy. Human and JSON planning output retain the pinned factory
capability; unavailable or mismatched factory code blocks missing deployments
before signing.

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
