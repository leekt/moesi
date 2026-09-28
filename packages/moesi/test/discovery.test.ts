import { concatHex, type Hex, keccak256, padHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  createMoesi,
  ERC1967_ADMIN_SLOT,
  ERC1967_BEACON_SLOT,
  ERC1967_IMPLEMENTATION_SLOT,
  type MoesiDiscoverRequest,
  type MoesiDiscoveryResult,
  type MoesiObservationAdapter,
} from "../src/index.js";

const address = (byte: string) => `0x${byte.repeat(40)}` as const;
const hash = (byte: string) => `0x${byte.repeat(64)}` as const;
const target = address("a");
const caller = address("b");
const implementation = address("c");
const beacon = address("d");
const zero = padHex("0x00", { size: 32 });
const one = padHex("0x01", { size: 32 });
const request: MoesiDiscoverRequest = {
  chains: [1],
  resources: [
    {
      address: target,
      caller,
      erc1967: true,
      ownable: true,
      roles: [{ role: hash("e"), account: caller }],
    },
  ],
};

function observer() {
  return {
    captureSnapshot: vi.fn(async () => ({ blockNumber: "100", blockHash: hash("1") })),
    readCode: vi.fn<MoesiObservationAdapter["readCode"]>(async () => "0x6000"),
    readStorage: vi.fn<NonNullable<MoesiObservationAdapter["readStorage"]>>(async ({ slot }) =>
      slot === ERC1967_IMPLEMENTATION_SLOT
        ? padHex(implementation, { size: 32 })
        : slot === ERC1967_ADMIN_SLOT
          ? padHex(caller, { size: 32 })
          : zero,
    ),
    readCall: vi.fn<MoesiObservationAdapter["readCall"]>(async ({ data }) =>
      data === "0x8da5cb5b"
        ? padHex(caller, { size: 32 })
        : data === "0x5c60da1b"
          ? padHex(implementation, { size: 32 })
          : data.startsWith("0x91d14854")
            ? one
            : zero,
    ),
    checkBlockAncestry: vi.fn<MoesiObservationAdapter["checkBlockAncestry"]>(async () => true),
  };
}

function deployed(result: MoesiDiscoveryResult) {
  const chain = result.chains[0];
  if (chain?.kind !== "observed") throw new Error("chain was not observed");
  const resource = chain.resources[0];
  if (resource?.kind !== "deployed") throw new Error("resource was not deployed");
  return resource;
}

