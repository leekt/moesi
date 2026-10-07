# Account module drift: dependency assessment

Follow-up to [Moesi #88](https://github.com/leekt/moesi/issues/88), inspected
7 October 2026. This issue remains open; no module-drift capability is claimed.

Moesi should own the exact expected module set, comparison, immutable reviewed
remediation calls and convergence evidence. The account-specific history decoder
and state reader belong upstream. The repository's current boundary gate rejects
ordinary account-abstraction implementation imports; adding a Kernel ABI and
transaction-history decoder inside Moesi would violate that boundary.

## Evidence available today

- The exact `vendor/cetane/cetane-0.0.2.tgz` used by Moesi has SHA-256
  `f0b99e13f1e84eedb6b55519b07a468b444d8793f9de8e0c14d7ae1adac8b860` and
  contains no `readModules` inventory capability. Its provenance is recorded
  beside the tarball.
- The adjacent Cetane working tree has `readKernelModules` in
  `src/accounts/kernelRead.ts`. It accepts the `4-beta` profile and a block
  number, returns state-confirmed and history-derived entries, and reports
  incomplete discovery for unknown contexts. It issues state reads by block
  number rather than EIP-1898 canonical hash. That working tree is not the
  vendored artifact and has not been modified or accepted by this follow-up.
- Issue #88 names Kernel v4 0.4.0 at `zerodevapp/kernel@c960b42`. The supported
  profile needs explicit verification against that implementation; the profile
  name alone does not establish equivalence.
- Contextless signer/policy events cannot prove a complete permission set.
  Matching module addresses to known permissions is insufficient to exclude a
  second unknown permission using the same addresses. Partial coverage must
  remain visible even if every declared entry matches.

## Required upstream boundary

An exact released package or reviewed local tarball must supply a read-only
inventory capability with these properties:

1. Bind chain ID, account, supported account profile, exact snapshot number and
   hash; all current-state confirmations use that canonical hash.
2. Accept a declared deployment/start block and bound log scanning, splitting,
   retry, cancellation and shared caller request-budget admission. Retain the
   scanned range and completeness without retaining raw transaction signatures,
   calldata, provider errors or credentials.
3. Discover candidates from history, then confirm current installation. Cover
   root replacement without uninstall events. Keep permission IDs and fallback
   selectors explicit and mark unresolved contexts as incomplete.
4. Return a bounded, data-only projection separating state-confirmed entries,
   history-derived counts and coverage. Confirm declared candidates even when
   they are absent from a partial event scan.

[Cetane #1](https://github.com/leekt/cetane/issues/1) and
[OAAth #384](https://github.com/leekt/oaath/issues/384) are the inventory owners.
Moesi's new `admitRpc` and safe/finalized policies cover its own observer reads;
they do not make an upstream inventory canonical or complete.

## Next focused Moesi change

Start with an `account-modules` manifest expectation codec: validators,
executors, selector-bound fallbacks, permission IDs with signer and ordered
policies, and context-bound hooks. Canonicalize unordered sets, reject duplicate
identities and conflicting contexts, and retain a supported profile and history
origin. Bump the manifest and affected reviewed/verification artifact versions
when adding their required fields or variants.

Consume the upstream read capability through a narrow observation boundary.
Validate and freeze its projection once. Extend boundary fixtures to allow only
the accepted read capability, preserving rejection of signing, installation,
operation encoding and submission modules. Do not expose raw inventory RPCs as
provider submission authority.

Comparison must report extra or changed state-confirmed authority as drift and
incomplete coverage as unreadable, never converged. Preserve the coverage and
history-derived counts separately in the result. Explicit uninstall calldata
must be part of the immutable reviewed plan and use the selected provider;
observation alone never authorizes an uninstall. Verify by reading fresh state.

Required proof: accepted exact set; extra executor, validator and permission;
wrong signer/policy/hook/selector; root replacement; partial logs and unknown
contexts; malformed, wrong-chain or wrong-hash evidence; shared-budget exhaustion;
changed expectations invalidating review; and local onchain uninstall followed by
fresh verification. Finish with a consumer of exact tarballs, not sibling source
imports. Until that proof exists, #88 should remain open.
