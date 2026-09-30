---
"moesi": patch
"@moesi/cli": patch
---

Add credentialed RPC endpoint handling to `moesi/viem`: `rpcEndpoint(url)`
moves Basic-auth userinfo into an `Authorization` header, `redactRpcUrl(url)`
removes userinfo, known API-key query values and `/v3/<key>` path segments, and
`createHttpTransport(url, options)` sends those headers and scrubs every request
failure into `MoesiRpcTransportError`. `createViemObserver` now accepts
credentialed `rpcUrls`, and CLI signing transports use the scrubbing transport.
