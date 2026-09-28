import type {
  Oaath,
  OaathCallsReview,
  OaathOwnerCallsReview,
  OaathOwnerClient,
  OaathReviewCallsInput,
  OaathSendCallsInput,
} from "@oaath/sdk";
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
    validation: "not-estimated",
    grantId: "grant-a",
    accountId: "account-a",
    account: address,
    signer: "session",
    fallback: null,
    paymasterService: null,
    enableVerificationGasFloor: null,
    route: "bundler",
    reasons: ["session_covers_calls", "bundler_available"],
    enforcement: { calls: "onchain", expiry: "onchain", operationCount: "onchain" },
    expiresAt: 2_000_000,
    validAfter: 1,
    validUntil: 2_000,
    perChainOperationLimit: 10,
  } as Omit<OaathCallsReview, "chainId" | "calls">;
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
      route: "bundler",
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
  it("reviews and sends the complete chain batch under a one-operation grant", async () => {
    const s = sdk();
    const p = await plan([1], undefined, 3);
    Object.assign(s.facts, { perChainOperationLimit: 1 });
    expect(compileOAAthPlanPermission({ plan: p }).perChainOperationLimit).toBe(1);
    expect(
      compileOAAthPlanPermission({ plan: p, packing: "per-step" }).perChainOperationLimit,
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
    const request = compileOAAthPlanPermission({ plan: await plan([2, 1]) });
    expect(request).toEqual({
      chainScope: "all",
      expiresIn: 1800,
      perChainOperationLimit: 1,
      permissions: [{ calls: [{ target: factory, selectors: ["0xabababab"], valueLimit: "0" }] }],
    });
    expect(Object.isFrozen(request.permissions[0]?.calls)).toBe(true);
    expect(() => compileOAAthPlanPermission({ plan: {} as never })).toThrow();
  });

  it("requests permission once, then reuses covered authority without prompting", async () => {
    const s = sdk();
    s.setActive(false);
    const p = await plan([1, 2]);
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plan: p })).toMatchObject({
      status: "requested",
    });
    expect(await requestOAAthPlanPermission({ oaath: s.oaath, plan: p })).toMatchObject({
      status: "reused",
    });
    expect(s.connection.requestPermission).toHaveBeenCalledTimes(1);
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("review and prepare have no consent or submission effects", async () => {
    const s = sdk();
    const p = await plan();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    const review = await provider.review({ packing: "per-step", plan: p });
    expect(review.status).toBe("supported");
    expect(review.chains[0]?.route).toMatch(/^oaath-session-bundler:/);
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

  it.each(["grantId", "route", "perChainOperationLimit"] as const)(
    "invalidates review when %s changes",
    async (key) => {
      const s = sdk();
      const p = await plan();
      const provider = createOAAthExecutionProvider({ oaath: s.oaath });
      const review = await provider.review({ packing: "per-step", plan: p });
      Object.assign(s.facts, {
        [key]: key === "grantId" ? "grant-b" : key === "route" ? "entrypoint-handleops" : 11,
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
    await expect(requestOAAthPlanPermission({ oaath: s.oaath, plan: p })).rejects.toMatchObject({
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
        plan: await plan([1], { kind: "owner-eoa", address }),
      }),
    ).rejects.toMatchObject({ code: "oaath_sender_incompatible" });
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    for (const expiresIn of [0, 86401, Number.NaN])
      expect(() => compileOAAthPlanPermission({ plan: p, expiresIn })).toThrow();
    expect(() => compileOAAthPlanPermission({ plan: p, perChainOperationLimit: 0 })).toThrow();
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
    account: address,
    kernelVersion: "0.3.3",
    signer: "owner",
    route: "bundler",
    reasons: ["owner_explicit", "bundler_available"],
    fallback: {
      route: "entrypoint-handleops",
      feePayer: address,
      condition: "conclusive_bundler_rejection",
    },
    paymasterService: null,
    capacity: {
      kind: "single-operation",
      gas: { callGasLimit: "100000", verificationGasLimit: "200000", preVerificationGas: "50000" },
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
      account: { kind: "existing", address },
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
    expect(reference.reference).toBe(`oaath-op-v2:owner:${address}:${hash}`);
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
      account: { kind: "existing", address },
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
        account: { kind: "existing", address },
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
    const account = { kind: "existing" as const, address };
    const provider = createOAAthExecutionProvider({ oaath: s.oaath, account, owner: s.wallet });
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
      feePayer: { kind: "connected-eoa", wallet: s.wallet },
    });
    expect(s.wallet.signMessage).not.toHaveBeenCalled();
    expect(s.connection.resume).not.toHaveBeenCalled();
    const prepared = await provider.prepare({ plan: p, packing: "per-chain", review });
    const operation = compileExecutionOperations(p, "per-chain")[0]!;
    const reference = await provider.submitBatch!({ prepared, operation });
    expect(reference.reference).toBe(`oaath-op-v2:owner:${address}:${hash}`);
    await expect(provider.submitBatch!({ prepared, operation })).rejects.toMatchObject({
      code: "oaath_action_invalid",
    });
    expect(s.handle.sendCalls).toHaveBeenCalledTimes(1);
    const facts = await s.operation.execution();
    s.operation.execution.mockResolvedValue({ ...facts, route: "entrypoint-handleops" });
    const recovered = createOAAthExecutionProvider({ oaath: s.oaath, account });
    expect(await recovered.observe({ reference })).toMatchObject({
      status: "finalized",
      finalized: {
        sender: address,
        calls: operation.steps.map((step) => step.call),
        submissionRoute: "entrypoint-handleops",
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
        account: { kind: "existing", address },
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
      account: { kind: "existing", address },
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
      account: `0x${"55".repeat(20)}`,
      chainId: request.chain,
      calls: request.calls,
    }));
    const provider = createOAAthExecutionProvider({
      oaath: { ...s.oaath, ...s.session },
      account: { kind: "existing", address },
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
      account: { kind: "existing", address },
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

  it("keeps bundler-only selection explicit", async () => {
    const s = ownerSdk();
    Object.assign(s.facts, { fallback: null });
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { kind: "existing", address },
      owner: s.wallet,
      signer: "owner",
      sender: "bundler",
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
      account: { kind: "existing", address },
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

  it("refuses replaying an owner reference against a different configured account", async () => {
    const s = ownerSdk();
    const provider = createOAAthExecutionProvider({
      oaath: s.oaath,
      account: { kind: "existing", address },
    });
    expect(
      await provider.observe({
        reference: {
          providerId: "oaath",
          chainId: 1,
          reference: `oaath-op-v2:owner:0x${"55".repeat(20)}:${hash}`,
        },
      }),
    ).toEqual({ status: "unreadable", reason: "invalid-evidence" });
    expect(s.account.getOperation).not.toHaveBeenCalled();
  });
});
