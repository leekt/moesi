# Orchestra receipt recovery checkpoint

OAAth commit `d1b7ab9` includes public `parseUserOperationReference` and
`createUserOperationObserver` for an application that owns its operation
journal. The immutable reference contains the chain, EntryPoint, account,
canonical decimal nonce and operation hash. The reader shares OAAth's receipt,
event, containing transaction, canonical block and finality pipeline without
constructing a Grant or Operation. It cannot sign, submit, find replacements or
decide a retry or lane release. An optional saved transaction hash allows
recovery without a bundler index. Application convergence remains separate.

The current Orchestra worktree uses the packed public API for wallet-activation
and revocation receipt recovery. It captures the saved identity before awaiting
RPC, verifies genesis before and after, bounds requests and time, and preserves
browser audience and cancellation fences. Basic auth and cookies are scoped to
their configured endpoints. Its full current-package cutover remains unfinished;
this checkpoint is not an application release or complete revocation proof.

The bounded-finality change passed 137 focused observer/receipt/runner tests
and three real local Anvil paths (v4 issuer, v3.3 issuer, v3.3 local session),
each recovering after 1,024 additional blocks. SDK/testing/server typecheck,
SDK/testing build, changed-file lint and SDK public-surface checks passed.
All four OAAth packages were packed at that exact commit.

Orchestra's `bun run test:wallet-recovery` passes 20 checks: nine backend,
including the parent test and a real Anvil test, plus eleven controller tests.
The Anvil proof uses an actual existing Kernel v3.3 account and one owner
UserOperation. It persists the public reference before submission, receives a
missing receipt, closes the submitting client, reloads the reference from disk
and finalizes through a fresh reader after 1,024 additional blocks, using
fewer than 24 SDK RPC requests. Recovery with the saved transaction skips
the bundler; a wrong nonce remains unreadable. Signature and submission counts
stay at one, with zero fallback submissions and zero external requests.

Owned HTTP tests cover credentials, changed genesis, caller mutation, mismatched
receipts, reverted outcomes, incomplete finality, abort and audience changes.
Backend and frontend lint and the shared reader's strict typecheck pass. Fresh
frozen Bun installation verifies artifact hashes and public imports under the
backend's Node runtime. The Anvil test is required by the focused command, and
its launcher scrubs provider variables and disables `.env` loading.

Remaining work includes the old grant/deployment APIs, full application checks,
PostgreSQL/browser recovery, registration/export controls and evaluation
persistence. Grant-scope preparation now uses the current recipe compiler and
passes eleven PostgreSQL request checks, including rejection of missing protected
sender identity before any request row is created. The backend still fails
typecheck in `operatorDeploymentRpc`, `operatorGrantPolicies` and
`operatorGrantRevocationCall`.
OAAth now uses a fixed canonical read set to establish RPC-attested finality;
it does not walk every intervening block. Million-block-gap unit cases and the
aged Anvil recovery cover that former budget failure. Moesi independently
checks deployment convergence. No live signing, submission or publishing occurred.
