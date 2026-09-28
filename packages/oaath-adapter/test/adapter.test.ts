import type { Oaath, OaathCallsReview, OaathSendCallsInput } from "@oaath/sdk";
import { createMoesi, type ManifestSender } from "moesi";
import { keccak256 } from "viem";
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

async function plan(chains = [1], sender?: ManifestSender) {
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
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: hash,
            initCode: "0x6002600c60003960026000f36000",
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(runtime),
          checks: [],
          storageChecks: [],
          configuration: [],
          ...(sender ? { sender } : {}),
        },
      ],
    },
  });
}

function sdk() {
  const facts = {
    grantId: "grant-a",
    accountId: "account-a",
    account: address,
    signer: "session",
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
    })),
  };
  const grant = {
    reviewCalls: vi.fn(async (input: OaathSendCallsInput) => ({
      ...facts,
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
    const review = await provider.review({ plan: p });
    expect(review.status).toBe("supported");
    expect(review.chains[0]?.route).toMatch(/^oaath-session-bundler:/);
    expect(review.chains[0]?.enforcement).toEqual(s.facts.enforcement);
    await provider.prepare({ plan: p, review });
    expect(s.connection.requestPermission).not.toHaveBeenCalled();
    expect(s.grant.sendCalls).not.toHaveBeenCalled();
  });

  it("blocks absent authority and mismatched sender without owner fallback", async () => {
    const s = sdk();
    const provider = createOAAthExecutionProvider({ oaath: s.oaath });
    s.setActive(false);
    expect((await provider.review({ plan: await plan() })).status).toBe("blocked");
    s.setActive(true);
    expect(
      (await provider.review({ plan: await plan([1], { kind: "owner-eoa", address }) })).status,
    ).toBe("blocked");
    expect(
      (
        await provider.review({
          plan: await plan([1], { kind: "smart-account", accountId: "other", address }),
        })
      ).status,
    ).toBe("blocked");
    expect(
      (
        await provider.review({
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
      const review = await provider.review({ plan: p });
      Object.assign(s.facts, {
        [key]: key === "grantId" ? "grant-b" : key === "route" ? "entrypoint-handleops" : 11,
      });
      await expect(provider.prepare({ plan: p, review })).rejects.toMatchObject({
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
      plan: p,
      review: await provider.review({ plan: p }),
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
      plan: p,
      review: await provider.review({ plan: p }),
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
    const review = await createOAAthExecutionProvider({ oaath: s.oaath }).review({ plan: p });
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
      (await createOAAthExecutionProvider({ oaath: s.oaath }).review({ plan: await plan() }))
        .status,
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
      (await createOAAthExecutionProvider({ oaath: s.oaath }).review({ plan: p })).status,
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
      plan: p,
      review: await provider.review({ plan: p }),
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
  const prepared = await provider.prepare({ plan: p, review: await provider.review({ plan: p }) });
  const step = p.steps[0];
  if (!step) throw new Error("missing_step");
  const reference = await provider.submit({
    prepared,
    action: { planId: p.planId, chainId: 1, step },
  });
  return { s, provider, reference };
}
