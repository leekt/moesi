---
"moesi": patch
---

Support chain-bound (EIP-155) Nick's-method signatures through an explicit
`chainId` parameter, which requires `v` of `2 * chainId + 35` or `+ 36`.
Chain-bound signatures without `chainId` now fail with the typed
`chain_bound_nicks_signature` code, and mismatched bindings with
`nicks_chain_mismatch`. `nicksSignatureChainId(v)` classifies stored
signatures for migration, and `validateNicksAddress` results include the bound
`chainId` (`null` when chain-neutral).
