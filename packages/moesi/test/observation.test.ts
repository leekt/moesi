import { describe, expect, it } from "vitest";
import {
  type MoesiObservationAdapter,
  observeStorage,
  type StorageReadRequest,
} from "../src/index.js";

const request: StorageReadRequest = {
  chainId: 1,
  address: `0x${"a".repeat(40)}`,
  slot: `0x${"0".repeat(64)}`,
  snapshot: {
    chainId: 1,
    blockNumber: "7",
    blockHash: `0x${"b".repeat(64)}`,
  },
};

function observer(readStorage?: MoesiObservationAdapter["readStorage"]): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "7", blockHash: request.snapshot.blockHash };
    },
    async readCode() {
      return "0x6000";
    },
    async readCall() {
      return "0x";
    },
    ...(readStorage === undefined ? {} : { readStorage }),
    async checkBlockAncestry() {
      return true;
    },
  };
}

describe("observeStorage", () => {
  it("returns one exact lowercase storage word and preserves the adapter receiver", async () => {
    const expected = `0x${"AB".repeat(32)}` as const;
    const adapter = observer(async function (this: MoesiObservationAdapter, received) {
      expect(this).toBe(adapter);
      expect(received).toBe(request);
      return expected;
    });

    await expect(observeStorage(adapter, request)).resolves.toEqual({
      kind: "readable",
      word: expected.toLowerCase(),
    });
  });

  it("reports an absent or non-callable capability as unavailable", async () => {
    await expect(observeStorage(observer(), request)).resolves.toEqual({
      kind: "unreadable",
      reason: "unavailable",
    });
    await expect(
      observeStorage({ ...observer(), readStorage: "not-a-function" } as never, request),
    ).resolves.toEqual({ kind: "unreadable", reason: "unavailable" });
  });

  it("rejects empty, short, malformed, and non-string storage responses", async () => {
    for (const value of ["0x", "0x00", `0x${"a".repeat(63)}`, `0x${"g".repeat(64)}`, 0]) {
      await expect(
        observeStorage(
          observer(async () => value as never),
          request,
        ),
      ).resolves.toEqual({ kind: "unreadable", reason: "invalid-response" });
    }
  });

  it("scrubs hostile capability access and read failures", async () => {
    const secret = "storage-provider-secret";
    const throwingGetter = observer();
    Object.defineProperty(throwingGetter, "readStorage", {
      get() {
        throw new Error(secret);
      },
    });

    const getterResult = await observeStorage(throwingGetter, request);
    const callResult = await observeStorage(
      observer(async () => {
        throw new Error(secret);
      }),
      request,
    );
    expect(getterResult).toEqual({ kind: "unreadable", reason: "read-failed" });
    expect(callResult).toEqual({ kind: "unreadable", reason: "read-failed" });
    expect(JSON.stringify([getterResult, callResult])).not.toContain(secret);
  });
});
