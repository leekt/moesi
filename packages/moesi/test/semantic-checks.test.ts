import { concatHex, keccak256, padHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createMoesi,
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  type MoesiManifest,
  type MoesiObservationAdapter,
  parseManifest,
  parseReviewedPlan,
  type SemanticCheck,
} from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const caller = address("a");
const target = address("b");
const implementation = address("c");
const beacon = address("d");
const word = (value: `0x${string}`) => padHex(value, { size: 32 });
const zero = word("0x00");
const checks: readonly SemanticCheck[] = [
  { kind: "ownable-owner", id: "owner", caller, expectedOwner: caller },
  {
    kind: "access-control-role",
    id: "role",
    caller,
    role: hash("e"),
    account: caller,
    expectedMember: true,
    expectedAdminRole: zero,
  },
  {
    kind: "erc1967-direct",
    id: "proxy",
    expectedImplementation: implementation,
    expectedAdmin: caller,
  },
];
function manifest(semanticChecks: readonly SemanticCheck[] = checks): MoesiManifest {
  return {
    version: "moesi.manifest/v6",
    contracts: [
      {
        kind: "external",
        id: "contract",
        address: target,
        expectedRuntimeCodeHash: keccak256("0x6000"),
        checks: [],
        storageChecks: [],
        semanticChecks,
      },
    ],
  };
}
function observer() {
  return {
    captureSnapshot: vi.fn(async () => ({ blockNumber: "1", blockHash: hash("1") })),
    readCode: vi.fn(async () => "0x6000"),
    readCall: vi.fn<MoesiObservationAdapter["readCall"]>(async ({ data }) =>
      data === "0x8da5cb5b"
        ? word(caller)
        : data === "0x5c60da1b"
          ? word(implementation)
          : data.startsWith("0x91d14854")
            ? word("0x01")
            : zero,
    ),
    readStorage: vi.fn<NonNullable<MoesiObservationAdapter["readStorage"]>>(async ({ slot }) =>
      slot === ERC1967_IMPLEMENTATION_SLOT
        ? word(implementation)
        : slot === ERC1967_ADMIN_SLOT
          ? word(caller)
          : zero,
    ),
    checkBlockAncestry: vi.fn(async () => true),
  };
}

