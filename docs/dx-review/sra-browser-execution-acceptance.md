# SRA browser execution checkpoint

SRA commit `aa493d2` builds on the removal of its
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
  Chrome process resumes after 1,024 additional blocks and verifies convergence
  with no new submission.
- Registry reuses the persisted permission after reopening; it converges
  without another approval. Finalized Run recovery also sends nothing.
- A wallet change after acceptance clears it and disables execution. A wallet
  change while a signature is pending discards the eventual response before
  SDK submission. This test initially reproduced an actual stale-signature
  submission; the EIP-1193 transport now checks identity after the await too.
- The harness withholds another submission response after local inclusion and
  closes Chrome. The reopened app retains the submission fence, reports that
  the Run needs attention, offers no discard action and never resubmits it.

The aged-receipt proof used 942 local RPC requests, 968 HTTP requests and zero
external app requests, within the unchanged 4,000-request HTTP fixture budget.
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
tests, typecheck and packed build pass. The current SDK/testing packages are at
`d1b7ab9`, core at `b971ae1` and adapter at `12b9651`. Both OAAth finality and
Moesi deployment ancestry now have bounded canonical block reads. The old Moesi
parent walk exhausted the browser fixture budget after 1,024 blocks; the same
browser flow now passes. SRA's version-2 browser evidence records receipt age
and exact vendor provenance alongside the recovery assertions.

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
change; the current aged-receipt result is recorded above.

SRA validation passes:

- 69 offline tests with 2,379 assertions, including the observation service,
  malformed response handling, cancellation, concurrent refreshes and atomic
  artifact publication.
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

The artifact-refresh workflow is now migrated. Creation artifacts and runtime
material live in one `sra.deployment-material/v2` bundle; old versions are
rejected and regenerated. The seven separate creation-artifact files and manual
literal-manifest importer were deleted. One shared module owns constructor
arguments and deployment recipes for both the app and generator.

Constructor capture explicitly selects historical replay or live pinned reads.
It records 22 block pins, checks 66 canonical prerequisite runtimes and captures
21 Across wrapped-native getter results, including valid zero values. Capture
requires a new destination, has four workers, a three-minute deadline and a
512-request HTTP budget. The local refresh step makes no external requests.

The generator consumes full Foundry artifacts through the packed public
`prepareSolidityArtifact` API. It deploys every managed cell through its actual
CREATE2 or sender-protected CreateX factory on isolated Anvil chains using the
catalog chain IDs. Factory child creation therefore occurs at the real parent
address. Constructor call traces check the modeled Across getter and reject
other external calls; compiler templates and immutable slots validate the
resulting runtime. All 144 cells reproduce the saved initcode/runtime hashes and
all seven fleet addresses, including Across at `0xafde…b077`.

Publication locks the entire refresh, syncs a complete temporary bundle,
compares the previous destination, then replaces it with one rename. Tests prove
exclusion of competing writers and retention after failed evaluation,
cancellation, outside edits and symlink outputs. A killed writer leaves the old
bundle plus an explicit lock; there is no automatic lock takeover. This proves
process-level atomic publication, not directory-fsync durability across power
loss. App startup validates and freezes the complete bundle. Definition hashes
exclude prerequisite observation pins but bind desired artifacts and runtimes.

`bun run test:artifacts` invokes the real CLI with seven complete compressed
Foundry fixtures. Two refreshes each deploy 144 cells on 22 local chains and
produce identical bytes. A stripped artifact and a reverting Across constructor
after prior local deployments both preserve the previous bundle. SRA records
fixture SHA-256 `7e1d1f3a2d7010a8a9de112016750e47b5e17fa98ad21fc0a27a617c8935eaa6`
and bundle SHA-256 `f79948102cadc742ed77a3f5167391200db8f94faaf409f7c07e845cf699cc5e`
in `docs/artifact-refresh-evidence.json`. Historical manifest compilation still
has 2,410 configuration rows and a 310,588-byte largest manifest. Strict script
checks, app/service typechecks, formatting and production build pass. The built
browser status acceptance also passes again with the new material and zero
external requests or browser exceptions.

SRA documents command arguments, explicit live mode, full Foundry input
requirements, supported constructor dependencies, failure codes and lock
recovery. The current local recipe models Across's public wrapped-native getter
as caller-independent and uses Cancun; new constructor dependencies or ambient
block-state reads require explicit input modeling. No fresh live-fleet claim is
made from historical constructor inputs or local EVM evidence.

This is not completion of the overall goal. The browser bundle retains a size
warning (1,485.10 kB minified / 380.47 kB gzip). Orchestra export, storage,
concurrency and recovery remain required. The full requested developer workflow
scope still needs completion. No live fleet transaction, publication or release
was performed.
