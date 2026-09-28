# SRA browser execution checkpoint

SRA commit `937935e6f9200923ba7b971bb5298a88d69c75b8` builds on the removal of its
0.9 settlement modules in `40c20aa`, using current public Moesi and OAAth APIs. The complete
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
occurs, and finalized recovery sends no new operation. The workspace-only proof
uses public fixture-owned chain ports and fake IndexedDB. The new
`bun run test:browser:execution` separately runs the production browser bundle
with its normal SDK HTTP transport, an EIP-1193 test wallet and native IndexedDB:

- Automatic signing selects the owner for the one-operation Counter plan.
- One explicit permission covers both session stages. Chrome is closed while
  the session Counter remains submitted with receipt reads withheld; a new
  Chrome process resumes and verifies convergence with no new submission.
- Registry reuses the persisted permission after reopening; it converges
  without another approval. Finalized Run recovery also sends nothing.
- A wallet change after acceptance clears it and disables execution. A wallet
  change while a signature is pending discards the eventual response before
  SDK submission. This test initially reproduced an actual stale-signature
  submission; the EIP-1193 transport now checks identity after the await too.
- The harness withholds another submission response after local inclusion and
  closes Chrome. The reopened app retains the submission fence, reports that
  the Run needs attention, offers no discard action and never resubmits it.

The combined proof used 892 local RPC requests and zero external app requests.
The three-stage workflow uses three atomic operations, one owner signature and
one session approval. The fault cases add one included operation and one
cancelled-prompt signature. The fleet-status backend is deliberately a separate
acceptance boundary: this harness serves an empty projection and refuses scans.
Temporary browser profiles and approval material are deleted, not retained.

The acceptance exposed an OAAth testing-fixture defect: its fixed 500,000
verification-gas estimate could not install the larger permission on an ordinary
EVM chain. Local trace evidence showed out-of-gas during account validation;
SRA correctly retained the unresolved submission. OAAth commit
`c45377f5ffa4bf76d861ca181b214fcceacc60d8` raises that fixture estimate to
1,000,000 and adds owner/session/reopen coverage on chain ID 8453. Ten local-mode
Anvil tests, typecheck, formatting and packed build pass. Production SDK gas
estimation is unchanged. OAAth commit `421b722` then exposes the existing fixture
RPC handler for the caller-owned loopback browser harness; all eleven local-mode
tests, typecheck and packed build pass. SRA consumes its exact testing tarball;
SDK artifacts remain at `ebb8205` and adapter at `12b9651`. Complete hashes are
recorded in SRA's `vendor/provenance.json`.

The browser status boundary is now implemented. It validates the existing
`sra.status/v2` wire shape into frozen values, including nested routes, fees,
cells, source-scoped peer evidence and structured observation causes. Polling
serializes reads with a ten-second deadline and four-MiB response cap. Invalid
responses preserve the last valid display; late responses cannot update a
closed view. Source refreshes are coalesced, require matching acknowledgements,
and are never retried automatically. Refresh rejection remains visible through
successful polls. Admin tokens are held only in page memory and cleared on
reload; editing them no longer changes the completed-Run refresh callback.

`bun run test:browser:status` proves the built app against the real Hono service
and saved 22-chain observations. Stale versions and malformed projections retain
the fleet display. Valid polling recovers, a four-second response produces only
one active status request, a rejected refresh causes one POST, and browser
reload removes both the current token and any obsolete persisted entry. The
proof records no external requests or browser exceptions. The owner/session,
wallet-change and process-recovery browser flow also passes again after this
change, with its 892 local RPC request count unchanged.

SRA validation passes:

- 56 offline tests with 2,089 assertions, including the observation service and
  malformed response, timeout, cancellation and concurrent refresh cases.
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

This is not completion of the overall goal. The artifact-refresh command still
needs its remaining migration work. The browser bundle retains a
size warning. Orchestra export, storage, concurrency and recovery remain required.
No live fleet transaction, publication or release was performed.
