import { readFileSync } from "node:fs";
import { type Hex, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createMoesi,
  encodeMulticall3Aggregate,
  MAX_MULTICALL3_CALLS,
  MoesiPlanError,
  MULTICALL3_ADDRESS,
  MULTICALL3_RUNTIME_CODE_HASH,
  reviewPlan,
} from "../src/index.js";
import { decodeMulticall3Aggregate } from "../src/planning/multicall3.js";
import {
  createViemExecutionProvider,
  type ViemPublicClientLike,
  type ViemWalletClientLike,
} from "../src/viem/index.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const RUNTIME = readFileSync(
  new URL("./fixtures/Multicall3.runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;

// Exact moesi@0.12.0 `encodeMulticall3Aggregate` output for these two calls.
const CALLS = [
  {
    target: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    data: `0x${"11".repeat(32)}6000`,
    value: "0",
  },
  { target: "0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed", data: "0x26307668", value: "0" },
] as const;
const V012_DATA =
  "0x252dba4200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000e00000000000000000000000004e59b44847b379578588920ca78fbf26c0b4956c0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000002211111111111111111111111111111111111111111111111111111111111111116000000000000000000000000000000000000000000000000000000000000000000000000000000000000000ba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000042630766800000000000000000000000000000000000000000000000000000000";

describe("encodeMulticall3Aggregate", () => {
  it("matches the 0.12 encoding and returns a frozen value-free call", () => {
    const call = encodeMulticall3Aggregate(CALLS);
    expect(call).toEqual({ target: MULTICALL3_ADDRESS, data: V012_DATA, value: "0" });
    expect(Object.isFrozen(call)).toBe(true);
    expect(decodeMulticall3Aggregate(call.data)).toEqual(CALLS);
  });

  it("pins the canonical Multicall3 runtime observed on Ethereum, Arbitrum and Base", () => {
    expect((RUNTIME.length - 2) / 2).toBe(3808);
    expect(keccak256(RUNTIME)).toBe(MULTICALL3_RUNTIME_CODE_HASH);
  });

  it("rejects empty, oversized, valued and malformed batches", () => {
    const failures: unknown[] = [
      [],
      null,
      Array.from({ length: MAX_MULTICALL3_CALLS + 1 }, () => CALLS[0]),
      [{ ...CALLS[0], value: "1" }],
      [{ ...CALLS[0], value: 0 }],
      [{ ...CALLS[0], target: "0x12" }],
      [{ ...CALLS[0], data: "0x1" }],
      [{ ...CALLS[0], extra: true }],
      [{ target: CALLS[0].target, data: CALLS[0].data }],
    ];
    for (const calls of failures) {
      expect(() => encodeMulticall3Aggregate(calls as never)).toThrow(MoesiPlanError);
    }
  });

  it("decodes only canonical aggregate calldata", () => {
    expect(decodeMulticall3Aggregate("0x26307668")).toBeNull();
    expect(decodeMulticall3Aggregate(`${V012_DATA}00` as Hex)).toBeNull();
    expect(decodeMulticall3Aggregate(encodeMulticall3Aggregate([CALLS[0]]).data)).toEqual([
      CALLS[0],
    ]);
  });
});

describe("viem provider per-chain Multicall3 review", () => {
  const SENDER = `0x${"a".repeat(40)}` as const;

  function wallet(): ViemWalletClientLike {
    return {
      account: { address: SENDER, type: "local" },
      chain: { id: 1 },
      sendTransaction: vi.fn(async () => `0x${"8".repeat(64)}` as Hex),
    };
  }

  function reader(code: unknown): ViemPublicClientLike {
    return {
      chain: { id: 1 },
      async request({ method }: { readonly method: string }) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getCode") {
          if (code instanceof Error) throw code;
          return code;
        }
        return null;
      },
    };
  }

  function provider(code: unknown) {
    return createViemExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(code),
      confirmations: 1,
    });
  }

  function plan(input: { readonly value?: string; readonly owner?: boolean } = {}) {
    return reviewPlan(
      missingPlanDraft({
        manifest: testManifest({
          deploymentValue: input.value ?? "0",
          ...(input.owner ? { sender: { kind: "owner-eoa", address: SENDER } } : {}),
        }),
        chainIds: [1],
      }),
    );
  }

  it("supports sender-independent value-free chains with canonical Multicall3", async () => {
    const review = await provider(RUNTIME).review({ plan: plan(), packing: "per-chain" });
    expect(review.status).toBe("supported");
    expect(review.chains[0]?.route).toBe("viem-eoa-multicall3:confirmations-1");
    const perStep = await provider("0x").review({ plan: plan(), packing: "per-step" });
    expect(perStep.status).toBe("supported");
    expect(perStep.chains[0]?.route).toBe("viem-direct-eoa:confirmations-1");
  });

  it.each([
    ["absent Multicall3", "0x", {}, "multicall3-unavailable"],
    ["non-canonical Multicall3", "0x6000", {}, "multicall3-unavailable"],
    ["unreadable Multicall3", new Error("https://secret"), {}, "observer-unavailable"],
    ["a bound sender", RUNTIME, { owner: true }, "multicall3-sender-dependent"],
    ["a valued call", RUNTIME, { value: "7" }, "multicall3-value-unsupported"],
  ] as const)("blocks per-chain packing with %s", async (_label, code, input, reason) => {
    const review = await provider(code).review({ plan: plan(input), packing: "per-chain" });
    expect(review.status).toBe("blocked");
    expect(review.reasons).toContainEqual({ code: reason, chainId: 1, stepId: null });
  });

  it("re-attests Multicall3 before signing and never signs per-chain actions singly", async () => {
    let code: unknown = RUNTIME;
    const signer = wallet();
    const batching = createViemExecutionProvider({
      walletClientForChain: () => signer,
      publicClientForChain: () => ({
        chain: { id: 1 },
        async request({ method }: { readonly method: string }) {
          if (method === "eth_chainId") return "0x1";
          return method === "eth_getCode" ? code : null;
        },
      }),
      confirmations: 1,
    });
    const reviewed = plan();
    const review = await batching.review({ plan: reviewed, packing: "per-chain" });
    const prepared = await batching.prepare({ plan: reviewed, review, packing: "per-chain" });
    const operation = {
      id: "chain-1",
      planId: reviewed.planId,
      chainId: 1,
      steps: reviewed.steps,
    };
    await expect(
      batching.submit({
        prepared,
        action: { planId: reviewed.planId, chainId: 1, step: reviewed.steps[0]! },
      }),
    ).rejects.toMatchObject({ code: "invalid_action" });
    code = "0x";
    await expect(batching.submitBatch!({ prepared, operation })).rejects.toMatchObject({
      code: "invalid_action",
    });
    expect(signer.sendTransaction).not.toHaveBeenCalled();
    code = RUNTIME;
    const reference = await batching.submitBatch!({ prepared, operation });
    expect(reference.reference).toMatch(/^viem-multicall3-v1:0x[0-9a-f]{64}:confirmations-1$/);
    expect(signer.sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        to: MULTICALL3_ADDRESS,
        data: encodeMulticall3Aggregate(reviewed.steps.map(({ call }) => call)).data,
        value: 0n,
      }),
    );
  });

  it("keeps per-step as the viem default and validates declared defaults", async () => {
    const unused = async () => {
      throw new Error("unused");
    };
    const moesi = createMoesi({
      observer: {
        captureSnapshot: unused,
        readCode: unused,
        readCall: unused,
        checkBlockAncestry: unused,
      },
    });
    const reviewed = await moesi.reviewExecution({ plan: plan(), provider: provider(RUNTIME) });
    expect(reviewed.packing).toBe("per-step");
    const explicit = await moesi.reviewExecution({
      plan: plan(),
      provider: provider(RUNTIME),
      packing: "per-chain",
    });
    expect(explicit.packing).toBe("per-chain");
    const { submitBatch: _batch, ...single } = provider(RUNTIME);
    for (const invalid of [
      { ...single, defaultPacking: "per-chain" },
      { ...provider(RUNTIME), defaultPacking: "batch" },
    ]) {
      await expect(
        moesi.reviewExecution({ plan: plan(), provider: invalid as never }),
      ).rejects.toMatchObject({ code: "provider_invalid" });
    }
  });
});
