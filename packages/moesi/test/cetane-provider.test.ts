import { createExecution } from "cetane/execution/evm";
import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type {
  CetanePublicClientLike,
  CetaneWalletClientLike,
  CreateCetaneExecutionProviderInput,
} from "../src/cetane/index.js";
import {
  createCetaneExecutionProvider as createCetaneExecutionProviderImplementation,
  createCetaneObservationAdapter,
} from "../src/cetane/index.js";
import type {
  ManifestSender,
  MoesiObservationAdapter,
  PlanEnforcement,
  ReviewedPlan,
  SnapshotReference,
} from "../src/index.js";
import { createMoesi, reviewPlan } from "../src/index.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const SENDER = address("a");
const TARGET = address("f");
const TX_HASH = hash("8");
const BLOCK_HASH = hash("9");
const STORAGE_SLOT = hash("1");
const STORAGE_WORD = hash("2");
const cetaneReference = (confirmations = 1, transactionHash = TX_HASH) => ({
  providerId: "cetane",
  chainId: 1,
  reference: `cetane-tx-v1:${transactionHash}:confirmations-${confirmations}`,
});

const unusedObserver: MoesiObservationAdapter = {
  async captureSnapshot() {
    throw new Error("unused");
  },
  async readCode() {
    throw new Error("unused");
  },
  async readCall() {
    throw new Error("unused");
  },
  async checkBlockAncestry() {
    throw new Error("unused");
  },
};

function createCetaneExecutionProvider(
  input: Omit<CreateCetaneExecutionProviderInput, "confirmations"> & {
    readonly confirmations?: number;
  },
) {
  return createCetaneExecutionProviderImplementation({
    ...input,
    confirmations: input.confirmations ?? 1,
  });
}

function plan(
  input: {
    readonly sender?: ManifestSender | null;
    readonly enforcement?: PlanEnforcement;
    readonly chainIds?: readonly number[];
  } = {},
): ReviewedPlan {
  const manifest = testManifest({
    deploymentValue: "7",
    runtimeHash: keccak256(CODE),
    ...(input.sender === undefined || input.sender === null ? {} : { sender: input.sender }),
    ...(input.enforcement === undefined ? {} : { enforcement: input.enforcement }),
  });
  return reviewPlan(missingPlanDraft({ manifest, chainIds: input.chainIds ?? [1] }));
}

function wallet(
  input: {
    readonly sender?: `0x${string}`;
    readonly accountType?: string;
    readonly chainId?: number;
    readonly send?: CetaneWalletClientLike["sendTransaction"];
  } = {},
): CetaneWalletClientLike {
  return {
    account: {
      address: (input.sender ?? SENDER) as `0x${string}`,
      ...(input.accountType === "smart" ? { encodeCalls: () => "0x" as const } : {}),
    },
    chain: { id: input.chainId ?? 1, name: "Test", nativeAA: false, execution: createExecution() },
    sendTransaction: input.send ?? (async () => TX_HASH),
  };
}

function reader(
  handler:
    | ((method: string, params: readonly unknown[] | undefined) => unknown)
    | undefined = undefined,
  chainId = 1,
  rpcChainId = chainId,
): CetanePublicClientLike {
  return {
    chain: { id: chainId },
    async request({
      method,
      params,
    }: {
      readonly method: string;
      readonly params?: readonly unknown[];
    }) {
      if (method === "eth_chainId") return `0x${rpcChainId.toString(16)}`;
      return handler?.(method, params) ?? null;
    },
  };
}

