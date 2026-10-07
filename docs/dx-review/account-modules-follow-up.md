# Account module drift

[Moesi #88](https://github.com/leekt/moesi/issues/88) is implemented through the
read-only `cetane/observation/modules` boundary in the published `cetane@0.0.3`
npm release. The lockfile pins its registry integrity.

## Manifest and observation

An existing managed or external contract can declare `accountModules`:

```ts
accountModules: {
  profile: "kernel-0.4.0",
  fromBlock: deploymentBlock.toString(),
  entries: [
    { kind: "root", id: rootValidationId },
    { kind: "validator", address: ownerValidator },
    { kind: "executor", address: approvedExecutor },
    { kind: "fallback", selector: "0x12345678", address: fallbackHandler },
    { kind: "permission", id: "0xaabbccdd", signer, policies: [policy] },
    { kind: "hook", context: hookContext, address: hook },
  ],
}
```

Use the account's deployment block as the inclusive history origin. A later
origin deliberately excludes earlier events and cannot establish the account's
full history. The runtime hash and profile must describe the reviewed account.
Entries are canonical sets by identity; permission policy order is significant.
Hook contexts are `0x01 + bytes21 validation ID`, `0x02 + executor address`, or
`0x03 + bytes4 selector`. Root IDs are `0x01 + validator address` or
`0x02 + permission ID + 16 zero bytes`.

`createCetaneObserver` supplies the reader. Custom observation adapters may supply
`readAccountModules`; absent support produces unreadable evidence. Cetane owns
history decoding, range splitting and account-specific state reads. Moesi checks
and freezes a bounded projection tied to the exact chain, account, height, hash,
profile and declared history origin. Every account state call uses EIP-1898 with
`requireCanonical: true`; opening and closing fences reject changed chains and
replaced headers. The reader probes declared candidates even without event hits.

Plan cells and fresh verification cells retain `accountModules`. Its inventory
separates state-confirmed `entries` from `history.counts`, and retains the scanned
range, continuation height and completeness. Extra, missing or changed confirmed
authority is drift. With no known differences, incomplete discovery is unreadable,
never converged. CLI planning, inspection, execution review and verification show
those distinctions. JSON contains the full structured projection.

Kernel 0.4.0's events omit permission IDs, selectors and hook contexts. Transaction
history can discover candidates but cannot prove exhaustive contextual authority,
including internal calls. Such history remains `unknown-context` even when known
entries match. Root replacement is checked from state, not event subtraction.
Event counts can therefore include modules that are no longer installed.

Compound reads have a 256-request ceiling and use the configured observer timeout.
The observer's caller-owned `admitRpc` also charges identity checks, retries and
split log requests. Exhaustion of that shared budget still stops the whole job.
No settled chain evidence is cached.

## Reviewed removal

A declaration may additionally include `accountId` and `removals`:

```ts
accountId: "treasury",
removals: [{ key: `executor:${unwantedExecutor}`, data: reviewedUninstallCalldata }],
```

These are explicitly supplied self-call bytes, not calldata inferred from a log.
Review the bytes using the account implementation's tooling. Moesi emits a
`remove-module` step only for a state-confirmed, unexpected identity with an exact
matching declaration. The plan binds target, bytes, zero value and logical account
sender. Root replacement, missing entries and changed entries are not automatic
repairs. The ordinary EOA provider refuses the smart-account sender requirement;
choose a provider that controls that account. Moesi does not supply a new signer,
account implementation or submission engine.

Partial history can permit an explicitly reviewed removal while the plan remains
partial. Transaction success alone cannot establish convergence: the existing Run
performs fresh module observation and retains incomplete evidence when applicable.
Changing desired terms or removal bytes changes plan identity and invalidates the
old provider review. Observation never sends a transaction.

## Evidence

- Focused codec/planning tests cover exact sets, extras, incomplete history,
  wrong account/hash/range, malformed evidence, forged reviewed status, missing
  evidence, altered calls and shared-budget exhaustion.
- Cetane's local released Kernel 0.4.0 test covers module categories, scoped hooks,
  root replacement without an uninstall event, historical hash pins and bounded
  log ranges. Node and Bun unit tests and packed consumers exercise the new leaf.
- `bun run test:packed-anvil` uses an exact Moesi tarball, the published Cetane
  release and upstream-owned contract fixtures, with no sibling source imports. It detects an extra
  executor, applies the exact reviewed uninstall, parses the durable Run, verifies
  fresh convergence, then detects an extra validator and permission. Its explicitly
  selected test provider uses Anvil impersonation; it proves Moesi's provider and
  convergence boundaries, not production signing or OAAth enforcement.

Manifest v7, reviewed plan v8, verification v5, run result v8, deployment run v10,
fleet observation v3 and CLI review/result v9/v10 reject prior artifacts. Recreate
manifests, plans and retained state; there are no compatibility readers.