describe("explicit desired semantic checks", () => {
  it("compiles exact assertions, keeps semantic kinds, and converges without execution requirements", async () => {
    const rpc = observer();
    const client = createMoesi({ observer: rpc });
    const plan = await client.plan({ manifest: manifest(), chains: [1] });
    expect(plan.disposition).toBe("converged");
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(plan.cells[0]?.checks).toEqual([
      {
        kind: "ownable-owner",
        id: "owner.owner",
        target,
        caller,
        readData: "0x8da5cb5b",
        expectedResult: word(caller),
      },
      {
        kind: "access-control-admin-role",
        id: "role.admin-role",
        target,
        caller,
        readData: concatHex(["0x248a9ca3", hash("e")]),
        expectedResult: zero,
      },
      {
        kind: "access-control-member",
        id: "role.member",
        target,
        caller,
        readData: concatHex(["0x91d14854", hash("e"), word(caller)]),
        expectedResult: word("0x01"),
      },
    ]);
    expect(plan.cells[0]?.storageChecks).toEqual([
      {
        kind: "erc1967-admin",
        id: "proxy.admin",
        slot: ERC1967_ADMIN_SLOT,
        expectedWord: word(caller),
      },
      { kind: "erc1967-beacon", id: "proxy.beacon", slot: ERC1967_BEACON_SLOT, expectedWord: zero },
      {
        kind: "erc1967-implementation",
        id: "proxy.implementation",
        slot: ERC1967_IMPLEMENTATION_SLOT,
        expectedWord: word(implementation),
      },
    ]);
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect((await client.verify({ plan })).chains[0]?.cells[0]?.callChecks[0]).toMatchObject({
      kind: "ownable-owner",
      target,
      status: { kind: "satisfied" },
    });
    expect(Object.isFrozen(plan.manifest.contracts[0]?.semanticChecks[0])).toBe(true);
    expect(
      rpc.readCall.mock.calls.every(
        ([input]) => input.caller === caller && input.snapshot.blockHash === hash("1"),
      ),
    ).toBe(true);
  });

  it("reports owner, membership, admin-role and proxy drift without generating repairs", async () => {
    const rpc = observer();
    const client = createMoesi({ observer: rpc });
    const converged = await client.plan({ manifest: manifest(), chains: [1] });
    rpc.readCall.mockImplementation(async ({ data }) =>
      data === "0x8da5cb5b" ? word(beacon) : data.startsWith("0x91d14854") ? zero : hash("f"),
    );
    rpc.readStorage.mockResolvedValue(word(beacon));
    const drift = await client.plan({ manifest: manifest(), chains: [1] });
    expect(drift.disposition).toBe("blocked");
    expect(drift.cells[0]?.status).toMatchObject({
      kind: "drift",
      callMismatches: [{ id: "owner.owner" }, { id: "role.admin-role" }, { id: "role.member" }],
      storageMismatches: [
        { id: "proxy.admin" },
        { id: "proxy.beacon" },
        { id: "proxy.implementation" },
      ],
    });
    expect(drift.steps).toEqual([]);
    expect(drift.requirements).toEqual([]);
    expect((await client.verify({ plan: converged })).status).toBe("drifted");
  });

  it("binds beacon calls to the declared address even when the observed slot changes", async () => {
    const rpc = observer();
    const source = manifest([
      {
        kind: "erc1967-beacon",
        id: "proxy",
        caller,
        expectedBeacon: beacon,
        expectedImplementation: implementation,
        expectedAdmin: caller,
      },
    ]);
    rpc.readStorage.mockImplementation(async ({ slot }) =>
      slot === ERC1967_IMPLEMENTATION_SLOT
        ? zero
        : slot === ERC1967_BEACON_SLOT
          ? word(beacon)
          : word(caller),
    );
    const client = createMoesi({ observer: rpc });
    const plan = await client.plan({ manifest: source, chains: [1] });
    expect(plan.disposition).toBe("converged");
    expect(plan.cells[0]?.checks[0]).toMatchObject({
      kind: "beacon-implementation",
      target: beacon,
    });
    rpc.readStorage.mockImplementation(async ({ slot }) =>
      slot === ERC1967_IMPLEMENTATION_SLOT
        ? zero
        : slot === ERC1967_BEACON_SLOT
          ? word(address("f"))
          : word(caller),
    );
    rpc.readCall.mockClear();
    expect((await client.verify({ plan })).status).toBe("drifted");
    expect(rpc.readCall.mock.calls.map(([input]) => input.target)).toEqual([beacon]);
  });

  it.each([
    ["owner", "0x", "ownable-owner"],
    ["owner", hash("f"), "ownable-owner"],
    ["role", word("0x02"), "access-control-member"],
    ["role", "0x", "access-control-admin-role"],
  ] as const)("classifies malformed %s ABI data as unreadable", async (_name, value, kind) => {
    const rpc = observer();
    const client = createMoesi({ observer: rpc });
    const source = manifest(checks.filter((check) => check.kind !== "erc1967-direct"));
    const plan = await client.plan({ manifest: source, chains: [1] });
    const original = rpc.readCall.getMockImplementation()!;
    rpc.readCall.mockImplementation(async (input) => {
      const match =
        kind === "ownable-owner"
          ? input.data === "0x8da5cb5b"
          : kind === "access-control-member"
            ? input.data.startsWith("0x91d14854")
            : input.data.startsWith("0x248a9ca3");
      return match ? value : original(input);
    });
    expect((await client.plan({ manifest: source, chains: [1] })).cells[0]?.status).toMatchObject({
      kind: "unreadable",
      reason: "invalid-response",
    });
    expect((await client.verify({ plan })).status).toBe("unreadable");
  });

  it("rejects malformed proxy address slots as unreadable, preserving storage capability failure", async () => {
    const rpc = observer();
    rpc.readStorage.mockResolvedValue(hash("f"));
    expect(
      (await createMoesi({ observer: rpc }).plan({ manifest: manifest(), chains: [1] })).cells[0]
        ?.status,
    ).toMatchObject({ kind: "unreadable", source: "storage-check", reason: "invalid-response" });
    const { readStorage: _, ...unavailable } = rpc;
    expect(
      (await createMoesi({ observer: unavailable }).plan({ manifest: manifest(), chains: [1] }))
        .cells[0]?.status,
    ).toMatchObject({ kind: "unreadable", source: "storage-check", reason: "unavailable" });
  });

  it("rejects forged assertion kinds, targets, bytes and malformed drift evidence", async () => {
    const plan = await createMoesi({ observer: observer() }).plan({
      manifest: manifest(),
      chains: [1],
    });
    for (const mutation of [
      (copy: any) => {
        copy.cells[0].checks[0].kind = "call";
      },
      (copy: any) => {
        copy.cells[0].checks[0].target = beacon;
      },
      (copy: any) => {
        copy.cells[0].checks[0].readData = "0x12345678";
      },
      (copy: any) => {
        copy.cells[0].status = {
          kind: "drift",
          observedRuntimeCodeHash: keccak256("0x6000"),
          configurationMismatches: [],
          storageMismatches: [],
          callMismatches: [
            { id: "owner.owner", expectedResult: word(caller), observedResult: "0x" },
          ],
        };
      },
    ]) {
      const copy = JSON.parse(JSON.stringify(plan));
      mutation(copy);
      expect(() => parseReviewedPlan(copy)).toThrow();
    }
  });

  it("captures once and rejects invalid semantic declarations and collisions before RPC", async () => {
    const rpc = observer();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const bad = [
      proxy,
      { ...checks[0], expectedOwner: "0x" },
      { ...checks[0], caller: address("0") },
      { ...checks[1], expectedMember: 1 },
      { ...checks[2], expectedImplementation: address("0") },
      { ...checks[0], extra: true },
      { kind: "unknown", id: "x" },
    ];
    for (const check of bad) {
      await expect(
        createMoesi({ observer: rpc }).plan({ manifest: manifest([check as never]), chains: [1] }),
      ).rejects.toMatchObject({ code: "invalid_resource" });
    }
    await expect(
      createMoesi({ observer: rpc }).plan({
        manifest: manifest([checks[2]!, { ...checks[2]!, id: "another" }]),
        chains: [1],
      }),
    ).rejects.toMatchObject({ code: "invalid_resource" });
    expect(rpc.captureSnapshot).not.toHaveBeenCalled();
    let reads = 0;
    const parsed = parseManifest(
      manifest([
        {
          kind: "ownable-owner",
          id: "owner",
          caller,
          get expectedOwner() {
            reads++;
            return caller;
          },
        },
      ]),
    );
    expect(reads).toBe(1);
    expect(parsed.contracts[0]?.semanticChecks[0]).toMatchObject({ expectedOwner: caller });
    expect(parseManifest(manifest([...checks].reverse())).manifestHash).toBe(
      parseManifest(manifest()).manifestHash,
    );
  });
});
