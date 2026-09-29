---
"moesi": minor
"@moesi/oaath": minor
"@moesi/cli": minor
---

Support existing Kernel v3.3 owner execution through the public OAAth owner
client, selecting owner signing for an estimated single chain operation.
Expose the reviewed fallback policy and the actual finalized submission route.
Owner recovery opens the saved operation without a wallet or new permission.

Breaking: execution reviews use v3, deployment Runs v9, and run results v6.
CLI review/result outputs use v8 and status uses v3. Recreate older artifacts.
OAAth operation references use v2 with an explicit owner/session context.
CLI `openOAAth()` modules now return provider options `{ oaath, account?, owner?,
signer?, sender? }` instead of a bare SDK client.

Local session orchestration and fallback from conclusive session-validation
failure remain pending; an unavailable owner estimate blocks without signing.