function finalizedRpc(
  input: {
    readonly status?: "0x0" | "0x1";
    readonly latest?: string;
    readonly transactionHash?: `0x${string}`;
    readonly canonicalBlockHash?: `0x${string}`;
  } = {},
): CetanePublicClientLike {
  return reader((method) => {
    if (method === "eth_getTransactionReceipt") {
      return {
        transactionHash: TX_HASH,
        blockNumber: "0x5",
        blockHash: BLOCK_HASH,
        from: SENDER,
        to: TARGET,
        status: input.status ?? "0x1",
      };
    }
    if (method === "eth_getTransactionByHash") {
      return {
        hash: input.transactionHash ?? TX_HASH,
        blockNumber: "0x5",
        blockHash: BLOCK_HASH,
        from: SENDER,
        to: TARGET,
        input: "0x11111111",
        value: "0x7",
      };
    }
    if (method === "eth_blockNumber") return input.latest ?? "0x5";
    if (method === "eth_getBlockByNumber") {
      return {
        number: "0x5",
        hash: input.canonicalBlockHash ?? BLOCK_HASH,
      };
    }
    throw new Error(`unexpected ${method}`);
  });
}

describe("createCetaneExecutionProvider review", () => {
  it("requires an explicit confirmation policy", () => {
    expect(() =>
      createCetaneExecutionProviderImplementation({
        walletClientForChain: () => wallet(),
        publicClientForChain: () => reader(),
      } as never),
    ).toThrow(expect.objectContaining({ code: "provider_invalid" }));
  });

  it("supports sender-independent calls and exposes direct EOA enforcement", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(),
    });

    await expect(provider.review({ packing: "per-step", plan: plan() })).resolves.toEqual({
      providerId: "cetane",
      status: "supported",
      chains: [
        {
          chainId: 1,
          sender: SENDER,
          accountId: null,
          route: "cetane-direct-eoa:confirmations-1",
          signer: "owner" as const,
          signerReason: "caller-supplied-eoa",
          fallback: null,
          enforcement: {
            calls: "interactive-owner",
            expiry: "not-enforced",
            operationCount: "not-enforced",
          },
        },
      ],
      reasons: [],
    });
  });

  it("reviews sender-independent chains with different EOAs independently", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: (chainId) =>
        chainId === 1 ? wallet() : wallet({ sender: address("b"), chainId: 10 }),
      publicClientForChain: (chainId) => reader(undefined, chainId),
    });

    const review = await provider.review({
      packing: "per-step",
      plan: plan({ chainIds: [10, 1] }),
    });
    expect(review.status).toBe("supported");
    expect(review.chains.map(({ chainId, sender }) => [chainId, sender])).toEqual([
      [1, SENDER],
      [10, address("b")],
    ]);
  });

  it("supports the exact configured owner and blocks a different owner", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(),
    });
    const accepted = await provider.review({
      packing: "per-step",
      plan: plan({ sender: { kind: "owner-eoa", address: SENDER } }),
    });
    const blocked = await provider.review({
      packing: "per-step",
      plan: plan({ sender: { kind: "owner-eoa", address: address("b") } }),
    });

    expect(accepted.status).toBe("supported");
    expect(blocked).toMatchObject({
      status: "blocked",
      reasons: [{ code: "sender-mismatch", chainId: 1, stepId: null }],
    });
  });

  it("blocks smart-account senders and every required enforcement it cannot provide", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(),
    });
    const smart = await provider.review({
      packing: "per-step",
      plan: plan({
        sender: { kind: "smart-account", accountId: "kernel:ops", address: address("a") },
      }),
    });
    const enforced = await provider.review({
      packing: "per-step",
      plan: plan({
        enforcement: {
          callScope: "required-onchain",
          expiry: "required",
          operationLimit: "required",
        },
      }),
    });

    expect(smart.reasons.map(({ code }) => code)).toEqual(["smart-account-sender-required"]);
    expect(enforced.reasons.map(({ code }) => code)).toEqual([
      "onchain-call-scope-required",
      "onchain-expiry-required",
      "onchain-operation-limit-required",
    ]);
  });

  it("blocks a smart-account wallet client before submission", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet({ accountType: "smart" }),
      publicClientForChain: () => reader(),
    });

    const review = await provider.review({ packing: "per-step", plan: plan() });
    expect(review.status).toBe("blocked");
    expect(review.reasons).toContainEqual({
      code: "unsupported-account",
      chainId: 1,
      stepId: null,
    });
  });

  it("rejects unknown or substituted execution modules and native-AA chain settings", async () => {
    const ordinary = wallet();
    if (!ordinary.chain) throw new Error("missing test chain");
    for (const chain of [
      { ...ordinary.chain, execution: undefined },
      { ...ordinary.chain, execution: { ...createExecution() } },
      { ...ordinary.chain, nativeAA: undefined },
      { ...ordinary.chain, nativeAA: {} },
    ]) {
      const send = vi.fn(async () => TX_HASH);
      const provider = createCetaneExecutionProvider({
        walletClientForChain: () =>
          ({ ...ordinary, chain, sendTransaction: send }) as unknown as CetaneWalletClientLike,
        publicClientForChain: () => reader(),
      });
      const review = await provider.review({ packing: "per-step", plan: plan() });
      expect(review.status).toBe("blocked");
      expect(review.reasons).toContainEqual({
        code: "unsupported-account",
        chainId: 1,
        stepId: null,
      });
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("blocks unavailable and contradictory wallet or public-client identity", async () => {
    const noWallet = createCetaneExecutionProvider({
      walletClientForChain: () => undefined,
      publicClientForChain: () => reader(),
    });
    const wrongWalletChain = createCetaneExecutionProvider({
      walletClientForChain: () => wallet({ chainId: 10 }),
      publicClientForChain: () => reader(),
    });
    const wrongReaderChain = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(undefined, 10),
    });
    const wrongRpcChain = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(undefined, 1, 10),
    });
    const noSubmission = createCetaneExecutionProvider({
      walletClientForChain: () =>
        ({ ...wallet(), sendTransaction: null }) as unknown as CetaneWalletClientLike,
      publicClientForChain: () => reader(),
    });

    expect(
      (await noWallet.review({ packing: "per-step", plan: plan() })).reasons.map(
        ({ code }) => code,
      ),
    ).toEqual(["wallet-unavailable"]);
    expect(
      (await wrongWalletChain.review({ packing: "per-step", plan: plan() })).reasons.map(
        ({ code }) => code,
      ),
    ).toEqual(["chain-mismatch"]);
    expect(
      (await wrongReaderChain.review({ packing: "per-step", plan: plan() })).reasons.map(
        ({ code }) => code,
      ),
    ).toEqual(["observer-chain-mismatch"]);
    expect(
      (await wrongRpcChain.review({ packing: "per-step", plan: plan() })).reasons.map(
        ({ code }) => code,
      ),
    ).toEqual(["observer-chain-mismatch"]);
    expect(
      (await noSubmission.review({ packing: "per-step", plan: plan() })).reasons.map(
        ({ code }) => code,
      ),
    ).toEqual(["submission-unavailable"]);
  });

  it("rechecks the plan and binding at prepare instead of accepting a replayed review", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => reader(),
    });
    const safe = plan();
    const safeReview = await provider.review({ packing: "per-step", plan: safe });
    const smart = plan({
      sender: { kind: "smart-account", accountId: "kernel:ops", address: address("a") },
    });

    await expect(
      provider.prepare({ packing: "per-step", plan: smart, review: safeReview }),
    ).rejects.toMatchObject({
      code: "provider_prepare_failed",
    });
  });

  it("returns a valid blocked review when more than 64 reasons are required", async () => {
    const chainIds = Array.from({ length: 13 }, (_, index) => index + 1);
    const reviewed = plan({
      chainIds,
      enforcement: {
        callScope: "required-onchain",
        expiry: "required",
        operationLimit: "required",
      },
    });
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => undefined,
      publicClientForChain: () => undefined,
    });
    const executionReview = await createMoesi({ observer: unusedObserver }).reviewExecution({
      plan: reviewed,
      provider,
    });

    expect(executionReview.provider.status).toBe("blocked");
    expect(executionReview.provider.reasons.length).toBeGreaterThan(64);
  });
});

