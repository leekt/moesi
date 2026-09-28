# SRA browser execution checkpoint

SRA commit `40c20aa41c34e73619e36e510c3a52b7d91ea871` replaces its removed
0.9 settlement modules with the current public Moesi and OAAth APIs. The complete
frontend now typechecks and builds. Deploy-page and drawer actions prepare fresh
scoped plans; Counter Lab and saved Run recovery share the same workspace.

The workspace requires acceptance of the exact immutable provider reviews it
displayed. Wallet changes, changed packing/signing selections and new reviews
invalidate acceptance. Permission approval is explicit and separate from
execution. IndexedDB fences precede submission, competing tabs retain account
and chain scope locks, and ambiguous recovery does not resend. Finalized
operation evidence is followed by a separate convergence check.

Counter Lab now uses an existing Kernel v3.3 account and current typed manifests.
One owner operation is followed by a single permission covering the second
Counter and Registry stages. A reopened SDK/workspace reuses that grant for
Registry; each session operation batches deployment and configuration. Actual
local-chain evidence proves all three stages converge, only one session approval
occurs, and finalized recovery sends no new operation. The run used 492 SDK RPC
requests and zero external requests. This composition uses public fixture-owned
chain ports and fake IndexedDB, not a real Chrome wallet.

The acceptance exposed an OAAth testing-fixture defect: its fixed 500,000
verification-gas estimate could not install the larger permission on an ordinary
EVM chain. Local trace evidence showed out-of-gas during account validation;
SRA correctly retained the unresolved submission. OAAth commit
`c45377f5ffa4bf76d861ca181b214fcceacc60d8` raises that fixture estimate to
1,000,000 and adds owner/session/reopen coverage on chain ID 8453. Ten local-mode
Anvil tests, typecheck, formatting and packed build pass. Production SDK gas
estimation is unchanged. SRA consumes only the exact new testing tarball; its
SDK artifacts remain at `ebb8205` and adapter at `12b9651`.

SRA validation passes:

- 46 offline tests with 2,027 assertions, including the observation service.
- Complete frontend/service typecheck, strict checks of the new scripts and
  fixtures, production build, and six exact dependency checksums.
- Historical manifest compilation and saved-address parity across 22 chains:
  144 managed cells, 22 external prerequisite cells and 2,410 configuration rows.
- Real local Counter workflow with the public SDK/provider and durable host.
- Chrome 153 desktop/mobile production-bundle checks using saved RPC responses:
  one detected fee drift, execution disabled without acceptance, missing routes
  blocking review, native dialog keyboard dismissal, saved Runs, no browser
  exceptions and no external requests. Two bounded visual passes corrected
  overflow and error readability. The prior native IndexedDB process-reopening
  evidence remains separately recorded.

SRA retains commands, JSON results and screenshots under `docs/` and documents
its current endpoint configuration and recovery flow. Obsolete 0.9 diagnostics
and compatibility tests were removed; current manifest/live-observation commands
replace their developer-facing purpose.

This is not completion of the overall goal. Combined Chrome wallet/SDK approval,
execution, wallet-change races and recovery controls still need application-level
local-chain acceptance. The browser status-response boundary and artifact-refresh
command still need their remaining migration work. The browser bundle retains a
size warning. Orchestra export, storage, concurrency and recovery remain required.
No live fleet transaction, publication or release was performed.