describe("pinned deployment discovery", () => {
  it("reports exact code, ERC-1967, owner and role evidence with one pinned block and exact caller", async () => {
    const rpc = observer();
    const result = await createMoesi({ observer: rpc }).discover(request);
    expect(result.version).toBe("moesi.discovery/v1");
    const resource = deployed(result);
    expect(resource.runtimeCodeHash).toBe(keccak256("0x6000"));
    expect(resource.erc1967).toEqual({
      implementation: { kind: "readable", value: implementation },
      admin: { kind: "readable", value: caller },
      beacon: { kind: "readable", value: address("0") },
      target: { kind: "implementation", address: implementation },
    });
    expect(resource.owner).toEqual({ kind: "readable", value: caller });
    expect(resource.roles).toEqual([
      {
        role: hash("e"),
        account: caller,
        member: { kind: "readable", value: true },
        adminRole: { kind: "readable", value: zero },
      },
    ]);
    expect(rpc.readStorage.mock.calls.map(([input]) => input.slot)).toEqual([
      ERC1967_IMPLEMENTATION_SLOT,
      ERC1967_ADMIN_SLOT,
      ERC1967_BEACON_SLOT,
    ]);
    expect(rpc.readCall.mock.calls.map(([input]) => input.data)).toEqual([
      "0x8da5cb5b",
      concatHex(["0x91d14854", hash("e"), padHex(caller, { size: 32 })]),
      concatHex(["0x248a9ca3", hash("e")]),
    ]);
    for (const [input] of [
      ...rpc.readCall.mock.calls,
      ...rpc.readStorage.mock.calls,
      ...rpc.readCode.mock.calls,
    ]) {
      expect(input.snapshot).toEqual({ chainId: 1, blockNumber: "100", blockHash: hash("1") });
      expect(Object.isFrozen(input)).toBe(true);
      expect(Object.isFrozen(input.snapshot)).toBe(true);
    }
    expect(
      rpc.readCall.mock.calls.every(
        ([input]) => input.caller === caller && input.target === target,
      ),
    ).toBe(true);
    expect(rpc.captureSnapshot).toHaveBeenCalledTimes(2);
    expect(rpc.checkBlockAncestry).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(resource.roles[0]?.member)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("follows a beacon only with an empty implementation slot and unambiguous evidence", async () => {
    const rpc = observer();
    rpc.readStorage.mockImplementation(async ({ slot }) =>
      slot === ERC1967_BEACON_SLOT ? padHex(beacon, { size: 32 }) : zero,
    );
    const result = deployed(await createMoesi({ observer: rpc }).discover(request));
    expect(result.erc1967?.target).toEqual({
      kind: "beacon",
      address: beacon,
      implementation: { kind: "readable", value: implementation },
    });
    expect(rpc.readCall.mock.calls[0]?.[0]).toMatchObject({
      target: beacon,
      caller,
      data: "0x5c60da1b",
    });
    rpc.readStorage.mockImplementation(async () => padHex(beacon, { size: 32 }));
    rpc.readCall.mockClear();
    expect(
      deployed(await createMoesi({ observer: rpc }).discover(request)).erc1967?.target,
    ).toEqual({ kind: "conflict" });
    expect(rpc.readCall.mock.calls.some(([input]) => input.target === beacon)).toBe(false);
    rpc.readStorage.mockImplementation(async ({ slot }) =>
      slot === ERC1967_IMPLEMENTATION_SLOT ? "0x" : padHex(beacon, { size: 32 }),
    );
    rpc.readCall.mockClear();
    expect(
      deployed(await createMoesi({ observer: rpc }).discover(request)).erc1967?.target,
    ).toEqual({ kind: "unreadable" });
    expect(rpc.readCall.mock.calls.some(([input]) => input.target === beacon)).toBe(false);
  });

  it("keeps unrequested, missing, unavailable and failed reads distinct", async () => {
    const rpc = observer();
    const minimal = { chains: [1], resources: [{ address: target, caller }] };
    const result = deployed(await createMoesi({ observer: rpc }).discover(minimal));
    expect(result).toMatchObject({ erc1967: null, owner: null, roles: [] });
    expect(rpc.readCall).not.toHaveBeenCalled();
    expect(rpc.readStorage).not.toHaveBeenCalled();
    rpc.readCode.mockResolvedValue("0x");
    expect((await createMoesi({ observer: rpc }).discover(request)).chains[0]).toMatchObject({
      resources: [{ address: target, caller, kind: "missing" }],
    });
    expect(rpc.readCall).not.toHaveBeenCalled();
    rpc.readCode.mockRejectedValue(new Error("private RPC value"));
    expect((await createMoesi({ observer: rpc }).discover(request)).chains[0]).toMatchObject({
      resources: [{ kind: "unreadable", reason: "read-failed" }],
    });
    rpc.readCode.mockResolvedValue("0x6000");
    const { readStorage: _, ...withoutStorage } = rpc;
    expect(
      deployed(await createMoesi({ observer: withoutStorage }).discover(request)).erc1967
        ?.implementation,
    ).toEqual({ kind: "unreadable", reason: "unavailable" });
    rpc.readCall.mockRejectedValue(new Error("private RPC value"));
    expect(deployed(await createMoesi({ observer: rpc }).discover(request)).owner).toEqual({
      kind: "unreadable",
      reason: "read-failed",
    });
  });

  it.each(["0x", "0x01", concatHex([zero, zero]), hash("f")])(
    "rejects malformed ABI address words %s",
    async (value) => {
      const rpc = observer();
      rpc.readCall.mockResolvedValue(value);
      rpc.readStorage.mockResolvedValue(value);
      const resource = deployed(await createMoesi({ observer: rpc }).discover(request));
      expect(resource.owner).toEqual({ kind: "unreadable", reason: "invalid-response" });
      expect(resource.erc1967?.target).toEqual({ kind: "unreadable" });
    },
  );

  it("accepts zero ownership/role state and rejects noncanonical bools", async () => {
    const rpc = observer();
    rpc.readCall.mockResolvedValue(zero);
    rpc.readStorage.mockResolvedValue(zero);
    let result = deployed(await createMoesi({ observer: rpc }).discover(request));
    expect(result.owner).toEqual({ kind: "readable", value: address("0") });
    expect(result.roles[0]?.member).toEqual({ kind: "readable", value: false });
    expect(result.erc1967?.target).toEqual({ kind: "empty" });
    rpc.readCall.mockResolvedValue(padHex("0x02", { size: 32 }));
    result = deployed(await createMoesi({ observer: rpc }).discover(request));
    expect(result.roles[0]?.member).toEqual({ kind: "unreadable", reason: "invalid-response" });
  });

  it.each([false, "true", undefined, new Error("private reorg error")])(
    "discards data when ancestry cannot be proved",
    async (value) => {
      const rpc = observer();
      rpc.checkBlockAncestry.mockImplementation(async () => {
        if (value instanceof Error) throw value;
        return value;
      });
      expect((await createMoesi({ observer: rpc }).discover(request)).chains).toEqual([
        {
          chainId: 1,
          kind: "unreadable",
          reason: value === false ? "snapshot-not-canonical" : "ancestry-unreadable",
        },
      ]);
    },
  );

  it("rejects changed or decreasing snapshot anchors even if an adapter returns true", async () => {
    for (const end of [
      { blockNumber: "100", blockHash: hash("2") },
      { blockNumber: "99", blockHash: hash("1") },
    ]) {
      const rpc = observer();
      rpc.captureSnapshot
        .mockResolvedValueOnce({ blockNumber: "100", blockHash: hash("1") })
        .mockResolvedValue(end);
      expect((await createMoesi({ observer: rpc }).discover(request)).chains).toEqual([
        { chainId: 1, kind: "unreadable", reason: "snapshot-not-canonical" },
      ]);
      expect(rpc.checkBlockAncestry).not.toHaveBeenCalled();
    }
  });

  it("isolates unreadable chain snapshots and canonically orders chains/resources/roles", async () => {
    const rpc = observer();
    rpc.captureSnapshot.mockRejectedValueOnce(new Error("private RPC value"));
    const result = await createMoesi({ observer: rpc }).discover({
      chains: [2, 1],
      resources: [
        { address: caller, caller },
        {
          address: target,
          caller,
          roles: [
            { role: hash("f"), account: target },
            { role: hash("e"), account: caller },
          ],
        },
      ],
    });
    expect(result.chains[0]).toEqual({
      chainId: 1,
      kind: "unreadable",
      reason: "snapshot-unreadable",
    });
    const chain = result.chains[1];
    expect(chain?.kind).toBe("observed");
    if (chain?.kind !== "observed") return;
    expect(chain.resources.map(({ address }) => address)).toEqual([target, caller]);
    const resource = chain.resources[0];
    if (resource?.kind !== "deployed") throw new Error("missing fixture");
    expect(resource.roles.map(({ role }) => role)).toEqual([hash("e"), hash("f")]);
  });

  it("captures caller getters and adapter capabilities once before awaiting reads", async () => {
    const rpc = observer();
    let callerReads = 0;
    let methodReads = 0;
    let sourceCaller = caller;
    const source = {
      chains: [1],
      resources: [
        {
          address: target,
          get caller() {
            callerReads++;
            return sourceCaller;
          },
          ownable: true,
        },
      ],
    };
    const selected = {
      ...rpc,
      get readCall() {
        methodReads++;
        return rpc.readCall;
      },
    };
    const pending = createMoesi({ observer: selected }).discover(source);
    sourceCaller = address("e");
    source.chains.push(2);
    source.resources.length = 0;
    const result = deployed(await pending);
    expect(result.caller).toBe(caller);
    expect(rpc.readCall.mock.calls[0]?.[0].caller).toBe(caller);
    expect(callerReads).toBe(1);
    expect(methodReads).toBe(1);
  });

  it("sanitizes throwing adapter accessors and preserves missing storage distinction", async () => {
    const rpc = observer();
    Object.defineProperty(rpc, "readStorage", {
      get() {
        throw new Error("private capability");
      },
    });
    expect(
      deployed(await createMoesi({ observer: rpc }).discover(request)).erc1967?.implementation,
    ).toEqual({ kind: "unreadable", reason: "read-failed" });
  });

  it.each([
    { chains: [], resources: request.resources },
    { chains: [1, 1], resources: request.resources },
    { chains: [0], resources: request.resources },
    { chains: [1], resources: [] },
    { chains: [1], resources: [{ address: target, caller: address("0") }] },
    { chains: [1], resources: [{ address: target, caller, secret: "not retained" }] },
    {
      chains: [1],
      resources: [{ address: target, caller, roles: [{ role: "0x", account: caller }] }],
    },
    {
      chains: [1],
      resources: [
        { address: target, caller },
        { address: target.toUpperCase().replace("0X", "0x"), caller },
      ],
    },
  ])("rejects invalid request shapes before RPC", async (input) => {
    const rpc = observer();
    await expect(createMoesi({ observer: rpc }).discover(input as never)).rejects.toMatchObject({
      code: "invalid_discovery_request",
      message: "discovery request is invalid",
    });
    expect(rpc.captureSnapshot).not.toHaveBeenCalled();
  });

  it("rejects revoked proxies, sparse arrays, hostile getters and aggregate over-budget requests before RPC", async () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const sparse = new Array(2);
    sparse[0] = 1;
    const throwing = {
      get chains() {
        throw new Error("private caller value");
      },
      resources: request.resources,
    };
    const tooManyReads = {
      chains: Array.from({ length: 32 }, (_, i) => i + 1),
      resources: Array.from({ length: 64 }, (_, i) => ({
        address: `0x${i.toString(16).padStart(40, "0")}` as Hex,
        caller,
        erc1967: true,
      })),
    };
    const rpc = observer();
    for (const input of [
      proxy,
      { chains: sparse, resources: request.resources },
      throwing,
      tooManyReads,
    ]) {
      await expect(createMoesi({ observer: rpc }).discover(input as never)).rejects.toMatchObject({
        code: input === tooManyReads ? "discovery_budget_exceeded" : "invalid_discovery_request",
      });
    }
    expect(rpc.captureSnapshot).not.toHaveBeenCalled();
  });
});