describe("createCetaneExecutionProvider submit and observe", () => {
  it("submits exactly the prepared reviewed transaction and preserves its hash", async () => {
    const send = vi.fn(async () => TX_HASH);
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet({ send }),
      publicClientForChain: () => finalizedRpc(),
    });
    const reviewed = plan();
    const review = await provider.review({ packing: "per-step", plan: reviewed });
    const prepared = await provider.prepare({ packing: "per-step", plan: reviewed, review });
    const step = reviewed.steps[0];
    if (!step) throw new Error("missing test step");

    const reference = await provider.submit({
      prepared,
      action: { planId: reviewed.planId, chainId: 1, step },
    });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      account: { address: SENDER },
      to: step.call.target,
      data: step.call.data,
      value: 7n,
    });
    expect(reference).toEqual(cetaneReference());
  });

  it("rejects a malformed wallet transaction hash after exactly one send", async () => {
    const send = vi.fn(async () => "not-a-transaction-hash" as `0x${string}`);
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet({ send }),
      publicClientForChain: () => finalizedRpc(),
    });
    const reviewed = plan();
    const review = await provider.review({ packing: "per-step", plan: reviewed });
    const prepared = await provider.prepare({ packing: "per-step", plan: reviewed, review });
    const step = reviewed.steps[0];
    if (!step) throw new Error("missing test step");

    await expect(
      provider.submit({
        prepared,
        action: { planId: reviewed.planId, chainId: 1, step },
      }),
    ).rejects.toMatchObject({ code: "invalid_action" });
    expect(send).toHaveBeenCalledOnce();
  });

  it("blocks before signing when the prepared wallet account changes", async () => {
    const send = vi.fn(async () => TX_HASH);
    const mutableWallet = wallet({ send });
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => mutableWallet,
      publicClientForChain: () => finalizedRpc(),
    });
    const reviewed = plan();
    const review = await provider.review({ packing: "per-step", plan: reviewed });
    const prepared = await provider.prepare({ packing: "per-step", plan: reviewed, review });
    const step = reviewed.steps[0];
    if (!step) throw new Error("missing test step");
    (mutableWallet as { account: { address: `0x${string}` } }).account = {
      address: address("b"),
    };

    await expect(
      provider.submit({
        prepared,
        action: { planId: reviewed.planId, chainId: 1, step },
      }),
    ).rejects.toMatchObject({ code: "invalid_action" });
    expect(send).not.toHaveBeenCalled();
  });

  it("blocks before signing when the prepared account becomes non-EOA", async () => {
    const send = vi.fn(async () => TX_HASH);
    const mutableWallet = wallet({ send });
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => mutableWallet,
      publicClientForChain: () => finalizedRpc(),
    });
    const reviewed = plan();
    const review = await provider.review({ packing: "per-step", plan: reviewed });
    const prepared = await provider.prepare({ packing: "per-step", plan: reviewed, review });
    const step = reviewed.steps[0];
    if (!step || !mutableWallet.account) throw new Error("missing test binding");
    (
      mutableWallet.account as {
        encodeCalls?: NonNullable<CetaneWalletClientLike["account"]>["encodeCalls"];
      }
    ).encodeCalls = () => "0x";

    await expect(
      provider.submit({
        prepared,
        action: { planId: reviewed.planId, chainId: 1, step },
      }),
    ).rejects.toMatchObject({ code: "invalid_action" });
    expect(send).not.toHaveBeenCalled();
  });

  it("observes canonical confirmed execution evidence without submitting", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc(),
    });

    await expect(provider.observe({ reference: cetaneReference() })).resolves.toEqual({
      status: "finalized",
      finalized: {
        chainId: 1,
        sender: SENDER,
        calls: [{ target: TARGET, data: "0x11111111", value: "7" }],
        providerEvidenceId: TX_HASH,
        submissionRoute: "transaction",
        blockNumber: "5",
        blockHash: BLOCK_HASH,
      },
    });
  });

  it("keeps missing receipts, insufficient confirmations, and orphaned receipts pending", async () => {
    const missing = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () =>
        reader((method) => (method === "eth_getTransactionReceipt" ? null : null)),
    });
    const confirming = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ latest: "0x5" }),
      confirmations: 1,
    });
    const reorged = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ canonicalBlockHash: hash("7") }),
    });
    const reference = cetaneReference();

    await expect(missing.observe({ reference })).resolves.toEqual({ status: "pending" });
    await expect(confirming.observe({ reference: cetaneReference(2) })).resolves.toEqual({
      status: "pending",
    });
    await expect(reorged.observe({ reference })).resolves.toEqual({ status: "pending" });
  });

  it("binds confirmation policy in both review and durable observation reference", async () => {
    const strict = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ latest: "0x5" }),
      confirmations: 2,
    });
    const reconstructedWithWeakerDefault = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ latest: "0x5" }),
      confirmations: 1,
    });

    expect((await strict.review({ packing: "per-step", plan: plan() })).chains[0]?.route).toBe(
      "cetane-direct-eoa:confirmations-2",
    );
    await expect(
      reconstructedWithWeakerDefault.observe({ reference: cetaneReference(2) }),
    ).resolves.toEqual({ status: "pending" });
  });

  it("reports a canonical confirmed revert only after evidence validation", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ status: "0x0" }),
    });

    await expect(
      provider.observe({
        reference: cetaneReference(),
      }),
    ).resolves.toEqual({ status: "failed", reason: "reverted" });
  });

  it("fails closed on a transaction response not anchored to the reference", async () => {
    const provider = createCetaneExecutionProvider({
      walletClientForChain: () => wallet(),
      publicClientForChain: () => finalizedRpc({ transactionHash: hash("7") }),
    });

    await expect(
      provider.observe({
        reference: cetaneReference(),
      }),
    ).resolves.toEqual({ status: "unreadable", reason: "invalid-evidence" });
  });
});

