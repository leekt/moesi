---
"@moesi/oaath": minor
---

With an owner wallet and `signer: "auto"`, review the session estimate for
multi-operation chains and select owner execution only after the SDK reports a
conclusive account-validation rejection. The immutable decision includes the
Grant authority and the reason `session-validation-failed`; changed facts need
a new review before signing. Explicit session selection and required onchain
enforcement never fall back. Unknown estimates and ambiguous submission failures
remain blocked and never authorize a resend.

The exact pinned development SDK now requires a structured `validation` result
from Grant review. This is a breaking public SDK boundary change; older review
objects are rejected. No persisted Moesi shape changes.

Local packed fixtures inject the bundler's estimation rejection or unavailability
and execute successful owner operations through a real local EntryPoint. These
checks do not claim live Monad execution or wallet-extension UI coverage.
