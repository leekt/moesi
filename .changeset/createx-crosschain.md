---
"moesi": patch
"@moesi/cli": patch
---

Add the crosschain-protected `createx-create2-crosschain-v1` and
`createx-create3-crosschain-v1` strategies and the sender-and-crosschain
`createx-create2-sender-crosschain-v1` and `createx-create3-sender-crosschain-v1`
strategies. Each declares one exact `chainId`, because CreateX mixes
`block.chainid` into the guarded salt. Planning on any other chain fails with
the new `chain_bound_resource` planning code, reviewed plans and fleet parity
reject foreign-chain cells, and `moesi inspect` prints the bound `chainId`.
Addresses are proven against the pinned CreateX runtime on local Anvil. The
manifest version is unchanged because existing manifests still parse.
