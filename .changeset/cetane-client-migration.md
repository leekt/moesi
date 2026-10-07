---
"moesi": minor
"@moesi/cli": minor
"@moesi/oaath": patch
---

Replace Moesi's runtime viem dependency with Cetane. The public provider and
observation entry point is now `moesi/cetane`, with `createCetaneObserver`,
`createCetaneObservationAdapter`, and `createCetaneExecutionProvider`. The CLI
requires `--provider cetane` for ordinary EOA execution. The old subpath and
provider names are removed.

Ordinary local wallets use Cetane's frozen EVM execution module, explicit
`nativeAA: false`, a plain address account and a separate signer. RPC-owned
wallets use `createRpcWalletClient`. Native-AA or custom execution modules are
rejected by the ordinary provider. Cetane's local EOA engine emits EIP-1559
transactions, so the CLI does not support legacy-only chains. RPC-owned wallets
select their transaction format. Provider reviews and transaction references
bind the new provider identity; old viem reviews cannot authorize Cetane sends.

Read pins, cancellation, bounded observation retries, finality checks and the
no-resend boundary are retained. `createHttpTransport` now returns a Cetane
transport object and takes `fetch` and `headers` options; it never retries.

The checkout pins an exact checksummed local Cetane 0.0.2 tarball, including the
required ABI, address, RPC-wallet and capability-read additions. Publishing
that upstream version is separate work. The pinned OAAth SDK still uses viem
internally; Moesi does not replace its credential or submission implementation.
