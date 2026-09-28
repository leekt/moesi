---
"moesi": patch
"@moesi/oaath": patch
---

Bound viem snapshot ancestry checks to three canonical block reads, independent
of receipt or plan age. Check both exact hashes and recheck the descendant
after the ancestor; reject contradictory adjacent parent linkage and changed
chain identity. Equal-height pins now require a canonical lookup too. Remove
the 4,096-block age limit and linear parent-hash walk. This uses configured
RPC canonicality, not local consensus verification; state reads retain their
exact EIP-1898 block pins.

Use the exact OAAth d1b7ab9 packages, whose receipt finality checks likewise
have a bounded canonical read set. Packed owner/session recovery tests now
resume after 1,024 additional blocks. Provider verification and deployment
convergence remain separate checks. No persisted Run or review shape changes.
