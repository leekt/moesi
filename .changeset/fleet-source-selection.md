---
"moesi": minor
---

Allow `fleet.compile({ chains })` to select source chains without removing peer
chains from its resource catalog. This supports independent single-chain scans
without compiling every source or making unrelated live reads.
