import { describe, expect, it } from "vitest";
import {
  compareAccountModules,
  parseAccountModules,
  parseModuleInventory,
} from "../src/modules/codec.js";

const address = `0x${"11".repeat(20)}` as const;
const other = `0x${"22".repeat(20)}` as const;
const hash = `0x${"ab".repeat(32)}` as const;
const snapshot = { chainId: 1, blockNumber: "100", blockHash: hash };
const root = { kind: "root", id: `0x01${address.slice(2)}` } as const;
const expected = {
  profile: "kernel-0.4.0",
  fromBlock: "10",
  entries: [root, { kind: "validator", address }],
} as const;
const inventory = {
  profile: expected.profile,
  account: address,
  snapshot,
  entries: expected.entries,
  checked: ["root", `validator:${address}`],
  history: { fromBlock: "10", toBlock: "100", nextBlock: "101", complete: true, counts: [] },
  complete: true,
  reason: null,
};
function observe(value: unknown = inventory) {
  const plan = parseAccountModules(expected);
  return compareAccountModules(
    plan,
    parseModuleInventory(value, { account: address, snapshot, expectation: plan }),
  );
}
describe("account module expectation boundary", () => {
  it("owns immutable canonical sets while retaining policy order", () => {
    const input = { ...expected, entries: [...expected.entries].reverse() };
    const parsed = parseAccountModules(input);
    expect(parsed).toEqual(parseAccountModules(expected));
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(observe().kind).toBe("satisfied");
  });
  it.each(["executor", "validator"] as const)("reports an undeclared %s from state", (kind) => {
    const result = observe({
      ...inventory,
      entries: [...inventory.entries, { kind, address: other }],
    });
    expect(result.kind).toBe("drifted");
    expect("differences" in result && result.differences[0]?.kind).toBe("unexpected");
  });
  it("reports an undeclared permission even when history has unknown contexts", () => {
    const plan = parseAccountModules(expected);
    const observed = parseModuleInventory(
      {
        ...inventory,
        entries: [
          ...inventory.entries,
          { kind: "permission", id: "0x12345678", signer: other, policies: [] },
        ],
        complete: false,
        reason: "unknown-context",
      },
      { account: address, snapshot, expectation: plan },
    );
    expect(compareAccountModules(plan, observed).kind).toBe("drifted");
  });
  it("never calls partial or unconfirmed coverage converged", () => {
    expect(observe({ ...inventory, complete: false, reason: "unknown-context" }).kind).toBe(
      "incomplete",
    );
    expect(
      observe({
        ...inventory,
        entries: [root],
        checked: ["root"],
        complete: false,
        reason: "budget",
      }).kind,
    ).toBe("incomplete");
    expect(observe({ ...inventory, entries: [root] }).kind).toBe("drifted");
  });
  it("rejects wrong account, chain, hash, range and unsupported profile", () => {
    const plan = parseAccountModules(expected);
    for (const change of [
      { account: other },
      { snapshot: { ...snapshot, chainId: 2 } },
      { snapshot: { ...snapshot, blockHash: `0x${"cd".repeat(32)}` } },
      { history: { ...inventory.history, fromBlock: "11" } },
      { profile: "unknown" },
    ])
      expect(() =>
        parseModuleInventory(
          { ...inventory, ...change },
          { account: address, snapshot, expectation: plan },
        ),
      ).toThrow();
  });
  it("rejects duplicate identities, accessors, unknown keys and unbound removals", () => {
    for (const change of [
      { entries: [root, root] },
      { profile: "unknown" },
      { removals: [{ key: `executor:${other}`, data: "0x12345678" }] },
      { secret: "must not retain" },
    ])
      expect(() => parseAccountModules({ ...expected, ...change })).toThrow();
    let invoked = false;
    expect(() =>
      parseAccountModules({
        ...expected,
        get fromBlock() {
          invoked = true;
          return "10";
        },
      }),
    ).toThrow();
    expect(invoked).toBe(false);
  });
});

