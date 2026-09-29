---
"moesi": patch
---

Fix probe evidence and preserve unknown results. Opcode probes use bounded,
isolated state overrides without a deployed factory; transport failures no
longer imply an unsupported opcode. Code checks exclude their temporary helper
and omit unreadable fallback results. Feature probes validate exact response
shapes, precompile output, and structured RPC method errors. PREVRANDAO and
EIP-7702 remain inconclusive when simulation cannot establish activation.

Breaking before 1.0: probe input bounds, exact records, unique IDs, immutable
results, and the supported/unknown outcome union are enforced at the boundary.
Nick's-method helpers require chain-neutral legacy signatures, valid curve
scalars, and positive gas; signature quantities use canonical RLP encoding and
failed recovery never exposes serialized transaction data.
