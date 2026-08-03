# @moesi/cli

`@moesi/cli` is the deployment-focused command line interface for Moesi.

```sh
moesi plan --manifest ./moesi.json --chain 8453=https://rpc.example --json
```

Repeat `--chain` for multiple chains. The command exits 0 for converged, 2 for
changes, 3 for blocked or partial state, and 1 for invalid input or a failed
pinned snapshot. RPC URLs and raw provider diagnostics are not printed.

Runtime code is read with `eth_getCode`, and exact configuration checks use
`eth_call`. Both use the captured block hash with `requireCanonical: true`.
Configuration drift is emitted as reviewed remediation calldata; unreadable
configuration evidence blocks planning.

The current CLI only plans. Authorization and apply commands will be added when
the released OGP client can own their authority and submission behavior.
