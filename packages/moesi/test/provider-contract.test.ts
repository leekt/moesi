import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type {
  DeploymentRun,
  ExecutionProviderReview,
  ManifestSender,
  MoesiExecutionProvider,
  MoesiObservationAdapter,
  PlanEnforcement,
  ReviewedPlan,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  createMoesi,
  MemoryDeploymentRunStore,
  MoesiExecutionError,
  reviewPlan,
} from "../src/index.js";
import { missingPlanDraft, testManifest } from "./fixtures.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE = "0x6000" as const;
const FACTORY_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;

function plan(
  input: {
    readonly callData?: `0x${string}`;
    readonly sender?: ManifestSender | null;
    readonly enforcement?: PlanEnforcement;
  } = {},
): ReviewedPlan {
  const manifest = testManifest({
    initCode: input.callData === "0x22222222" ? "0x60016000" : "0x60006000",
    runtimeHash: keccak256(CODE),
    ...(input.sender === undefined || input.sender === null ? {} : { sender: input.sender }),
    ...(input.enforcement === undefined ? {} : { enforcement: input.enforcement }),
  });
  return reviewPlan(missingPlanDraft({ manifest }));
}

function observer(): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "2", blockHash: hash("2") };
    },
    async readCode({ address: target }) {
      return target === CREATE2_FACTORY_V1_ADDRESS ? FACTORY_CODE : CODE;
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

const supportedReview = (providerId = "fake"): ExecutionProviderReview => ({
  providerId,
  status: "supported",
  chains: [
    {
      chainId: 1,
      sender: address("a"),
      accountId: null,
      route: "fake-direct",
      signer: "owner" as const,
      signerReason: "caller-supplied-eoa",
      enforcement: {
        calls: "interactive-owner",
        expiry: "not-enforced",
        operationCount: "not-enforced",
      },
    },
  ],
  reasons: [],
});

function provider(overrides: Partial<MoesiExecutionProvider> = {}): MoesiExecutionProvider {
  return Object.freeze({
    id: "fake",
    async review() {
      return supportedReview();
    },
    async prepare({ plan: reviewed }: Parameters<MoesiExecutionProvider["prepare"]>[0]) {
      return { providerId: "fake", planId: reviewed.planId, binding: {} };
    },
    async submit({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) {
      return { providerId: "fake", chainId: action.chainId, reference: hash("8") };
    },
    async observe() {
      return {
        status: "finalized" as const,
        finalized: {
          chainId: 1,
          sender: address("a"),
          calls: [plan().steps[0]!.call],
          providerEvidenceId: hash("8"),
          blockNumber: "2",
          blockHash: hash("2"),
        },
      };
    },
    ...overrides,
  });
}

describe("execution provider boundary", () => {
  it("binds the accepted provider review to the exact plan", async () => {
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const first = plan();
    const second = plan({ callData: "0x22222222" });
    const selected = provider();
    const executionReview = await moesi.reviewExecution({ plan: first, provider: selected });

    expect(executionReview).toMatchObject({
      version: "moesi.execution-review/v2",
      planId: first.planId,
      provider: { providerId: "fake", status: "supported" },
    });
    expect(Object.isFrozen(executionReview)).toBe(true);
    expect(() => moesi.apply({ plan: second, provider: selected, executionReview })).toThrowError(
      expect.objectContaining({ code: "plan_mismatch" } satisfies Partial<MoesiExecutionError>),
    );
  });

  it("maps thrown and malformed provider reviews to stable Moesi errors", async () => {
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const reviewed = plan();
    await expect(
      moesi.reviewExecution({
        plan: reviewed,
        provider: provider({
          async review() {
            throw new Error("raw provider secret");
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_review_failed" });

    await expect(
      moesi.reviewExecution({
        plan: reviewed,
        provider: provider({
          async review() {
            return { providerId: "fake", status: "supported" } as never;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_review_invalid" });

    await expect(
      moesi.reviewExecution({
        plan: reviewed,
        provider: provider({
          async review() {
            const review = supportedReview();
            return {
              ...review,
              chains: review.chains.map((chain) => ({
                ...chain,
                route: "https://user:secret@example.test",
              })),
            };
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_review_invalid" });
  });

  it("scrubs hostile provider capability getters", async () => {
    const hostile = Object.defineProperties(
      {
        review: async () => supportedReview(),
        prepare: async () => ({}),
        submit: async () => ({}),
        observe: async () => ({}),
      },
      {
        id: {
          enumerable: true,
          get() {
            throw new Error("raw provider secret");
          },
        },
      },
    ) as unknown as MoesiExecutionProvider;

    await expect(
      createMoesi({
        observer: observer(),
        runStore: new MemoryDeploymentRunStore(),
      }).reviewExecution({ plan: plan(), provider: hostile }),
    ).rejects.toMatchObject({
      code: "provider_invalid",
      message: "execution provider is invalid",
    });
  });

  it("snapshots provider capabilities instead of re-reading stateful getters", async () => {
    let idReads = 0;
    const stateful = Object.defineProperty(
      {
        async review() {
          return supportedReview();
        },
        async prepare() {
          return {};
        },
        async submit() {
          return {};
        },
        async observe() {
          return {};
        },
      },
      "id",
      {
        enumerable: true,
        get() {
          idReads += 1;
          if (idReads > 1) throw new Error("raw provider secret");
          return "fake";
        },
      },
    ) as unknown as MoesiExecutionProvider;

    await expect(
      createMoesi({
        observer: observer(),
        runStore: new MemoryDeploymentRunStore(),
      }).reviewExecution({ plan: plan(), provider: stateful }),
    ).resolves.toMatchObject({ provider: { providerId: "fake" } });
    expect(idReads).toBe(1);
  });

  it("rejects sparse provider review arrays", async () => {
    await expect(
      createMoesi({
        observer: observer(),
        runStore: new MemoryDeploymentRunStore(),
      }).reviewExecution({
        plan: plan(),
        provider: provider({
          async review() {
            return {
              ...supportedReview(),
              status: "blocked",
              reasons: new Array(1),
            } as never;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_review_invalid" });
  });

  it("snapshots each provider review field before validating it", async () => {
    const base = supportedReview().chains[0]!;
    let routeReads = 0;
    const chain = Object.defineProperty({ ...base }, "route", {
      enumerable: true,
      get() {
        routeReads += 1;
        return routeReads <= 2 ? "fake-direct" : "https://user:secret@example.test";
      },
    });
    const executionReview = await createMoesi({
      observer: observer(),
      runStore: new MemoryDeploymentRunStore(),
    }).reviewExecution({
      plan: plan(),
      provider: provider({
        async review() {
          return { ...supportedReview(), chains: [chain] } as ExecutionProviderReview;
        },
      }),
    });

    expect(routeReads).toBe(1);
    expect(executionReview.provider.chains[0]?.route).toBe("fake-direct");
    expect(JSON.stringify(executionReview)).not.toContain("secret");
  });

  it("does not dispatch through provider-owned array methods", async () => {
    const valid = supportedReview().chains[0]!;
    const chains = [{ ...valid, route: "invalid/route" }];
    Object.defineProperty(chains, "map", {
      value: () => [valid],
    });

    await expect(
      createMoesi({
        observer: observer(),
        runStore: new MemoryDeploymentRunStore(),
      }).reviewExecution({
        plan: plan(),
        provider: provider({
          async review() {
            return { ...supportedReview(), chains } as ExecutionProviderReview;
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_review_invalid" });
  });

  it("rejects a review emitted for another provider id", async () => {
    await expect(
      createMoesi({
        observer: observer(),
        runStore: new MemoryDeploymentRunStore(),
      }).reviewExecution({
        plan: plan(),
        provider: provider({
          async review() {
            return supportedReview("other");
          },
        }),
      }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
  });

  it("binds an accepted review to the exact provider instance, not only its id", async () => {
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const original = provider();
    const replacementPrepare = vi.fn();
    const replacement = provider({ prepare: replacementPrepare as never });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: original });

    expect(() =>
      moesi.apply({ plan: reviewed, provider: replacement, executionReview }),
    ).toThrowError(
      expect.objectContaining({ code: "provider_mismatch" } satisfies Partial<MoesiExecutionError>),
    );
    expect(replacementPrepare).not.toHaveBeenCalled();
  });

  it("snapshots the apply request before checking review-instance binding", async () => {
    let providerReviewCount = 0;
    const submit = vi.fn(async () => ({ providerId: "fake", chainId: 1, reference: hash("8") }));
    const selected = provider({
      async review() {
        providerReviewCount += 1;
        const review = supportedReview();
        return providerReviewCount === 1
          ? review
          : {
              ...review,
              chains: review.chains.map((chain) => ({ ...chain, route: "changed-route" })),
            };
      },
      submit,
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const accepted = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const forged = structuredClone(accepted) as Mutable<typeof accepted>;
    forged.provider.chains[0]!.route = "changed-route";
    let executionReviewReads = 0;
    const request = Object.defineProperty(
      { plan: reviewed, provider: selected },
      "executionReview",
      {
        enumerable: true,
        get() {
          executionReviewReads += 1;
          return executionReviewReads === 1 ? accepted : forged;
        },
      },
    );
    const run = moesi.apply(request as never);

    await expect(run.wait()).rejects.toMatchObject({ code: "provider_mismatch" });
    expect(executionReviewReads).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it("blocks a compatibility mismatch even when the provider pre-seeds the same reason", async () => {
    const reviewed = plan({
      sender: { kind: "owner-eoa", address: address("b") },
    });
    const executionReview = await createMoesi({
      observer: observer(),
      runStore: new MemoryDeploymentRunStore(),
    }).reviewExecution({
      plan: reviewed,
      provider: provider({
        async review() {
          return {
            ...supportedReview(),
            reasons: [{ code: "review-sender-mismatch", chainId: 1, stepId: null }],
          };
        },
      }),
    });

    expect(executionReview.provider.status).toBe("blocked");
    expect(executionReview.provider.reasons).toEqual([
      { code: "review-sender-mismatch", chainId: 1, stepId: null },
    ]);
  });

  it("blocks a provider review that contradicts sender or enforcement requirements", async () => {
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const selected = provider();
    const reviewed = plan({
      sender: { kind: "owner-eoa", address: address("b") },
      enforcement: {
        callScope: "required-onchain",
        expiry: "required",
        operationLimit: "required",
      },
    });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });

    expect(executionReview.provider.status).toBe("blocked");
    expect(executionReview.provider.reasons.map(({ code }) => code)).toEqual([
      "review-sender-mismatch",
      "review-call-enforcement-insufficient",
      "review-expiry-enforcement-insufficient",
      "review-operation-count-enforcement-insufficient",
    ]);
    expect(() => moesi.apply({ plan: reviewed, provider: selected, executionReview })).toThrowError(
      expect.objectContaining({
        code: "provider_review_blocked",
      } satisfies Partial<MoesiExecutionError>),
    );
  });

  it("binds a logical smart-account requirement to the reviewed account id", async () => {
    const reviewed = plan({
      sender: { kind: "smart-account", accountId: "kernel:ops", address: address("a") },
    });
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const mismatch = await moesi.reviewExecution({ plan: reviewed, provider: provider() });
    expect(mismatch.provider.status).toBe("blocked");
    expect(mismatch.provider.reasons.map(({ code }) => code)).toContain("review-account-mismatch");

    const selected = provider({
      async review() {
        const review = supportedReview();
        return {
          ...review,
          chains: review.chains.map((chain) => ({ ...chain, accountId: "kernel:ops" })),
        };
      },
    });
    const accepted = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    expect(accepted.provider.status).toBe("supported");
  });

  it("keeps compatibility-blocked reviews within the codec reason bound", async () => {
    const reviewed = plan({
      sender: { kind: "owner-eoa", address: address("b") },
    });
    const selected = provider({
      async review() {
        return {
          ...supportedReview(),
          reasons: Array.from({ length: 512 }, (_, index) => ({
            code: `note-${index}`,
            chainId: 1,
            stepId: null,
          })),
        };
      },
    });
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });

    expect(executionReview.provider.status).toBe("blocked");
    expect(executionReview.provider.reasons).toHaveLength(512);
    expect(() => moesi.apply({ plan: reviewed, provider: selected, executionReview })).toThrowError(
      expect.objectContaining({
        code: "provider_review_blocked",
      } satisfies Partial<MoesiExecutionError>),
    );
  });

  it("requires onchain expiry and operation-count enforcement, not runtime checks", async () => {
    const reviewed = plan({
      enforcement: {
        callScope: "required-onchain",
        expiry: "required",
        operationLimit: "required",
      },
    });
    const executionReview = await createMoesi({
      observer: observer(),
      runStore: new MemoryDeploymentRunStore(),
    }).reviewExecution({
      plan: reviewed,
      provider: provider({
        async review() {
          return {
            ...supportedReview(),
            chains: supportedReview().chains.map((chain) => ({
              ...chain,
              enforcement: {
                calls: "onchain",
                expiry: "runtime",
                operationCount: "runtime",
              },
            })),
          };
        },
      }),
    });

    expect(executionReview.provider.status).toBe("blocked");
    expect(executionReview.provider.reasons.map(({ code }) => code)).toEqual([
      "review-expiry-enforcement-insufficient",
      "review-operation-count-enforcement-insufficient",
    ]);
  });

  it("re-reviews the same provider before prepare and rejects a changed decision", async () => {
    let reviewCount = 0;
    const prepare = vi.fn();
    const selected = provider({
      async review() {
        reviewCount += 1;
        if (reviewCount === 1) return supportedReview();
        const changed = supportedReview();
        return {
          ...changed,
          chains: changed.chains.map((chain) => ({ ...chain, sender: address("b") })),
        };
      },
      prepare: prepare as never,
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const run = moesi.apply({ plan: reviewed, provider: selected, executionReview });

    await expect(run.wait()).rejects.toMatchObject({ code: "provider_mismatch" });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("executes one reviewed action once and verifies provider and convergence evidence", async () => {
    const submit = vi.fn(async ({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) => ({
      providerId: "fake",
      chainId: action.chainId,
      reference: hash("8"),
    }));
    const selected = provider({ submit });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const run = moesi.apply({
      plan: reviewed,
      provider: selected,
      executionReview,
      observeTiming: { attempts: 1, delayMs: 0 },
    });

    const firstWait = run.wait();
    expect(run.state).toBe("running");
    const result = await firstWait;
    expect(await run.wait()).toBe(result);
    expect(run.state).toBe("complete");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("converged");
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      providerId: "fake",
      operations: [
        {
          operationId: "counter:deploy",
          stepIds: ["counter:deploy"],
          reference: { providerId: "fake", chainId: 1, reference: hash("8") },
          providerEvidence: { providerEvidenceId: hash("8") },
        },
      ],
    });
  });

  it("remains at-most-once when provider review reenters wait synchronously", async () => {
    let reviewCount = 0;
    let run: DeploymentRun | undefined;
    let reentrantWait: Promise<unknown> | undefined;
    const submit = vi.fn(async ({ action }: Parameters<MoesiExecutionProvider["submit"]>[0]) => ({
      providerId: "fake",
      chainId: action.chainId,
      reference: hash("8"),
    }));
    const selected = provider({
      async review() {
        reviewCount += 1;
        if (reviewCount === 2 && run) reentrantWait = run.wait();
        return supportedReview();
      },
      submit,
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    run = moesi.apply({ plan: reviewed, provider: selected, executionReview });

    const result = await run.wait();
    expect(await reentrantWait).toBe(result);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("retains an unresolved submitted reference and never resubmits on repeated wait", async () => {
    const submit = vi.fn(async () => ({
      providerId: "fake",
      chainId: 1,
      reference: hash("9"),
    }));
    const observe = vi.fn(async () => ({ status: "pending" as const }));
    const selected = provider({ submit, observe });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const run = moesi.apply({
      plan: reviewed,
      provider: selected,
      executionReview,
      observeTiming: { attempts: 2, delayMs: 0 },
    });

    const result = await run.wait();
    await run.wait();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
    expect(result.chains[0]?.execution).toEqual({
      kind: "failed",
      providerId: "fake",
      reason: "execution-unresolved",
      operations: [
        {
          operationId: "counter:deploy",
          stepIds: ["counter:deploy"],
          reference: { providerId: "fake", chainId: 1, reference: hash("9") },
          providerEvidence: null,
        },
      ],
    });
  });

  it("snapshots provider references before validation and retention", async () => {
    let referenceReads = 0;
    const selected = provider({
      async submit() {
        return Object.defineProperty({ providerId: "fake", chainId: 1 }, "reference", {
          enumerable: true,
          get() {
            referenceReads += 1;
            return referenceReads <= 2 ? "safe-ref" : "https://user:secret@example.test";
          },
        }) as never;
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(referenceReads).toBe(1);
    expect(result.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      operations: [{ reference: { reference: "safe-ref" } }],
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("retains the submitted reference when hostile evidence access throws", async () => {
    const selected = provider({
      async observe() {
        return Object.defineProperty({}, "status", {
          enumerable: true,
          get() {
            throw new Error("raw provider secret");
          },
        }) as never;
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toEqual({
      kind: "failed",
      providerId: "fake",
      reason: "invalid-evidence",
      operations: [
        {
          operationId: "counter:deploy",
          stepIds: ["counter:deploy"],
          reference: { providerId: "fake", chainId: 1, reference: hash("8") },
          providerEvidence: null,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("raw provider secret");
  });

  it("rejects finalized evidence without an inclusion block hash", async () => {
    const selected = provider({
      async observe() {
        const finalized = {
          chainId: 1,
          sender: address("a"),
          calls: [plan().steps[0]!.call],
          providerEvidenceId: hash("8"),
          blockNumber: "2",
        };
        return { status: "finalized", finalized } as never;
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "invalid-evidence",
    });
  });

  it("rejects finalized evidence that predates the reviewed snapshot", async () => {
    const selected = provider({
      async observe() {
        return {
          status: "finalized",
          finalized: {
            chainId: 1,
            sender: address("a"),
            calls: [plan().steps[0]!.call],
            providerEvidenceId: hash("8"),
            blockNumber: "1",
            blockHash: hash("1"),
          },
        };
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const result = await moesi
      .apply({
        plan: reviewed,
        provider: selected,
        executionReview,
        observeTiming: { attempts: 1, delayMs: 0 },
      })
      .wait();

    expect(result.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "invalid-evidence",
      operations: [{ reference: { reference: hash("8") }, providerEvidence: { blockNumber: "1" } }],
    });
  });

  it("marks a rejected preparation as complete without retaining raw failure details", async () => {
    const selected = provider({
      async prepare() {
        throw new MoesiExecutionError("provider_mismatch", "raw wallet secret");
      },
    });
    const reviewed = plan();
    const moesi = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const executionReview = await moesi.reviewExecution({ plan: reviewed, provider: selected });
    const run = moesi.apply({ plan: reviewed, provider: selected, executionReview });

    await expect(run.wait()).rejects.toMatchObject({
      code: "provider_prepare_failed",
      message: "provider prepare failed",
    });
    expect(run.state).toBe("complete");
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
