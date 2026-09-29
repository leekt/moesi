---
"moesi": minor
"@moesi/oaath": minor
"@moesi/cli": minor
---

Execute each chain's reviewed steps as one atomic operation when the selected
provider implements `submitBatch`. Bind packing, signer and sender before
execution; preserve the exact call order and reject partial or altered evidence.
OAAth reviews and sends complete batches, and grant limits count operations.
The direct viem provider remains per-step.

Breaking: execution reviews use v2 with required packing and signer facts;
deployment Runs use v8 operation records with ordered step membership; run
results use v5 operation evidence. CLI review/result, status and permission
outputs use v7, v2 and v2 respectively. Recreate previous persisted artifacts.
Provider review and prepare now receive the selected packing. Replace step
record/evidence consumers with operation record/evidence consumers.

Resume observes one retained batch reference without resubmitting any calls.
Only an entirely satisfied configuration operation may be skipped. Runtime
dependencies created within an atomic operation are verified after execution;
per-step packing retains intermediate checks. Owner signing and Kernel v3.3
execution remain separate work under #61/#62.
