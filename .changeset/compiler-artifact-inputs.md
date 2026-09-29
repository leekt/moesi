---
"moesi": minor
---

Add `prepareSolidityArtifact` for full Foundry, solc contract-output and Hardhat 3
artifacts. It captures compiler inputs, links creation/runtime library slots,
encodes exact constructor arguments and produces literal manifest bytes with
compiler/init-code provenance. Static runtime hashes come from the compiler;
immutables and library self addresses require explicitly supplied, init-code-bound
runtime evidence. Unknown formats, missing runtime metadata, malformed references,
bad arguments and mismatched runtime bytes fail with structured field diagnostics.

The helper validates supplied runtime evidence; it does not execute constructors
or claim to authenticate the compiler or deployment context. Incomplete old
application artifact exports must be regenerated from full compiler output.
