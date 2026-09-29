import type {
  Oaath,
  OaathCallsReview,
  OaathOwnerCallsReview,
  OaathOwnerClient,
  OaathReviewCallsInput,
  OaathSendCallsInput,
} from "@oaath/sdk";
import { OAATH_CALLS_REVIEW_VERSION } from "@oaath/sdk";
import {
  compileExecutionOperations,
  createMoesi,
  type ManifestSender,
  type PlanEnforcement,
} from "moesi";
import { createWalletClient, custom, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  compileOAAthPlanPermission,
  createOAAthExecutionProvider,
  requestOAAthPlanPermission,
} from "../src/index.js";

const address = `0x${"44".repeat(20)}` as const;
const hash = `0x${"ab".repeat(32)}` as const;
const runtime = "0x6000";
const factory = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const factoryCode =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

async function plan(
  chains = [1],
  sender?: ManifestSender,
  count = 1,
  enforcement?: PlanEnforcement,
) {
  return createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "1", blockHash: hash };
      },
      async readCode({ address: target }) {
        return target === factory ? factoryCode : "0x";
      },
      async readCall() {
        return "0x";
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({
    chains,
    manifest: {
      version: "moesi.manifest/v6",
      contracts: Array.from({ length: count }, (_, index) => ({
        kind: "managed",
        id: index === 0 ? "counter" : `counter-${index}`,
        deployment: {
          kind: "create2-factory-v1",
          requiresRuntime: [],
          salt: index === 0 ? hash : `0x${index.toString(16).padStart(64, "0")}`,
          initCode: "0x6002600c60003960026000f36000",
          value: "0",
        },
        expectedRuntimeCodeHash: keccak256(runtime),
        checks: [],
        storageChecks: [],
        configuration: [],
        ...(sender ? { sender } : {}),
        ...(enforcement ? { enforcement } : {}),
      })),
    },
  });
}

function sdk() {
  const facts = {
    version: OAATH_CALLS_REVIEW_VERSION,
    validation: "not-estimated",
    grantId: "grant-a",
    accountId: "account-a",
    account: { address, implementation: "kernel:0.3.3" },
    signer: "session",
    fallback: null,
    paymasterService: null,
    enableVerificationGasFloor: null,
    route: "erc4337-bundler",
    reasons: ["session_covers_calls", "route_available:erc4337-bundler"],
    enforcement: { calls: "onchain", expiry: "onchain", operationCount: "onchain" },
    expiresAt: 2_000_000,
    validAfter: 1,
    validUntil: 2_000,
    perChainOperationLimit: { count: 10, intervalSeconds: null },
  } as unknown as Omit<OaathCallsReview, "chainId" | "calls">;
  let submitted: OaathSendCallsInput | undefined;
  let active = true;
  const operation = {
    id: hash,
    chainId: 1,
    observe: vi.fn(async () => ({ status: "finalized" })),
    execution: vi.fn(async () => ({
      id: hash,
      grantId: facts.grantId,
      chainId: 1,
      sender: address,
      calls: submitted?.calls,
      transactionHash: hash,
      blockNumber: "2",
      blockHash: hash,
      outcome: "success",
      route: "erc4337-bundler",
    })),
  };
  const grant = {
    reviewCalls: vi.fn(async (input: OaathReviewCallsInput) => ({
      ...facts,
      validation:
        input.estimate && facts.validation === "not-estimated"
          ? ("estimated" as const)
          : facts.validation,
      chainId: input.chain,
      calls: input.calls,
    })),
    sendCalls: vi.fn(async (input: OaathSendCallsInput) => {
      submitted = input;
      return operation;
    }),
    getOperation: vi.fn(async () => operation),
  };
  const connection = {
    resume: vi.fn(async () => (active ? grant : null)),
    requestPermission: vi.fn(async () => {
      active = true;
      return grant;
    }),
    close: vi.fn(async () => {}),
  };
  const oaath = { connect: vi.fn(async () => connection) } as unknown as Oaath;
  return {
    oaath,
    facts,
    grant,
    connection,
    operation,
    setActive(value: boolean) {
      active = value;
    },
  };
}

