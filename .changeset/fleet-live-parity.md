---
"moesi": minor
"@moesi/cli": minor
---

Add `parseFleetBaseline` and `checkFleetParity` to `moesi/fleet`, and the read-only
`moesi check-parity` command. Compare independent resolved fleet declarations
with compiled manifests and re-observe both at shared block pins, retaining
address, runtime, configuration, attestation, storage, peer-readiness and safe
failure evidence. Version baseline and report artifacts explicitly. Return
distinct match, difference and unreadable results; a parity match does not imply
deployment convergence. Document exporting an independent 0.9 application
baseline and checking each compiled fleet group without a signer or Run store.
