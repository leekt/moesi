---
"moesi": minor
---

Add synchronous `admitRpc` to the Cetane observer for caller-owned job-window
budgets. Frozen method lists charge every dispatched RPC method, including
batched methods, chain checks and retries. Denial stops the observer with
`observation_budget_exhausted`; plan, verify and discovery propagate that code.
Fleet scans retain their last complete evidence and close the failed reservation
before propagating exhaustion. Counters and future window admission stay with
the caller.