import { keccak256 } from "cetane/utils";
import {
  type AccountModulesExpectation,
  createMoesi,
  MemoryDeploymentRunStore,
  type MoesiManifest,
  type MoesiObservationAdapter,
  parseManifest,
  parseReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { MoesiObservationError } from "../src/observation/failure.js";

function manifest(accountModules: AccountModulesExpectation = expected): MoesiManifest {
  return {
    version: "moesi.manifest/v7",
    contracts: [
      {
        kind: "external",
        id: "account",
        address,
        expectedRuntimeCodeHash: keccak256("0x6000"),
        checks: [],
        storageChecks: [],
        semanticChecks: [],
        accountModules,
      },
    ],
  };
}
function client(value: unknown = inventory) {
  let current = value;
  const observer: MoesiObservationAdapter = {
    captureSnapshot: async () => ({
      blockNumber: snapshot.blockNumber,
      blockHash: snapshot.blockHash,
    }),
    readCode: async () => "0x6000",
    readCall: async () => "0x",
    checkBlockAncestry: async () => true,
    readAccountModules: async () => current,
  };
  return {
    observer,
    api: createMoesi({ observer, runStore: new MemoryDeploymentRunStore() }),
    set(value: unknown) {
      current = value;
    },
  };
}
function draft(plan: Awaited<ReturnType<ReturnType<typeof createMoesi>["plan"]>>) {
  const { manifest, snapshots, peers, capabilities, cells, steps } = structuredClone(plan);
  return { manifest, snapshots, peers, capabilities, cells, steps };
}
describe("reviewed account module drift", () => {
  it("plans and freshly verifies exact desired authority", async () => {
    const fixture = client();
    const plan = await fixture.api.plan({ manifest: manifest(), chains: [1] });
    expect(plan.disposition).toBe("converged");
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect((await fixture.api.verify({ plan })).status).toBe("converged");
    fixture.set({
      ...inventory,
      entries: [...inventory.entries, { kind: "executor", address: other }],
    });
    const verified = await fixture.api.verify({ plan });
    expect(verified.status).toBe("drifted");
    expect(verified.chains[0]?.cells[0]?.accountModules?.kind).toBe("drifted");
  });
  it.each(["validator", "executor", "permission"] as const)(
    "finds an undeclared %s and blocks an unreviewed repair",
    async (kind) => {
      const extra =
        kind === "permission"
          ? { kind, id: "0x12345678", signer: other, policies: [] }
          : { kind, address: other };
      const fixture = client({ ...inventory, entries: [...inventory.entries, extra] });
      const plan = await fixture.api.plan({ manifest: manifest(), chains: [1] });
      expect(plan.cells[0]?.status.kind).toBe("module-drift");
      expect(plan.disposition).toBe("blocked");
      expect(plan.steps).toEqual([]);
      expect((await fixture.api.verify({ plan })).status).toBe("drifted");
    },
  );
  it("compiles only exact authorized removal calls, then observes their effect", async () => {
    const fixture = client({
      ...inventory,
      entries: [...inventory.entries, { kind: "executor", address: other }],
    });
    const requested = manifest({
      ...expected,
      accountId: "treasury",
      removals: [{ key: `executor:${other}`, data: "0x12345678" }],
    });
    const plan = await fixture.api.plan({ manifest: requested, chains: [1] });
    expect(plan.disposition).toBe("changes");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      kind: "remove-module",
      call: { target: address, value: "0", data: "0x12345678" },
      sender: { kind: "logical-smart-account", address, accountId: "treasury" },
    });
    for (const alter of [
      (value: ReturnType<typeof draft>) => {
        value.steps = [];
      },
      (value: ReturnType<typeof draft>) => {
        (value.steps[0]!.call as { data: string }).data = "0xdeadbeef";
      },
      (value: ReturnType<typeof draft>) => {
        (value.steps[0]!.call as { target: string }).target = other;
      },
      (value: ReturnType<typeof draft>) => {
        value.cells = value.cells.map(({ accountModules: _, ...cell }) => cell);
      },
      (value: ReturnType<typeof draft>) => {
        (value.cells[0]!.status as { kind: string }).kind = "bytecode-drift";
      },
    ]) {
      const value = draft(plan);
      alter(value);
      expect(() => reviewPlan(value)).toThrow();
    }
    fixture.set(inventory);
    expect((await fixture.api.verify({ plan })).status).toBe("converged");
    expect((await fixture.api.plan({ manifest: requested, chains: [1] })).steps).toEqual([]);
  });
  it("rejects missing, stale, forged, and wrongly bound reviewed evidence", async () => {
    const fixture = client();
    const plan = await fixture.api.plan({ manifest: manifest(), chains: [1] });
    for (const alter of [
      (value: ReturnType<typeof draft>) => {
        value.cells = value.cells.map(({ accountModules: _, ...cell }) => cell);
      },
      (value: ReturnType<typeof draft>) => {
        const item = value.cells[0]!.accountModules!;
        if (item.kind !== "unreadable")
          (item.inventory.snapshot as { blockHash: string }).blockHash = `0x${"cc".repeat(32)}`;
      },
      (value: ReturnType<typeof draft>) => {
        (value.cells[0]!.accountModules as { kind: string }).kind = "drifted";
      },
      (value: ReturnType<typeof draft>) => {
        (value.manifest.contracts[0]!.accountModules as unknown as { entries: unknown[] }).entries =
          [];
      },
    ]) {
      const value = draft(plan);
      alter(value);
      expect(() => reviewPlan(value)).toThrow();
    }
    expect(() => parseManifest({ ...manifest(), version: "moesi.manifest/v6" } as never)).toThrow(
      /version/,
    );
    expect(() =>
      parseReviewedPlan({ ...plan, version: "moesi.reviewed-plan/v7" } as never),
    ).toThrow(/version/);
  });
  it("fails closed for incomplete history, invalid response and absent capability", async () => {
    for (const value of [
      { ...inventory, complete: false, reason: "unknown-context" },
      {
        ...inventory,
        history: { ...inventory.history, complete: false, nextBlock: "20" },
        complete: false,
        reason: "partial-history",
      },
      { ...inventory, account: other },
    ]) {
      const fixture = client(value);
      const plan = await fixture.api.plan({ manifest: manifest(), chains: [1] });
      expect(plan.disposition).toBe("blocked");
      expect(plan.cells[0]?.status.kind).toBe("unreadable");
      expect((await fixture.api.verify({ plan })).status).toBe("unreadable");
    }
    const fixture = client();
    delete fixture.observer.readAccountModules;
    const plan = await fixture.api.plan({ manifest: manifest(), chains: [1] });
    expect(plan.cells[0]?.accountModules).toEqual({ kind: "unreadable", reason: "unavailable" });
  });
  it("propagates the caller's exhausted RPC budget", async () => {
    const fixture = client();
    fixture.observer.readAccountModules = async () => {
      throw new MoesiObservationError("observation_budget_exhausted");
    };
    await expect(fixture.api.plan({ manifest: manifest(), chains: [1] })).rejects.toMatchObject({
      code: "observation_budget_exhausted",
    });
  });
});

