# Moesi user-flow review

> Historical record from 2026-09-28. Repository, package, schema, tooling, and
> application-status statements below describe the recorded checkpoints. See the
> [current README](../README.md) and later acceptance records for current behavior.

Review started 2026-09-28 against this checkout. The user explicitly excluded
iOS after confirming scope. The tracked product contains the `moesi` library
and `@moesi/cli`; it has no web or native app to render. Impeccable's Operate,
clarify, and harden guidance applies to the command lifecycle, feedback, and
recovery. Web contrast, touch-target, and layout scores are not applicable.

## Primary outcome: understandable, recoverable CLI execution

| Flow | Findings and changes | Evidence |
| --- | --- | --- |
| Discover commands | Per-command help was rejected. Every command now accepts `--help` without file, RPC, signer, or store access. Polling bounds and exit codes are documented. | `packages/cli/test/command.test.ts` |
| Create a manifest | No complete starter existed. Added a minimal, explicit manifest and source-checkout instructions. Safe errors show schema-owned field locations. | `examples/minimal.manifest.json`; `scripts/test-cli-anvil.mjs`; `error-output.test.ts` |
| Plan and save | Quick starts produced stdout but later expected a saved file. Added `--out` with atomic publication, private permissions, and no overwrite, including symlinks and concurrent writers. Missing option values fail before I/O. | `command.test.ts`; `plan-file.test.ts`; packed CLI smoke |
| Inspect | Exact evidence remains available offline. The output now labels saved evidence and explains the plan disposition. | `inspect.test.ts`; packed CLI smoke |
| Provider review | Added plain-language explanations of partial plans, unsupported enforcement, and the second invocation. Review digest still binds the exact calls, provider, sender, confirmation count, and store identity. | `apply-resume.test.ts`; packed CLI smoke |
| Apply | Completed runs incorrectly reused “execution not-started” from the review screen. Results now lead with run state and fresh verification, include resource evidence, and omit approval prompts. | `apply-resume.test.ts`; local Anvil CLI lifecycle |
| Interrupt | Interactive execution now shows the run ID and acknowledges safe-stop requests. JSON stays free of progress prose. | `apply-resume.test.ts` |
| Status | Offline status now distinguishes pending, submitted, ambiguous, and failed work, shows the retained provider route, and points to fresh verification. | `status.test.ts`; packed CLI smoke |
| Resume | Guidance separates observation without resending from reachable pending work that requires signers. Ambiguous submission explicitly does not authorize retry. | `apply-resume.test.ts`; `run-resume.test.ts`; local Anvil process-recreated resume |
| Verify | Converged, drifted, and unreadable results explain the next step without treating provider finality as convergence. | `verify.test.ts`; local Anvil convergence and induced-drift checks |
| Script/JSON use | Canonical artifact schemas and exit codes are unchanged. Docs explain that exit 2 is expected for changes/review. Packed tests exercise saved-artifact equality and refusal to overwrite. | `command.test.ts`; `scripts/smoke-packed-cli.mjs` |
| Invalid/unavailable inputs | Errors retain stable codes but now provide safe recovery text; arbitrary error messages, paths, unknown keys, URLs, and getters are excluded. | `error-output.test.ts`; existing secret-scrubbing tests |

The checked-in example is exercised through plan, save, explicit review,
human apply output, fresh convergence, and a zero-action replan on local Anvil.
No tests use shared or paid RPCs.

## Library flow coverage

Core evidence below is in `packages/moesi/test`; CLI store evidence is in
`packages/cli/test`. The public entry points are `moesi` and `moesi/viem`.

