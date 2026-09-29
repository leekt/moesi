---
"moesi": patch
"@moesi/cli": patch
---

Share a bounded cooldown across reads to a throttled RPC endpoint instead of
immediately repeating rate-limited requests. The default delay is 500 ms and
doubles per retry up to five seconds; library callers can set
`retry.rateLimitDelayMs`. Other endpoints remain available for immediate
failover. Cancellation interrupts cooldowns without issuing another request,
and retries preserve the exact block pin and caller.