it("compares root, selectors, signers, ordered policies and scoped hooks exactly", () => {
  const third = `0x${"33".repeat(20)}` as const;
  const pairs = [
    [root, { ...root, id: `0x01${other.slice(2)}` }],
    [
      { kind: "fallback", selector: "0x12345678", address },
      { kind: "fallback", selector: "0x12345678", address: other },
    ],
    [
      { kind: "permission", id: "0x12345678", signer: address, policies: [other, third] },
      { kind: "permission", id: "0x12345678", signer: other, policies: [other, third] },
    ],
    [
      { kind: "permission", id: "0x12345678", signer: address, policies: [other, third] },
      { kind: "permission", id: "0x12345678", signer: address, policies: [third, other] },
    ],
    [
      { kind: "hook", context: `0x02${address.slice(2)}`, address: other },
      { kind: "hook", context: `0x02${address.slice(2)}`, address: third },
    ],
  ];
  for (const [before, after] of pairs) {
    const expectation = parseAccountModules({ ...expected, entries: [before] });
    const value = parseModuleInventory(
      { ...inventory, entries: [after] },
      { account: address, snapshot, expectation },
    );
    const result = compareAccountModules(expectation, value);
    expect(result.kind).toBe("drifted");
    expect(result.kind !== "unreadable" && result.differences.map(({ kind }) => kind)).toEqual([
      "changed",
    ]);
  }
});

it("does not send a reviewed removal after the account runtime changes", async () => {
  const fixture = client({
    ...inventory,
    entries: [...inventory.entries, { kind: "executor", address: other }],
  });
  const plan = await fixture.api.plan({
    manifest: manifest({
      ...expected,
      accountId: "treasury",
      removals: [{ key: `executor:${other}`, data: "0x12345678" }],
    }),
    chains: [1],
  });
  let sends = 0;
  const provider: import("../src/index.js").MoesiExecutionProvider = {
    id: "module-test",
    async review() {
      return {
        providerId: "module-test",
        status: "supported",
        reasons: [],
        chains: [
          {
            chainId: 1,
            sender: address,
            accountId: "treasury",
            route: "test",
            signer: "owner",
            signerReason: "test",
            fallback: null,
            enforcement: {
              calls: "interactive-owner",
              expiry: "not-enforced",
              operationCount: "not-enforced",
            },
          },
        ],
      };
    },
    async prepare({ plan }) {
      return { providerId: "module-test", planId: plan.planId, binding: {} };
    },
    async submit() {
      sends++;
      throw new Error("must_not_send");
    },
    async observe() {
      return { status: "pending" };
    },
  };
  const executionReview = await fixture.api.reviewExecution({ plan, provider });
  fixture.observer.readCode = async () => "0x6001";
  const result = await fixture.api.apply({ plan, provider, executionReview }).wait();
  expect(result.chains[0]?.execution).toMatchObject({
    kind: "failed",
    reason: "configuration-runtime-mismatch",
  });
  expect(sends).toBe(0);
});
