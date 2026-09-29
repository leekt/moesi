# SRA pin capture fixture

This application-specific example runs in the isolated SRA checkout described
in [the acceptance record](sra-live-parity.md). Save the code as
`scripts/moesi-current-live-pins.ts` there; its application imports and `moesi-current` alias
are intentionally not dependencies of the Moesi workspace.

```ts
import { writeFile } from "node:fs/promises";
import { MoesiObservationError } from "moesi-current";
import { createViemObserver } from "moesi-current/viem";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { CHAINS, DEPLOYER } from "../src/data/chains.ts";
import { buildTokenDecimalReads } from "../src/lib/manifest.ts";

const abi = parseAbi(["function decimals() view returns (uint8)"]);
const observer = createViemObserver({
  chains: Object.fromEntries(
    CHAINS.map((c) => [c.chainId, { rpcUrls: [c.rpc], pin: { lagBlocks: 2 } }]),
  ),
  retry: { attempts: 2 },
  timeoutMs: 7000,
  concurrency: 8,
  batch: true,
});
const evidence = await Promise.all(
  CHAINS.map(async (c) => {
    let snapshot: { chainId: number; blockNumber?: string; blockHash?: `0x${string}` };
    try {
      snapshot = { chainId: c.chainId, ...((await observer.captureSnapshot(c.chainId)) as object) };
    } catch (error) {
      return {
        chainId: c.chainId,
        key: c.key,
        status: "pin-unreadable",
        ...(error instanceof MoesiObservationError ? { cause: error.cause } : {}),
      };
    }
    const reads = await Promise.all(
      buildTokenDecimalReads(c).map(async (r) => {
        try {
          const value = await observer.readCall({
            chainId: c.chainId,
            snapshot,
            address: r.address,
            target: r.address,
            caller: DEPLOYER,
            data: encodeFunctionData({ abi, functionName: "decimals" }),
          } as any);
          const decimals = decodeFunctionResult({
            abi,
            functionName: "decimals",
            data: value as `0x${string}`,
          });
          return { address: r.address, decimals };
        } catch (error) {
          return {
            address: r.address,
            status: "unreadable",
            ...(error instanceof MoesiObservationError ? { cause: error.cause } : {}),
          };
        }
      }),
    );
    console.log(
      JSON.stringify({
        chainId: c.chainId,
        key: c.key,
        blockNumber: snapshot.blockNumber,
        reads: reads.length,
        unreadable: reads.filter((r) => "status" in r).length,
      }),
    );
    return { chainId: c.chainId, key: c.key, snapshot, reads };
  }),
);
await writeFile(
  "/tmp/moesi-sra-parity/live-pins.json",
  JSON.stringify(
    {
      source: "0726cbf6654ee5d26aea7a8dcf734ce8bf68e3ff",
      at: new Date().toISOString(),
      pinPolicy: { lagBlocks: 2 },
      evidence,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify({
    chains: evidence.length,
    pinFailures: evidence.filter((e) => e.status).length,
    readFailures: evidence.flatMap((e) => e.reads ?? []).filter((r) => "status" in r).length,
  }),
);
```
