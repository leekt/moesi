---
"moesi": patch
"@moesi/cli": patch
---

Add Multicall3 batching for EOA deployments. `encodeMulticall3Aggregate(calls)`
packs value-free reviewed calls into one `aggregate` call, next to
`MULTICALL3_ADDRESS` and `MULTICALL3_RUNTIME_CODE_HASH`. The viem provider now
supports explicit `packing: "per-chain"` (and `moesi apply --provider viem
--packing per-chain`) by sending each chain's steps as one Multicall3
transaction. Review allows it only for sender-independent, value-free chains
with the canonical Multicall3 runtime, submission re-attests that runtime
before signing, and evidence decodes the exact inner calls. Providers can
declare `defaultPacking`, and the viem provider keeps `per-step` as its default.