describe("createCetaneObservationAdapter", () => {
  it("pins reads to the captured canonical block hash", async () => {
    const request = vi.fn(async ({ method }: { readonly method: string }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber")
        return { number: "0x5", hash: BLOCK_HASH, parentHash: hash("8") };
      if (method === "eth_getCode") return CODE;
      if (method === "eth_call") return "0x01";
      if (method === "eth_getStorageAt") return STORAGE_WORD;
      throw new Error(`unexpected ${method}`);
    });
    const adapter = createCetaneObservationAdapter({
      publicClientForChain: () => ({ chain: { id: 1 }, request }),
    });
    const snapshot = (await adapter.captureSnapshot(1)) as SnapshotReference;

    expect(snapshot).toEqual({ blockNumber: "5", blockHash: BLOCK_HASH });
    await expect(
      adapter.readCode({ chainId: 1, address: TARGET, snapshot: { chainId: 1, ...snapshot } }),
    ).resolves.toBe(CODE);
    await expect(
      adapter.readCall({
        chainId: 1,
        target: TARGET,
        data: "0x11111111",
        caller: SENDER,
        snapshot: { chainId: 1, ...snapshot },
      }),
    ).resolves.toBe("0x01");
    if (adapter.readStorage === undefined) throw new Error("storage reader is unavailable");
    await expect(
      adapter.readStorage({
        chainId: 1,
        address: TARGET,
        slot: STORAGE_SLOT,
        snapshot: { chainId: 1, ...snapshot },
      }),
    ).resolves.toBe(STORAGE_WORD);
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "eth_getCode",
      params: [TARGET, { blockHash: BLOCK_HASH, requireCanonical: true }],
    });
    expect(request).toHaveBeenNthCalledWith(4, {
      method: "eth_call",
      params: [
        { from: SENDER, to: TARGET, data: "0x11111111" },
        { blockHash: BLOCK_HASH, requireCanonical: true },
      ],
    });
    expect(request).toHaveBeenNthCalledWith(5, {
      method: "eth_getStorageAt",
      params: [TARGET, STORAGE_SLOT, { blockHash: BLOCK_HASH, requireCanonical: true }],
    });
    await expect(
      adapter.checkBlockAncestry({
        chainId: 1,
        ancestor: snapshot,
        descendant: { chainId: 1, ...snapshot },
      }),
    ).resolves.toBe(true);
  });

  it("checks old canonical pins without walking intervening parent hashes", async () => {
    const request = vi.fn(
      async ({
        method,
        params,
      }: {
        readonly method: string;
        readonly params?: readonly unknown[];
      }) => {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByNumber") {
          return {
            number: params?.[0],
            hash: params?.[0] === "0x4" ? hash("8") : BLOCK_HASH,
            parentHash: hash("8"),
          };
        }
        throw new Error(`unexpected ${method}`);
      },
    );
    const adapter = createCetaneObservationAdapter({
      publicClientForChain: () => ({ chain: { id: 1 }, request }),
    });

    await expect(
      adapter.checkBlockAncestry({
        chainId: 1,
        ancestor: { blockNumber: "4", blockHash: hash("8") },
        descendant: { chainId: 1, blockNumber: "1000004", blockHash: BLOCK_HASH },
      }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(5);
    expect(
      request.mock.calls
        .filter(([r]) => r.method === "eth_getBlockByNumber")
        .map(([r]) => r.params?.[0]),
    ).toEqual(["0xf4244", "0x4", "0xf4244"]);
    await expect(
      adapter.checkBlockAncestry({
        chainId: 1,
        ancestor: { blockNumber: "4", blockHash: hash("7") },
        descendant: { chainId: 1, blockNumber: "1000004", blockHash: BLOCK_HASH },
      }),
    ).resolves.toBe(false);
  });

  it("snapshots each ancestry block response exactly once", async () => {
    let parentReads = 0;
    const request = vi.fn(async ({ method }: { readonly method: string }) => {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByNumber") {
        return Object.defineProperty({ number: "0x5", hash: BLOCK_HASH }, "parentHash", {
          enumerable: true,
          get() {
            parentReads += 1;
            return parentReads === 1 ? hash("7") : hash("8");
          },
        });
      }
      throw new Error(`unexpected ${method}`);
    });
    const adapter = createCetaneObservationAdapter({
      publicClientForChain: () => ({ chain: { id: 1 }, request }),
    });

    await expect(
      adapter.checkBlockAncestry({
        chainId: 1,
        ancestor: { blockNumber: "4", blockHash: hash("8") },
        descendant: { chainId: 1, blockNumber: "5", blockHash: BLOCK_HASH },
      }),
    ).resolves.toBe(false);
    expect(parentReads).toBe(1);
  });

  it.each(["ancestor", "rebound-descendant", "chain", "same-height", "malformed"])(
    "does not attest ancestry after a contradictory %s response",
    async (failure) => {
      let blocks = 0;
      const request = vi.fn(
        async ({
          method,
          params,
        }: {
          readonly method: string;
          readonly params?: readonly unknown[];
        }) => {
          if (method === "eth_chainId") return failure === "chain" && blocks === 3 ? "0x2" : "0x1";
          if (method !== "eth_getBlockByNumber") throw new Error("unexpected read");
          blocks++;
          if (failure === "malformed") return { number: params?.[0], hash: BLOCK_HASH };
          return {
            number: params?.[0],
            hash:
              params?.[0] === "0x1"
                ? failure === "ancestor"
                  ? BLOCK_HASH
                  : hash("8")
                : failure === "same-height" || (failure === "rebound-descendant" && blocks === 3)
                  ? hash("7")
                  : BLOCK_HASH,
            parentHash: hash("8"),
          };
        },
      );
      const adapter = createCetaneObservationAdapter({
        publicClientForChain: () => ({ chain: { id: 1 }, request }),
      });
      const pending = adapter.checkBlockAncestry({
        chainId: 1,
        ancestor:
          failure === "same-height"
            ? { blockNumber: "5", blockHash: BLOCK_HASH }
            : { blockNumber: "1", blockHash: hash("8") },
        descendant: { chainId: 1, blockNumber: "5", blockHash: BLOCK_HASH },
      });
      if (failure === "chain" || failure === "malformed") await expect(pending).rejects.toThrow();
      else await expect(pending).resolves.toBe(false);
    },
  );

  it("rejects a public client whose chain identity is unavailable or contradictory", async () => {
    const adapter = createCetaneObservationAdapter({
      publicClientForChain: () => reader(undefined, 1, 10),
    });
    await expect(adapter.captureSnapshot(1)).rejects.toThrow(
      "RPC chain identity is unavailable or contradictory",
    );
  });
});
