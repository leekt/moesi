---
"@moesi/cli": patch
---

Add offline command-specific help, safe actionable diagnostics, and recovery
guidance for viem and OAAth execution. `plan --out <path>` atomically saves the
exact plan artifact with private permissions and refuses to replace an existing
file. JSON/YAML stdin remains supported; missing option values fail before I/O.

Human execution results report actual operations and fresh resource evidence
without repeating the review's not-started state. Interactive runs show execution
and safe-stop progress. JSON artifact shapes and execution acceptance are unchanged.