| Flow | Reviewed behavior and outcome | Evidence |
| --- | --- | --- |
| Parse and normalize a manifest | One current version, immutable canonical identity, exact resource kinds, dense arrays, duplicate target rejection, safe invalid-input outcomes. | `manifest.test.ts` |
| Deploy through the canonical CREATE2 proxy | Salt, value, init code, target, factory identity, and reviewed calldata agree. Changed factory code stops execution before submission. | `planner.test.ts`; `anvil-convergence.test.ts` |
| Use sender-protected CreateX CREATE2 | Exact entropy and owner EOA bind salt, address, requirements, and sender. No alternate factory or raw-salt escape. | `createx-create2-planning.test.ts`; local Anvil and packed Anvil lifecycle |
| Use unguarded CreateX CREATE2 or CREATE3 | Zero-prefixed salt and both address derivations round-trip; CREATE3 target is independent of init code. | `createx-unguarded-planning.test.ts`; `anvil-convergence.test.ts` |
| Declare runtime prerequisites | Unknown IDs, self-reference, duplicate edges, and cycles reject before observation. Missing closure orders deterministically; fresh runtime checks gate dependent submissions. | `manifest.test.ts`; `runtime-prerequisites-planning.test.ts`; `run.test.ts`; local Anvil |
| Read external or managed attestations | Runtime, storage words, exact call results, and simulation callers stay pinned and read-only. Attestation drift does not fabricate a repair transaction. | `planner.test.ts`; `verification.test.ts`; local Anvil and packed consumer |
| Repair configuration | Configuration-only drift is actionable. Mixed read-only drift remains partial. Deployment precedes configuration, and already-satisfied writes are skipped using fresh evidence. | `planner.test.ts`; `run.test.ts`; `anvil-convergence.test.ts` |
| Observe multiple chains | Each chain has its own snapshot, capabilities, steps, and status; one chain cannot borrow another's evidence. Invalid chain lists reject before RPC. | `planner.test.ts`; `run.test.ts`; `verification.test.ts` |
| Reload a reviewed plan | Recomputes identity, exact calls, postconditions, requirements, and disposition; rejects old versions, tampering, missing cells, and contradictory steps. | `reviewed-plan.test.ts`; packed library smoke |
| Supply an observation adapter | Code/call/storage response validation preserves unreadable evidence. The viem adapter pins canonical block hashes and exact callers; ancestry checks follow block hashes. | `observation.test.ts`; `viem-provider.test.ts`; local Anvil |
| Select a custom execution provider | Review binds the exact provider instance and plan; prepare is side-effect-free; submit acts once per reviewed action; observe does not submit. Changed review decisions and malformed references fail safely. | `provider-contract.test.ts`; `run.test.ts` |
| Execute with viem | Exact EOA and RPC identity, confirmations, reviewed call, canonical receipt, and sender are checked. Required smart-account or onchain enforcement blocks before signing. | `viem-provider.test.ts`; packed Anvil lifecycle |
| Persist and resume a run | Atomic create/CAS, a durable possible-submission fence, retained references, concurrent recovery, process recreation, safe stop, and reorg handling preserve at-most-once submission. Ambiguous work never receives retry authority. | `run-resume.test.ts`; CLI `run-store.test.ts`; local CLI process recreation |
| Verify deployment convergence | Provider finality and deployment verification remain separate. Fresh runtime/storage/call/configuration results distinguish drift, unreadability, and convergence. Standalone verification does not require old-plan ancestry traversal. | `verification.test.ts`; `run.test.ts`; local Anvil induced drift |
| Batch code presence | Fixed helper self-evidence, invalid options, malformed fallback values, mutable inputs, and noncanonical ABI responses. Missing fallback entries explicitly mean unreadable in both runtime and types. | `probe-boundaries.test.ts`; `probes.test.ts`; local Anvil; packed utility smoke |
| Probe opcodes and features | Fixed raw-error leaks, diagnostic-text classification, factory dependency, duplicate IDs, incomplete response validation, mutable catalogs, and balance-dependent MCOPY operands. RPC failure is not unsupported evidence. | `probe-boundaries.test.ts`; `probes.test.ts`; current/Paris Anvil; packed utility smoke |
| Build and validate Nick's-method transactions | Fixed chain-specific `v`, invalid/null/unknown inputs, invalid curve scalars, nonminimal RLP signature quantities, and raw recovery errors. | `nicks.test.ts`; `anvil-probes.test.ts`; packed utility smoke |

The EIP-7702 probe deliberately returns `supported: null, error: "inconclusive"`.
The local Paris-fork experiment demonstrated that a simulator can execute
overridden delegation code before authorization-transaction activation. The
catalog now states this limitation instead of presenting the result as support.
PREVRANDAO similarly leaves low sample values inconclusive. Code-presence
utilities do not replace reviewed factory runtime-hash attestation.

## Verification

- `pnpm check`: lint, build, typecheck, **297 core tests and 107 CLI tests passed**.
- `pnpm test:anvil`: current/older-fork probe checks and full core convergence
  tests passed, followed by the process-recreated CLI lifecycle, checked-in
  example, and packed-consumer onchain lifecycle.
- `pnpm smoke:packed`: both library and CLI passed in clean consumers. Public
  utility checks cover the new block pin, tri-state result handling, immutable
  catalogs, scrubbed errors, and Nick's-method validation.
- A focused local-chain test also checks that minimally encoded Nick's-method
  quantities produce an accepted transaction and the predicted runtime address.
- On this machine temporary consumers live on another volume. Set
  `PNPM_CONFIG_STORE_DIR=/Volumes/Workspace/.pnpm-store` for the packed commands
  to select the workspace cache; dependency installation remains offline.

All current shipped CLI and library flow groups above have been reviewed.
The identified findings are resolved; iOS remains excluded as requested.
Custom providers and stores still have to honor their documented contracts;
these tests validate Moesi's boundaries and the included implementations, not
arbitrary third-party adapters.
