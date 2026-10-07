import { type Hex, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { createMoesi, type MoesiManifest, type MoesiObservationAdapter } from "../src/index.js";
import { readConcurrently } from "../src/observation/parallel.js";
import { testHash, testManifest } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("bounded resource observation", () => {
  it("keeps plans, executable order and verification identical when resources finish out of order", async () => {
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: Array.from(
        { length: 12 },
        (_, index) =>
          testManifest({
            id: `resource-${index.toString().padStart(2, "0")}`,
            salt: `0x${index.toString(16).padStart(64, "0")}`,
            runtimeHash: keccak256("0x6000"),
            configuration: [
              {
                id: "setting",
                readData: "0x12345678",
                writeData: "0x87654321",
                expectedResult: "0x01",
                value: "0",
              },
            ],
          }).contracts[0]!,
      ),
    };
    const immediate: MoesiObservationAdapter = {
      async captureSnapshot() {
        return { blockNumber: "100", blockHash: testHash("1") };
      },
      async readCode() {
        return "0x6000";
      },
      async readCall() {
        return "0x00";
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    const reference = createMoesi({ observer: immediate });
    const expected = await reference.plan({ manifest, chains: [1] });
    const waiting: ReturnType<typeof deferred<Hex>>[] = [];
    let active = 0;
    let peak = 0;
    const client = createMoesi({
      observer: {
        ...immediate,
        async readCode(request) {
          expect(request.snapshot).toEqual({
            chainId: 1,
            blockNumber: "100",
            blockHash: testHash("1"),
          });
          peak = Math.max(peak, ++active);
          const pending = deferred<Hex>();
          waiting.push(pending);
          try {
            return await pending.promise;
          } finally {
            active--;
          }
        },
      },
    });
    async function releaseWave(size: number) {
      await vi.waitFor(() => expect(waiting).toHaveLength(size));
      for (const pending of waiting.splice(0).reverse()) pending.resolve("0x6000");
    }
    const planning = client.plan({ manifest, chains: [1] });
    await releaseWave(8);
    await releaseWave(4);
    const plan = await planning;
    expect(plan).toEqual(expected);
    expect(plan.steps.map(({ resourceId }) => resourceId)).toEqual(
      manifest.contracts.map(({ id }) => id),
    );
    const verification = client.verify({ plan });
    await releaseWave(8);
    await releaseWave(4);
    expect(await verification).toEqual(await reference.verify({ plan: expected }));
    expect(peak).toBe(8);
    expect(active).toBe(0);
  });

  it("does not start further reads after a worker fails", async () => {
    const pending = Array.from({ length: 20 }, () => deferred<number>());
    const started: number[] = [];
    const error = new Error("cancelled");
    const reading = readConcurrently(pending, (item) => {
      started.push(pending.indexOf(item));
      return item.promise;
    });
    const rejected = expect(reading).rejects.toBe(error);
    expect(started).toHaveLength(8);
    pending[0]!.reject(error);
    await rejected;
    for (const item of pending.slice(1, 8)) item.resolve(1);
    await Promise.all(pending.slice(1, 8).map(({ promise }) => promise));
    expect(started).toHaveLength(8);
  });
});
