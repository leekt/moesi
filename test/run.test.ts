import { type Address, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type {
  ExecuteReviewedChainInput,
  MoesiObservationAdapter,
  ReviewedPlan,
} from "../src/index.js";
import { createDeploymentRun, MoesiPlanError, reviewPlan } from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const CODE_A = "0x6000" as const;
const CODE_B = "0x6001" as const;

function missingPlan(): ReviewedPlan {
  return reviewPlan({
    manifestHash: hash("a"),
    snapshots: [{ chainId: 1, blockNumber: 1n, blockHash: hash("1") }],
    cells: [
      {
        resourceId: "alpha",
        chainId: 1,
        address: address("1"),
        expectedRuntimeCodeHash: keccak256(CODE_A),
        configuration: [],
        status: { kind: "missing" },
      },
      {
        resourceId: "beta",
        chainId: 1,
        address: address("2"),
        expectedRuntimeCodeHash: keccak256(CODE_B),
        configuration: [],
        status: { kind: "missing" },
      },
    ],
    steps: [
      {
        id: "alpha:deploy",
        resourceId: "alpha",
        chainId: 1,
        kind: "deploy",
        configurationId: null,
        drift: "missing",
        call: { target: address("a"), data: "0x11111111", value: 0n },
        postconditions: [
          {
            kind: "runtime-code-hash",
            address: address("1"),
            expectedHash: keccak256(CODE_A),
          },
        ],
      },
      {
        id: "beta:deploy",
        resourceId: "beta",
        chainId: 1,
        kind: "deploy",
        configurationId: null,
        drift: "missing",
        call: { target: address("a"), data: "0x22222222", value: 0n },
        postconditions: [
          {
            kind: "runtime-code-hash",
            address: address("2"),
            expectedHash: keccak256(CODE_B),
          },
        ],
      },
    ],
  });
}

function twoChainPlan(): ReviewedPlan {
  return reviewPlan({
    manifestHash: hash("b"),
    snapshots: [
      { chainId: 1, blockNumber: 1n, blockHash: hash("1") },
      { chainId: 10, blockNumber: 2n, blockHash: hash("2") },
    ],
    cells: [
      {
        resourceId: "counter",
        chainId: 1,
        address: address("1"),
        expectedRuntimeCodeHash: keccak256(CODE_A),
        configuration: [],
        status: { kind: "missing" },
      },
      {
        resourceId: "counter",
        chainId: 10,
        address: address("1"),
        expectedRuntimeCodeHash: keccak256(CODE_A),
        configuration: [],
        status: { kind: "missing" },
      },
    ],
    steps: [1, 10].map((chainId) => ({
      id: "counter:deploy",
      resourceId: "counter",
      chainId,
      kind: "deploy" as const,
      configurationId: null,
      drift: "missing" as const,
      call: { target: address("a"), data: "0x11111111" as Hex, value: 0n },
      postconditions: [
        {
          kind: "runtime-code-hash" as const,
          address: address("1"),
          expectedHash: keccak256(CODE_A),
        },
      ],
    })),
  });
}

function convergedPlan(): ReviewedPlan {
  return reviewPlan({
    manifestHash: hash("c"),
    snapshots: [{ chainId: 1, blockNumber: 1n, blockHash: hash("1") }],
    cells: [
      {
        resourceId: "counter",
        chainId: 1,
        address: address("1"),
        expectedRuntimeCodeHash: keccak256(CODE_A),
        configuration: [],
        status: {
          kind: "converged",
          observedRuntimeCodeHash: keccak256(CODE_A),
          configurationResults: [],
        },
      },
    ],
    steps: [],
  });
}

function observer(
  codeByAddress: ReadonlyMap<Address, unknown>,
  callResult: unknown = "0x",
): MoesiObservationAdapter {
  return {
    async captureSnapshot(chainId) {
      return { blockNumber: 100n + BigInt(chainId), blockHash: hash(chainId === 1 ? "3" : "4") };
    },
    async readCode({ address: requestedAddress }) {
      const value = codeByAddress.get(requestedAddress);
      if (value instanceof Error) throw value;
      return value;
    },
    async readCall() {
      if (callResult instanceof Error) throw callResult;
      return callResult;
    },
  };
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

describe("DeploymentRun", () => {
  it("batches one finalized execution per chain and re-observes every desired cell", async () => {
    const plan = missingPlan();
    const executions: ExecuteReviewedChainInput[] = [];
    const run = createDeploymentRun({
      plan,
      observer: observer(
        new Map<Address, unknown>([
          [address("1"), CODE_A],
          [address("2"), CODE_B],
        ]),
      ),
      async execute(input) {
        executions.push(input);
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.calls)).toBe(true);
        return { chainId: input.chainId, operationId: hash("9") };
      },
    });

    expect(plan.policy.perChainOperationLimit).toBe(1);
    expect(run.state).toBe("ready");
    const first = run.wait();
    const second = run.wait();
    expect(first).toBe(second);
    expect(run.state).toBe("running");

    const result = await first;
    expect(run.state).toBe("complete");
    expect(executions).toHaveLength(1);
    expect(executions[0]?.calls).toHaveLength(2);
    expect(result.status).toBe("converged");
    expect(result.chains[0]?.status).toBe("converged");
    expect(result.chains[0]?.execution).toEqual({ kind: "finalized", operationId: hash("9") });
    expect(result.chains[0]?.cells.map(({ status }) => status.kind)).toEqual([
      "satisfied",
      "satisfied",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("executes distinct chains independently and reports partial convergence", async () => {
    const executed: number[] = [];
    const run = createDeploymentRun({
      plan: twoChainPlan(),
      observer: observer(new Map([[address("1"), CODE_A]])),
      async execute({ chainId }) {
        executed.push(chainId);
        if (chainId === 10) throw new Error("ambiguous external failure");
        return { chainId, operationId: hash("8") };
      },
    });

    const result = await run.wait();
    expect(executed.sort((left, right) => left - right)).toEqual([1, 10]);
    expect(result.status).toBe("partial");
    expect(result.chains.map(({ status }) => status)).toEqual(["converged", "execution-failed"]);
    expect(serialize(result)).not.toContain("ambiguous external failure");
  });

  it("re-verifies an already-converged plan without requesting execution", async () => {
    let executions = 0;
    const run = createDeploymentRun({
      plan: convergedPlan(),
      observer: observer(new Map([[address("1"), CODE_A]])),
      async execute() {
        executions += 1;
        return { chainId: 1, operationId: hash("7") };
      },
    });

    const result = await run.wait();
    expect(executions).toBe(0);
    expect(result.status).toBe("converged");
    expect(result.chains[0]?.execution).toEqual({ kind: "not-required" });
  });

  it("keeps semantic drift separate from finalized execution evidence", async () => {
    const run = createDeploymentRun({
      plan: missingPlan(),
      observer: observer(
        new Map<Address, unknown>([
          [address("1"), CODE_B],
          [address("2"), CODE_B],
        ]),
      ),
      async execute() {
        return { chainId: 1, operationId: hash("6") };
      },
    });

    const result = await run.wait();
    expect(result.status).toBe("failed");
    expect(result.chains[0]?.execution.kind).toBe("finalized");
    expect(result.chains[0]?.status).toBe("drifted");
    expect(result.chains[0]?.cells.map(({ status }) => status.kind)).toEqual([
      "drifted",
      "satisfied",
    ]);
  });

  it("fails closed on unreadable verification without retaining provider errors", async () => {
    const run = createDeploymentRun({
      plan: convergedPlan(),
      observer: observer(new Map([[address("1"), new Error("credential-bearing rpc error")]])),
      async execute() {
        return { chainId: 1, operationId: hash("5") };
      },
    });

    const result = await run.wait();
    expect(result.status).toBe("failed");
    expect(result.chains[0]?.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
    expect(serialize(result)).not.toContain("credential-bearing rpc error");
  });

  it("rejects cross-chain finalized evidence without re-executing or verifying", async () => {
    let executions = 0;
    let reads = 0;
    const verifyingObserver: MoesiObservationAdapter = {
      async captureSnapshot() {
        reads += 1;
        return { blockNumber: 2n, blockHash: hash("2") };
      },
      async readCode() {
        reads += 1;
        return CODE_A;
      },
      async readCall() {
        reads += 1;
        return "0x";
      },
    };
    const run = createDeploymentRun({
      plan: missingPlan(),
      observer: verifyingObserver,
      async execute() {
        executions += 1;
        return { chainId: 10, operationId: hash("3") };
      },
    });

    const result = await run.wait();
    await run.wait();
    expect(executions).toBe(1);
    expect(reads).toBe(0);
    expect(result.chains[0]?.execution).toEqual({
      kind: "failed",
      reason: "invalid-evidence",
    });
    expect(result.chains[0]?.cells.every(({ status }) => status.kind === "unreadable")).toBe(true);
  });

  it("rejects a tampered reviewed plan before exposing execution capability", () => {
    const plan = structuredClone(missingPlan()) as Mutable<ReviewedPlan>;
    const step = plan.steps[0];
    if (!step) throw new Error("missing test step");
    step.call.data = "0xffffffff";

    expect(() =>
      createDeploymentRun({
        plan,
        observer: observer(new Map()),
        async execute() {
          return { chainId: 1, operationId: hash("4") };
        },
      }),
    ).toThrowError(MoesiPlanError);
  });

  it("re-verifies exact configuration at the fresh pinned snapshot", async () => {
    const expectedResult = `0x${"0".repeat(63)}1` as Hex;
    const observedResult = `0x${"0".repeat(64)}` as Hex;
    const plan = reviewPlan({
      manifestHash: hash("d"),
      snapshots: [{ chainId: 1, blockNumber: 1n, blockHash: hash("1") }],
      cells: [
        {
          resourceId: "counter",
          chainId: 1,
          address: address("1"),
          expectedRuntimeCodeHash: keccak256(CODE_A),
          configuration: [{ id: "value", readData: "0x3fa4f245", expectedResult }],
          status: {
            kind: "converged",
            observedRuntimeCodeHash: keccak256(CODE_A),
            configurationResults: [{ id: "value", result: expectedResult }],
          },
        },
      ],
      steps: [],
    });
    const result = await createDeploymentRun({
      plan,
      observer: observer(new Map([[address("1"), CODE_A]]), observedResult),
      async execute() {
        throw new Error("not expected");
      },
    }).wait();

    expect(result.status).toBe("failed");
    expect(result.chains[0]?.status).toBe("drifted");
    expect(result.chains[0]?.cells[0]?.configurations).toEqual([
      {
        id: "value",
        expectedResult,
        status: { kind: "drifted", observedResult },
      },
    ]);
  });

  it("fails closed when fresh configuration evidence is unreadable", async () => {
    const expectedResult = `0x${"0".repeat(63)}1` as Hex;
    const plan = reviewPlan({
      manifestHash: hash("e"),
      snapshots: [{ chainId: 1, blockNumber: 1n, blockHash: hash("1") }],
      cells: [
        {
          resourceId: "counter",
          chainId: 1,
          address: address("1"),
          expectedRuntimeCodeHash: keccak256(CODE_A),
          configuration: [{ id: "value", readData: "0x3fa4f245", expectedResult }],
          status: {
            kind: "converged",
            observedRuntimeCodeHash: keccak256(CODE_A),
            configurationResults: [{ id: "value", result: expectedResult }],
          },
        },
      ],
      steps: [],
    });
    const result = await createDeploymentRun({
      plan,
      observer: observer(
        new Map([[address("1"), CODE_A]]),
        new Error("credential-bearing static-call failure"),
      ),
      async execute() {
        throw new Error("not expected");
      },
    }).wait();

    expect(result.chains[0]?.status).toBe("unreadable");
    expect(result.chains[0]?.cells[0]?.status).toEqual({
      kind: "unreadable",
      reason: "configuration-read-failed",
    });
    expect(serialize(result)).not.toContain("credential-bearing static-call failure");
  });
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;