describe("public OAAth adapter contract", () => {
  it("sends on the configured lane and recovers it from the reference alone", async () => {
    const s = sdk();
    const p = await plan();
    const lane = { id: "run_b", nonceKey: 2n };
    const provider = createOAAthExecutionProvider({ oaath: s.oaath, lane });
    const review = await provider.review({ plan: p, packing: "per-chain" });
    expect(review).toMatchObject({ status: "supported", chains: [{ signer: "session" }] });
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    const reference = await provider.submitBatch!({ prepared, operation });
    expect(s.grant.sendCalls).toHaveBeenCalledExactlyOnceWith({
      chain: 1,
      calls: operation.steps.map((step) => step.call),
      lane,
    });
    expect(reference.reference).toMatch(
      new RegExp(`^oaath-op-v3:session:[0-9a-f]{64}:lane\\.2\\.run_b:${hash}$`),
    );
    const recovered = createOAAthExecutionProvider({ oaath: s.oaath });
    expect(await recovered.observe({ reference })).toMatchObject({ status: "finalized" });
    expect(s.grant.getOperation).toHaveBeenLastCalledWith({ chain: 1, id: hash, lane });
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
  });

  it("binds the lane into the accepted review", async () => {
    const s = sdk();
    const p = await plan();
    const onA = createOAAthExecutionProvider({
      oaath: s.oaath,
      lane: { id: "run_a", nonceKey: 1n },
    });
    const review = await onA.review({ plan: p, packing: "per-chain" });
    const routes = await Promise.all(
      [undefined, { id: "run_b", nonceKey: 1n }, { id: "run_a", nonceKey: 2n }].map(
        async (lane) =>
          (
            await createOAAthExecutionProvider({
              oaath: s.oaath,
              ...(lane ? { lane } : {}),
            }).review({ plan: p, packing: "per-chain" })
          ).chains[0]?.route,
      ),
    );
    expect(new Set([review.chains[0]?.route, ...routes]).size).toBe(4);
    const onB = createOAAthExecutionProvider({
      oaath: s.oaath,
      lane: { id: "run_b", nonceKey: 2n },
    });
    await expect(onB.prepare({ plan: p, packing: "per-chain", review })).rejects.toMatchObject({
      code: "oaath_review_changed",
    });
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("rejects owner lanes and malformed lanes at construction", () => {
    const s = ownerSdk();
    const lane = { id: "run_a", nonceKey: 1n };
    for (const input of [
      { oaath: { ...s.oaath, ...s.session }, account: { address }, signer: "owner", lane },
      { oaath: s.oaath, account: { address }, lane },
      { oaath: s.session, lane: { id: "run_a", nonceKey: 0n } },
      { oaath: s.session, lane: { id: "run_a", nonceKey: 1 } },
      { oaath: s.session, lane: { id: "run:a", nonceKey: 1n } },
      { oaath: s.session, lane: { id: "run_a", nonceKey: 2n ** 64n } },
      { oaath: s.session, lane: { ...lane, extra: true } },
    ])
      expect(() => createOAAthExecutionProvider(input as never)).toThrow(
        expect.objectContaining({ code: "oaath_input_invalid" }),
      );
  });

  it("never selects owner for a laned provider", async () => {
    const s = ownerSdk();
    const provider = createOAAthExecutionProvider({
      oaath: { ...s.oaath, ...s.session },
      account: { address },
      owner: s.wallet,
      lane: { id: "run_a", nonceKey: 1n },
    });
    expect(await provider.review({ plan: await plan(), packing: "per-chain" })).toMatchObject({
      status: "supported",
      chains: [{ signer: "session" }],
    });
    expect(s.handle.reviewCalls).not.toHaveBeenCalled();
  });

  it("reviews and sends the complete chain batch under a one-operation grant", async () => {
    const s = sdk();
    const p = await plan([1], undefined, 3);
    Object.assign(s.facts, { perChainOperationLimit: { count: 1, intervalSeconds: null } });
    expect(compileOAAthPlanPermission({ plans: [p] }).perChainOperationLimit).toBe(1);
    expect(
      compileOAAthPlanPermission({ plans: [p], packing: "per-step" }).perChainOperationLimit,
    ).toBe(3);
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const review = await provider.review({ plan: p, packing: "per-chain" });
    expect(review.status).toBe("supported");
    expect(review.chains[0]).toMatchObject({
      signer: "session",
      signerReason: "session-authorized",
    });
    expect(s.grant.reviewCalls).toHaveBeenLastCalledWith({
      chain: 1,
      calls: p.steps.map((step) => step.call),
    });
    expect((await provider.review({ plan: p, packing: "per-step" })).status).toBe("blocked");
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    for (const changed of [
      { ...operation, id: "unreviewed" },
      { ...operation, steps: operation.steps.slice(1) },
      { ...operation, steps: [...operation.steps].reverse() },
      { ...operation, steps: [operation.steps[0]!, operation.steps[0]!, operation.steps[2]!] },
    ])
      await expect(provider.submitBatch!({ prepared, operation: changed })).rejects.toMatchObject({
        code: "oaath_action_invalid",
      });
    await expect(
      provider.submit({ prepared, action: { planId: p.planId, chainId: 1, step: p.steps[0]! } }),
    ).rejects.toMatchObject({ code: "oaath_action_invalid" });
    const submissions = await Promise.allSettled([
      provider.submitBatch!({ prepared, operation }),
      provider.submitBatch!({ prepared, operation }),
    ]);
    expect(submissions.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(s.grant.sendCalls).toHaveBeenCalledExactlyOnceWith({
      chain: 1,
      calls: p.steps.map((step) => step.call),
    });
    const completed = submissions[0]!;
    if (completed.status !== "fulfilled") throw new Error("submission failed");
    expect(
      await createOAAthExecutionProvider({ oaath: s.oaath }).observe({
        reference: completed.value,
      }),
    ).toMatchObject({
      status: "finalized",
      finalized: { calls: p.steps.map((step) => step.call) },
    });
  });

  it("compiles one sorted all-chain permission union and bounds operation count", async () => {
    const request = compileOAAthPlanPermission({ plans: [await plan([2, 1])] });
    expect(request).toEqual({
      chainScope: "all",
      expiresIn: 1800,
      perChainOperationLimit: 1,
      permissions: [{ calls: [{ target: factory, selectors: ["0xabababab"], valueLimit: "0" }] }],
    });
    expect(Object.isFrozen(request.permissions[0]?.calls)).toBe(true);
    expect(() => compileOAAthPlanPermission({ plans: [{} as never] })).toThrow();
  });

  it("requests permission once, then reuses covered authority without prompting", async () => {
    const s = sdk();
    s.setActive(false);
    const p = await plan([1, 2]);
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plans: [p] })).toMatchObject({
      status: "requested",
    });
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plans: [p] })).toMatchObject({
      status: "reused",
    });
    expect(s.connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("unions heterogeneous plans deterministically and totals operations per chain", async () => {
    const plans = [await plan([1, 2]), await plan([2], undefined, 2)];
    const request = compileOAAthPlanPermission({ plans });
    expect(request.perChainOperationLimit).toBe(2);
    expect(request.permissions[0]?.calls).toEqual([
      { target: factory, selectors: ["0x00000000"], valueLimit: "0" },
      { target: factory, selectors: ["0xabababab"], valueLimit: "0" },
    ]);
    expect(compileOAAthPlanPermission({ plans: [...plans].reverse() })).toEqual(request);
    expect(compileOAAthPlanPermission({ plans, packing: "per-step" }).perChainOperationLimit).toBe(
      3,
    );
    expect(() => compileOAAthPlanPermission({ plans, perChainOperationLimit: 1 })).toThrow();
    const s = sdk();
    s.setActive(false);
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plans })).toMatchObject({
      status: "requested",
    });
    expect(s.connection.requestPermission).toHaveBeenCalledExactlyOnceWith(request);
    expect(s.grant.reviewCalls).toHaveBeenCalledTimes(3);
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("bounds plan collections and rejects duplicates and accessors without evaluating them", async () => {
    const p = await plan();
    const getter = vi.fn(() => p);
    const accessor = Object.defineProperty([p], "0", { get: getter });
    for (const plans of [[], [p, p], Array(33).fill(p), Array(1), accessor])
      expect(() => compileOAAthPlanPermission({ plans })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    const s = sdk();
    const input = Object.defineProperty({ plans: [p] }, "oaath", { get: getter });
    await expect(requestOAAthPlanPermission(input as never)).rejects.toMatchObject({
      code: "oaath_sdk_invalid",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
  });

  it("rejects incompatible fleet account requirements before requesting permission", async () => {
    const s = sdk();
    s.setActive(false);
    const first = await plan([1], { kind: "smart-account", accountId: "fleet", address });
    const otherId = await plan([2], { kind: "smart-account", accountId: "other", address });
    const otherAddress = await plan([2], {
      kind: "smart-account",
      accountId: "fleet",
      address: "0x1111111111111111111111111111111111111111",
    });
    for (const second of [otherId, otherAddress])
      await expect(
        requestOAAthPlanPermission({ oaath: s.oaath, plans: [first, second] }),
      ).rejects.toMatchObject({ code: "oaath_sender_incompatible" });
    await expect(
      requestOAAthPlanPermission({
        oaath: s.oaath,
        plans: [first],
        account: { address, accountId: "other" },
      }),
    ).rejects.toMatchObject({ code: "oaath_sender_incompatible" });
    expect(s.oaath.connect).not.toHaveBeenCalled();
  });

  it("retains an insufficient existing grant and binds every plan to one grant identity", async () => {
    const s = sdk();
    const plans = [await plan([1]), await plan([1], undefined, 2)];
    Object.assign(s.facts, { perChainOperationLimit: { count: 1, intervalSeconds: null } });
    await expect(requestOAAthPlanPermission({ oaath: s.oaath, plans })).rejects.toMatchObject({
      code: "oaath_review_unavailable",
    });
    Object.assign(s.facts, { perChainOperationLimit: { count: 10, intervalSeconds: null } });
    s.grant.reviewCalls.mockImplementation(async (input) => ({
      ...s.facts,
      grantId: input.calls.length === 1 ? "grant-a" : "grant-b",
      chainId: input.chain,
      calls: input.calls,
    }));
    await expect(requestOAAthPlanPermission({ oaath: s.oaath, plans })).rejects.toMatchObject({
      code: "oaath_review_changed",
    });
    expect(s.connection.close).toHaveBeenCalledTimes(2);
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("maps a logical fleet account through consent, execution, and retained-reference recovery", async () => {
    const s = sdk();
    const account = { address, accountId: "sra-kernel-v33" };
    const p = await plan([1], { kind: "smart-account", address, accountId: account.accountId });
    s.setActive(false);
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plans: [p], account })).toMatchObject(
      {
        status: "requested",
      },
    );
    const provider = createOAAthExecutionProvider({ oaath: s.oaath, account });
    const review = await provider.review({ plan: p, packing: "per-chain" });
    expect(review.chains[0]).toMatchObject({ accountId: account.accountId, sender: address });
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    const reference = await provider.submitBatch!({ prepared, operation });
    const recovered = createOAAthExecutionProvider({ oaath: s.oaath, account });
    expect(await recovered.observe({ reference })).toMatchObject({
      status: "finalized",
      finalized: { sender: address, calls: operation.steps.map((step) => step.call) },
    });
    expect(s.connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
  });

  it("invalidates logical account review when the SDK identity or explicit mapping changes", async () => {
    const s = sdk();
    const account = { address, accountId: "fleet" };
    const p = await plan([1], { kind: "smart-account", address, accountId: "fleet" });
    const provider = createOAAthExecutionProvider({ oaath: s.oaath, account });
    const review = await provider.review({ plan: p, packing: "per-chain" });
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    Object.assign(s.facts, { accountId: "changed-native-sdk-identity" });
    await expect(provider.prepare({ plan: p, packing: "per-chain", review })).rejects.toMatchObject(
      {
        code: "oaath_review_changed",
      },
    );
    await expect(
      provider.submitBatch!({
        prepared,
        operation: compileExecutionOperations(p, "per-chain")[0]!,
      }),
    ).rejects.toMatchObject({ code: "oaath_review_changed" });
    const changed = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { ...account, accountId: "other" },
    });
    expect(await changed.review({ plan: p, packing: "per-chain" })).toMatchObject({
      status: "blocked",
    });
    Object.assign(s.facts, { account: "0x1111111111111111111111111111111111111111" });
    expect(await provider.review({ plan: p, packing: "per-chain" })).toMatchObject({
      status: "blocked",
    });
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("review and prepare have no consent or submission effects", async () => {
    const s = sdk();
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const review = await provider.review({ packing: "per-step", plan: p });
    expect(review.status).toBe("supported");
    expect(review.chains[0]?.route).toMatch(/^oaath-session-erc4337-bundler:/);
    expect(review.chains[0]?.enforcement).toEqual(s.facts.enforcement);
    await provider.prepare({ packing: "per-step", plan: p, review });
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("blocks absent authority and mismatched sender without owner fallback", async () => {
    const s = sdk();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    s.setActive(false);
    expect((await provider.review({ packing: "per-step", plan: await plan() })).status).toBe(
      "blocked",
    );
    s.setActive(true);
    expect(
      (
        await provider.review({
          packing: "per-step",
          plan: await plan([1], { kind: "owner-eoa", address }),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await provider.review({
          packing: "per-step",
          plan: await plan([1], { kind: "smart-account", accountId: "other", address }),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await provider.review({
          packing: "per-step",
          plan: await plan([1], {
            kind: "smart-account",
            accountId: "account-a",
            address: "0x1111111111111111111111111111111111111111",
          }),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await provider.review({
          packing: "per-step",
          plan: await plan([1], {
            kind: "smart-account",
            accountId: "account-a",
            address,
          }),
        })
      ).status,
    ).toBe("supported");
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("accepts new account implementations and routes as opaque identity bound into review", async () => {
    const s = sdk();
    Object.assign(s.facts, {
      account: { address, implementation: "kernel:0.4.0" },
      route: "eip8141-frame",
      reasons: ["session_covers_calls", "route_available:eip8141-frame"],
    });
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const review = await provider.review({ packing: "per-step", plan: p });
    expect(review).toMatchObject({
      status: "supported",
      chains: [{ sender: address, route: expect.stringMatching(/^oaath-session-eip8141-frame:/) }],
      reasons: expect.arrayContaining([
        { code: "oaath_route_available:eip8141-frame", chainId: 1, stepId: null },
      ]),
    });
    Object.assign(s.facts, { account: { address, implementation: "kernel:0.4.1" } });
    await expect(provider.prepare({ packing: "per-step", plan: p, review })).rejects.toMatchObject({
      code: "oaath_review_changed",
    });
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it.each([
    ["an unsupported contract version", { version: "oaath-calls-review-v2" }],
    [
      "an unknown semantic enforcement",
      { enforcement: { calls: "onchain", expiry: "client", operationCount: "onchain" } },
    ],
    ["an unknown signer reason", { reasons: ["session_guessed"] }],
    ["an unbounded route identity", { route: "Bundler Route" }],
  ])("blocks %s before consent", async (_name, change) => {
    const s = sdk();
    Object.assign(s.facts, change);
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    expect(await provider.review({ packing: "per-step", plan: await plan() })).toMatchObject({
      status: "blocked",
      reasons: [{ code: "oaath_sdk_invalid" }],
    });
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("counts a windowed operation limit by its per-window count", async () => {
    const s = sdk();
    const p = await plan([1], undefined, 2);
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    Object.assign(s.facts, { perChainOperationLimit: { count: 2, intervalSeconds: 86_400 } });
    expect(await provider.review({ packing: "per-step", plan: p })).toMatchObject({
      status: "supported",
    });
    Object.assign(s.facts, { perChainOperationLimit: { count: 1, intervalSeconds: 86_400 } });
    expect(await provider.review({ packing: "per-step", plan: p })).toMatchObject({
      status: "blocked",
      reasons: [{ code: "oaath_review_unavailable" }],
    });
  });

  it("rejects unknown options and malformed payers at construction", () => {
    const s = sdk();
    for (const input of [
      { oaath: s.oaath, sender: "bundler" },
      { oaath: s.oaath, payer: { kind: "bundler" } },
      { oaath: s.oaath, payer: { kind: "connected-eoa" } },
    ])
      expect(() => createOAAthExecutionProvider(input as never)).toThrow(
        expect.objectContaining({ code: "oaath_input_invalid" }),
      );
  });

  it("forwards the configured payer unchanged to session review and send", async () => {
    const s = sdk();
    const payer = {
      kind: "paymaster-service",
      url: "https://paymaster.test",
      context: null,
    } as const;
    const provider = createOAAthExecutionProvider({ oaath: s.oaath, payer });
    const p = await plan();
    const review = await provider.review({ packing: "per-chain", plan: p });
    expect(s.grant.reviewCalls).toHaveBeenCalledWith(expect.objectContaining({ payer }));
    const prepared = await provider.prepare({ packing: "per-chain", plan: p, review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    await provider.submitBatch!({ prepared, operation });
    expect(s.grant.sendCalls).toHaveBeenCalledWith(expect.objectContaining({ payer }));
  });

  it.each(["grantId", "route", "perChainOperationLimit"] as const)(
    "invalidates review when %s changes",
    async (key) => {
      const s = sdk();
      const p = await plan();
      const provider = createOAAthExecutionProvider({ oaath: s.oaath });
      const review = await provider.review({ packing: "per-step", plan: p });
      Object.assign(s.facts, {
        [key]:
          key === "grantId"
            ? "grant-b"
            : key === "route"
              ? "erc4337-handleops"
              : { count: 11, intervalSeconds: null },
      });
      await expect(
        provider.prepare({ packing: "per-step", plan: p, review }),
      ).rejects.toMatchObject({
        code: "oaath_review_changed",
      });
      expect(s.grant.sendCalls).not.toHaveBeenCalled();
    },
  );

  it("rejects changed calls, forged prepared state and double submission", async () => {
    const s = sdk();
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const prepared = await provider.prepare({
      packing: "per-step",
      plan: p,
      review: await provider.review({ packing: "per-step", plan: p }),
    });
    const step = p.steps[0];
    if (!step) throw new Error("missing_step");
    const action = { planId: p.planId, chainId: 1, step };
    await expect(
      provider.submit({ prepared: { ...prepared, binding: {} }, action }),
    ).rejects.toThrow();
    await expect(
      provider.submit({
        prepared,
        action: { ...action, step: { ...step, call: { ...step.call, value: "1" } } },
      }),
    ).rejects.toThrow();
    const reference = await provider.submit({ prepared, action });
    expect(s.grant.sendCalls).toHaveBeenCalledWith({ chain: 1, calls: [step.call] });
    await expect(provider.submit({ prepared, action })).rejects.toThrow();
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
    const fresh = createOAAthExecutionProvider({ oaath: s.oaath });
    const observed = await fresh.observe({ reference });
    expect(observed).toMatchObject({
      status: "finalized",
      finalized: { calls: [step.call], providerEvidenceId: hash },
    });
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
    expect(s.grant.getOperation).toHaveBeenCalledWith({ chain: 1, id: hash });
    Object.assign(s.facts, { grantId: "other-grant" });
    expect(await fresh.observe({ reference })).toEqual({
      status: "unreadable",
      reason: "invalid-evidence",
    });
  });

  it("checks the accepted authority again before sending", async () => {
    const s = sdk();
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const prepared = await provider.prepare({
      packing: "per-step",
      plan: p,
      review: await provider.review({ packing: "per-step", plan: p }),
    });
    const step = p.steps[0];
    if (!step) throw new Error("missing_step");
    Object.assign(s.facts, { grantId: "different" });
    await expect(
      provider.submit({ prepared, action: { planId: p.planId, chainId: 1, step } }),
    ).rejects.toThrow();
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("sanitizes SDK failures and never replaces an uncovered Grant", async () => {
    const s = sdk();
    const p = await plan();
    s.grant.reviewCalls.mockRejectedValue(new Error("secret provider body"));
    const review = await createOAAthExecutionProvider({ oaath: s.oaath }).review({
      packing: "per-step",
      plan: p,
    });
    expect(review.status).toBe("blocked");
    expect(JSON.stringify(review)).not.toContain("secret");
    await expect(requestOAAthPlanPermission({ oaath: s.oaath, plans: [p] })).rejects.toMatchObject({
      code: "oaath_review_unavailable",
    });
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
  });

  it("rejects malformed SDK facts without running accessors", async () => {
    const s = sdk();
    const getter = vi.fn(() => address);
    s.grant.reviewCalls.mockImplementation(async (input) =>
      Object.defineProperty({ ...s.facts, chainId: input.chain, calls: input.calls }, "account", {
        get: getter,
      }),
    );
    expect(
      (
        await createOAAthExecutionProvider({ oaath: s.oaath }).review({
          packing: "per-step",
          plan: await plan(),
        })
      ).status,
    ).toBe("blocked");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["pending", "unreadable", "dropped", "superseded", "abandoned"])(
    "observes %s without sending or inventing finalized calls",
    async (status) => {
      const { s, provider, reference } = await submitted();
      s.operation.observe.mockResolvedValue({ status });
      const result = await provider.observe({ reference });
      expect(result.status).toBe(
        status === "pending" ? "pending" : status === "unreadable" ? "unreadable" : "failed",
      );
      expect(s.operation.execution).not.toHaveBeenCalled();
      expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
    },
  );

  it("projects actual SDK calls for Moesi's separate exact-call verification", async () => {
    const { s, provider, reference } = await submitted();
    const execution = await s.operation.execution();
    const actual = [{ target: address, data: "0x12345678" as const, value: "9" }];
    s.operation.execution.mockResolvedValue({ ...execution, calls: actual });
    expect(await provider.observe({ reference })).toMatchObject({
      status: "finalized",
      finalized: { calls: actual },
    });
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
  });

  it.each(["chainId", "id", "blockHash", "calls"])("rejects invalid finalized %s", async (key) => {
    const { s, provider, reference } = await submitted();
    const execution = await s.operation.execution();
    s.operation.execution.mockResolvedValue({
      ...execution,
      [key]: key === "chainId" ? 2 : key === "calls" ? [] : "0x00",
    });
    expect(await provider.observe({ reference })).toEqual({
      status: "unreadable",
      reason: "invalid-evidence",
    });
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
  });

  it("maps a reverted operation without treating containing-transaction success as convergence", async () => {
    const { s, provider, reference } = await submitted();
    const execution = await s.operation.execution();
    s.operation.execution.mockResolvedValue({ ...execution, outcome: "reverted" });
    expect(await provider.observe({ reference })).toEqual({
      status: "failed",
      reason: "oaath_reverted",
    });
  });

  it("blocks weakened enforcement and an impossible permission request before consent", async () => {
    const s = sdk();
    const p = await plan();
    Object.assign(s.facts, {
      enforcement: { calls: "not-enforced", expiry: "onchain", operationCount: "onchain" },
    });
    expect(
      (
        await createOAAthExecutionProvider({ oaath: s.oaath }).review({
          packing: "per-step",
          plan: p,
        })
      ).status,
    ).toBe("blocked");
    s.setActive(false);
    await expect(
      requestOAAthPlanPermission({
        oaath: s.oaath,
        plans: [await plan([1], { kind: "owner-eoa", address })],
      }),
    ).rejects.toMatchObject({ code: "oaath_sender_incompatible" });
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    for (const expiresIn of [0, 86401, Number.NaN])
      expect(() => compileOAAthPlanPermission({ plans: [p], expiresIn })).toThrow();
    expect(() => compileOAAthPlanPermission({ plans: [p], perChainOperationLimit: 0 })).toThrow();
  });

  it("retains an ambiguous send as attempted and scrubs the failure", async () => {
    const s = sdk();
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const prepared = await provider.prepare({
      packing: "per-step",
      plan: p,
      review: await provider.review({ packing: "per-step", plan: p }),
    });
    const step = p.steps[0];
    if (!step) throw new Error("missing_step");
    const action = { planId: p.planId, chainId: 1, step };
    s.grant.sendCalls.mockRejectedValue(new Error("secret raw request"));
    await expect(provider.submit({ prepared, action })).rejects.toMatchObject({
      code: "oaath_submission_failed",
      message: "oaath_submission_failed",
    });
    await expect(provider.submit({ prepared, action })).rejects.toMatchObject({
      code: "oaath_action_invalid",
    });
    expect(s.grant.sendCalls).toHaveBeenCalledTimes(1);
  });
});

async function submitted() {
  const s = sdk();
  const p = await plan();
  const provider = createOAAthExecutionProvider({ oaath: s.oaath });
  const prepared = await provider.prepare({
    packing: "per-step",
    plan: p,
    review: await provider.review({ packing: "per-step", plan: p }),
  });
  const step = p.steps[0];
  if (!step) throw new Error("missing_step");
  const reference = await provider.submit({
    prepared,
    action: { planId: p.planId, chainId: 1, step },
  });
  return { s, provider, reference };
}

function ownerSdk() {
  const session = sdk();
  const wallet = {
    ...createWalletClient({
      account: address,
      transport: custom({
        request: async () => {
          throw new Error("unexpected wallet request");
        },
      }),
    }),
    signMessage: vi.fn(async () => hash),
  };
  const facts: Omit<OaathOwnerCallsReview, "chainId" | "calls"> = {
    version: OAATH_CALLS_REVIEW_VERSION,
    validation: "estimated",
    enforcement: { calls: "none", expiry: "none", operationCount: "none" },
    account: { address, implementation: "kernel:0.3.3" },
    signer: "owner",
    route: "erc4337-bundler",
    reasons: ["owner_explicit", "route_available:erc4337-bundler"],
    fallback: {
      route: "erc4337-handleops",
      feePayer: address,
      condition: "conclusive_bundler_rejection",
    },
    paymasterService: null,
    capacity: {
      kind: "single-operation",
      detail: {
        callGasLimit: "100000",
        verificationGasLimit: "200000",
        preVerificationGas: "50000",
      },
    },
  };
  const handle = {
    reviewCalls: vi.fn(async (input: OaathSendCallsInput) => ({
      ...facts,
      chainId: input.chain,
      calls: input.calls,
    })),
    sendCalls: session.grant.sendCalls,
  };
  const account = { address, owner: vi.fn(() => handle), getOperation: session.grant.getOperation };
  const oaath = {
    account: vi.fn(() => account),
    close: vi.fn(async () => {}),
  } as unknown as OaathOwnerClient;
  return {
    ...session,
    oaath,
    wallet,
    facts,
    handle,
    account,
    sessionFacts: session.facts,
    session: session.oaath,
  };
}

describe("owner execution through the public SDK", () => {
  it("reviews owner fallback only after a conclusive session estimate and binds its Grant", async () => {
    const s = ownerSdk();
    Object.assign(s.sessionFacts, { validation: "account-rejected" });
    const p = await plan([1], undefined, 2);
    const provider = createOAAthExecutionProvider({
      oaath: { ...s.oaath, ...s.session },
      account: { address },
      owner: s.wallet,
    });
    const review = await provider.review({ plan: p, packing: "per-step" });
    expect(review).toMatchObject({
      status: "supported",
      chains: [{ signer: "owner", signerReason: "session-validation-failed" }],
    });
    expect(s.grant.reviewCalls).toHaveBeenCalledTimes(2);
    expect(s.grant.reviewCalls.mock.calls.every(([request]) => request.estimate === true)).toBe(
      true,
    );
    expect(s.handle.reviewCalls).toHaveBeenCalledTimes(2);
    expect(s.wallet.signMessage).not.toHaveBeenCalled();
    expect(s.handle.sendCalls).not.toHaveBeenCalled();
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    const prepared = await provider.prepare({ plan: p, packing: "per-step", review });
    const reference = await provider.submit({
      prepared,
      action: { planId: p.planId, chainId: 1, step: p.steps[0]! },
    });
    expect(reference.reference).toBe(`oaath-op-v3:owner:${address}:default:${hash}`);
    expect(s.handle.sendCalls).toHaveBeenCalledTimes(1);
    Object.assign(s.sessionFacts, { grantId: "replacement-grant" });
    await expect(provider.prepare({ plan: p, packing: "per-step", review })).rejects.toMatchObject({
      code: "oaath_review_changed",
    });
    expect(s.handle.sendCalls).toHaveBeenCalledTimes(1);
  });

  it.each([
    "unavailable",
    "missing-grant",
    "not-estimated",
    "explicit-session",
    "required-onchain",
  ])("does not choose owner after %s session evidence", async (failure) => {
    const s = ownerSdk();
    Object.assign(s.sessionFacts, { validation: "account-rejected" });
    if (failure === "unavailable")
      s.grant.reviewCalls.mockRejectedValue(new Error("AA23 private provider error"));
    if (failure === "missing-grant") s.setActive(false);
    if (failure === "not-estimated")
      s.grant.reviewCalls.mockImplementation(async (request) => ({
        ...s.sessionFacts,
        validation: "not-estimated",
        chainId: request.chain,
        calls: request.calls,
      }));
    const p = await plan(
      [1],
      undefined,
      2,
      failure === "required-onchain"
        ? { callScope: "required-onchain", expiry: "required", operationLimit: "required" }
        : undefined,
    );
    const provider = createOAAthExecutionProvider({
      oaath: { ...s.oaath, ...s.session },
      account: { address },
      owner: s.wallet,
      signer: failure === "explicit-session" ? "session" : "auto",
    });
    const review = await provider.review({ plan: p, packing: "per-step" });
    expect(review.status).toBe("blocked");
    expect(JSON.stringify(review)).not.toContain("private");
    expect(s.handle.reviewCalls).not.toHaveBeenCalled();
    expect(s.handle.sendCalls).not.toHaveBeenCalled();
    expect(s.wallet.signMessage).not.toHaveBeenCalled();
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
  });

  it.each(["estimated", "account-rejected"] as const)(
    "requires a new review when session validation changes from %s",
    async (validation) => {
      const s = ownerSdk();
      Object.assign(s.sessionFacts, { validation });
      const p = await plan([1], undefined, 2);
      const provider = createOAAthExecutionProvider({
        oaath: { ...s.oaath, ...s.session },
        account: { address },
        owner: s.wallet,
      });
      const review = await provider.review({ plan: p, packing: "per-step" });
      expect(review.status).toBe("supported");
      const prepared = await provider.prepare({ plan: p, packing: "per-step", review });
      Object.assign(s.sessionFacts, {
        validation: validation === "estimated" ? "account-rejected" : "estimated",
      });
      const action = { planId: p.planId, chainId: 1, step: p.steps[0]! };
      await expect(provider.submit({ prepared, action })).rejects.toMatchObject({
        code: "oaath_review_changed",
      });
      await expect(provider.submit({ prepared, action })).rejects.toMatchObject({
        code: "oaath_action_invalid",
      });
      expect(s.handle.sendCalls).not.toHaveBeenCalled();
      expect(s.wallet.signMessage).not.toHaveBeenCalled();
    },
  );

  it("estimates the complete chain once per review, selects owner, and recovers without a wallet", async () => {
    const s = ownerSdk();
    const p = await plan([1], { kind: "smart-account", address, accountId: address }, 3);
    const account = { address };
    const payer = { kind: "connected-eoa", wallet: s.wallet } as const;
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account,
      owner: s.wallet,
      payer,
    });
    const review = await provider.review({ plan: p, packing: "per-chain" });
    expect(review).toMatchObject({
      status: "supported",
      chains: [
        {
          sender: address,
          signer: "owner",
          signerReason: "plan-fits-one-operation",
          fallback: s.facts.fallback,
          enforcement: {
            calls: "interactive-owner",
            expiry: "not-enforced",
            operationCount: "not-enforced",
          },
        },
      ],
    });
    expect(s.handle.reviewCalls).toHaveBeenCalledExactlyOnceWith({
      chain: 1,
      calls: p.steps.map((step) => step.call),
      payer,
    });
    expect(s.wallet.signMessage).not.toHaveBeenCalled();
    expect(s.connection.resume).not.toHaveBeenCalled();
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    const reference = await provider.submitBatch!({ prepared, operation });
    expect(reference.reference).toBe(`oaath-op-v3:owner:${address}:default:${hash}`);
    await expect(provider.submitBatch!({ prepared, operation })).rejects.toMatchObject({
      code: "oaath_action_invalid",
    });
    expect(s.handle.sendCalls).toHaveBeenCalledTimes(1);
    const facts = await s.operation.execution();
    s.operation.execution.mockResolvedValue({ ...facts, route: "erc4337-handleops" });
    const recovered = createOAAthExecutionProvider({ oaath: s.oaath, account });
    expect(await recovered.observe({ reference })).toMatchObject({
      status: "finalized",
      finalized: {
        sender: address,
        calls: operation.steps.map((step) => step.call),
        submissionRoute: "erc4337-handleops",
      },
    });
    expect(s.account.owner).toHaveBeenCalledTimes(1);
    expect(s.handle.sendCalls).toHaveBeenCalledTimes(1);
    expect(s.connection.resume).not.toHaveBeenCalled();
  });

  it.each(["session", "per-step", "onchain"])(
    "uses the session when %s requires it",
    async (reason) => {
      const s = ownerSdk();
      const oaath = { ...s.oaath, ...s.session };
      const p = await plan(
        [1],
        undefined,
        2,
        reason === "onchain"
          ? { callScope: "required-onchain", expiry: "required", operationLimit: "required" }
          : undefined,
      );
      const provider = createOAAthExecutionProvider({
        oaath,
        account: { address },
        owner: s.wallet,
        signer: reason === "session" ? "session" : "auto",
      });
      expect(
        await provider.review({
          plan: p,
          packing: reason === "per-step" ? "per-step" : "per-chain",
        }),
      ).toMatchObject({ status: "supported", chains: [{ signer: "session" }] });
      expect(s.handle.reviewCalls).not.toHaveBeenCalled();
      expect(s.connection.resume).toHaveBeenCalled();
    },
  );

  it("blocks an unavailable estimate without a signature or implicit permission request", async () => {
    const s = ownerSdk();
    s.handle.reviewCalls.mockRejectedValue(new Error("private RPC error"));
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { address },
      owner: s.wallet,
    });
    const review = await provider.review({ plan: await plan(), packing: "per-chain" });
    expect(review).toMatchObject({
      status: "blocked",
      reasons: [{ code: "oaath_review_unavailable" }],
    });
    expect(JSON.stringify(review)).not.toContain("private");
    expect(s.handle.sendCalls).not.toHaveBeenCalled();
    expect(s.wallet.signMessage).not.toHaveBeenCalled();
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
  });

  it("binds the configured existing account when selecting a session", async () => {
    const s = ownerSdk();
    const facts = await s.grant.reviewCalls({ chain: 1, calls: [] });
    s.grant.reviewCalls.mockImplementation(async (request) => ({
      ...facts,
      account: { address: `0x${"55".repeat(20)}`, implementation: "kernel:0.3.3" },
      chainId: request.chain,
      calls: request.calls,
    }));
    const provider = createOAAthExecutionProvider({
      oaath: { ...s.oaath, ...s.session },
      account: { address },
      owner: s.wallet,
      signer: "session",
    });
    expect(await provider.review({ plan: await plan(), packing: "per-chain" })).toMatchObject({
      status: "blocked",
      reasons: [{ code: "oaath_sender_incompatible" }],
    });
    expect(s.handle.sendCalls).not.toHaveBeenCalled();
  });

  it("requires a new review when the fallback policy changes", async () => {
    const s = ownerSdk();
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { address },
      owner: s.wallet,
    });
    const p = await plan();
    const review = await provider.review({ plan: p, packing: "per-chain" });
    Object.assign(s.facts, { fallback: null });
    await expect(provider.prepare({ plan: p, packing: "per-chain", review })).rejects.toMatchObject(
      { code: "oaath_review_changed" },
    );
    expect(s.handle.sendCalls).not.toHaveBeenCalled();
  });

  it("leaves submission routing to OAAth when no payer is configured", async () => {
    const s = ownerSdk();
    Object.assign(s.facts, { fallback: null });
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { address },
      owner: s.wallet,
      signer: "owner",
    });
    const p = await plan();
    expect(await provider.review({ plan: p, packing: "per-chain" })).toMatchObject({
      status: "supported",
      chains: [{ signerReason: "owner-selected", fallback: null }],
    });
    expect(s.handle.reviewCalls).toHaveBeenCalledExactlyOnceWith({
      chain: 1,
      calls: p.steps.map((step) => step.call),
    });
  });

  it("does not treat an owner EOA requirement as a smart-account sender", async () => {
    const s = ownerSdk();
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { address },
      owner: s.wallet,
    });
    expect(
      await provider.review({
        plan: await plan([1], { kind: "owner-eoa", address }),
        packing: "per-chain",
      }),
    ).toMatchObject({ status: "blocked", reasons: [{ code: "oaath_sender_incompatible" }] });
    expect(s.handle.reviewCalls).not.toHaveBeenCalled();
  });

  it("rejects an explicit signer the client cannot provide at construction", () => {
    const s = ownerSdk();
    const account = { address };
    for (const input of [
      { oaath: s.oaath, account, owner: s.wallet, signer: "session" },
      { oaath: s.session, signer: "owner" },
      { oaath: s.oaath, signer: "owner" },
    ] as const)
      expect(() => createOAAthExecutionProvider(input)).toThrow(
        expect.objectContaining({ code: "oaath_input_invalid" }),
      );
    // Wallet-less owner configuration stays valid for recovery-only observation.
    expect(() =>
      createOAAthExecutionProvider({ oaath: s.oaath, account, signer: "owner" }),
    ).not.toThrow();
    expect(() => createOAAthExecutionProvider({ oaath: s.oaath, account })).not.toThrow();
  });

  it("rejects unknown account binding fields as caller input", () => {
    const s = ownerSdk();
    const getter = vi.fn(() => address);
    for (const account of [
      { kind: "existing", address },
      Object.defineProperty({}, "address", { enumerable: true, get: getter }),
      [address],
    ])
      expect(() => createOAAthExecutionProvider({ oaath: s.oaath, account } as never)).toThrow(
        expect.objectContaining({ code: "oaath_input_invalid" }),
      );
    expect(getter).not.toHaveBeenCalled();
  });

  it("refuses replaying an owner reference against a different configured account", async () => {
    const s = ownerSdk();
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { address },
    });
    expect(
      await provider.observe({
        reference: {
          providerId: "oaath",
          chainId: 1,
          reference: `oaath-op-v3:owner:0x${"55".repeat(20)}:default:${hash}`,
        },
      }),
    ).toEqual({ status: "unreadable", reason: "invalid-evidence" });
    expect(s.account.getOperation).not.toHaveBeenCalled();
  });
});
