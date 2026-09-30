---
"moesi": patch
---

Add `serializeManifest(manifest, { format: "json" | "yaml" })`, which validates
a manifest and writes canonical `moesi.manifest/v6` text that
`parseManifestText` round-trips to the same manifest hash and predicted
addresses. Add `deriveRuntimeCodeHash(runtimeCode)` and
`observeRuntimeIdentity({ observer, chainId, address, expectedRuntimeCodeHash? })`
to author `expectedRuntimeCodeHash` from compiler runtime bytes or pinned
observed code. No persisted schema changes.
