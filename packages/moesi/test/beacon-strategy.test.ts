import {
  decodeAbiParameters,
  encodeFunctionData,
  type Hex,
  keccak256,
  padHex,
  parseAbi,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  type CheckedBeaconProxyInput,
  compileCheckedBeaconProxy,
  MoesiManifestError,
  parseManifest,
  parseManifestText,
} from "../src/index.js";
import { deriveResourceAddress } from "../src/manifest/target.js";
import {
  CHECKED_BEACON_INIT_CODE,
  CHECKED_PROXY_INIT_CODE,
} from "../src/strategy/proxy-artifacts.js";
import { testAddress, testHash } from "./fixtures.js";

const input: CheckedBeaconProxyInput = {
  id: "vault",
  beaconSalt: testHash("b"),
  proxySalt: testHash("c"),
  owner: testAddress("a"),
  implementations: ["1", "2"].map((n) => ({
    kind: "external",
    id: `implementation-${n}`,
    address: testAddress(n),
    expectedRuntimeCodeHash: testHash(n),
    checks: [],
    storageChecks: [],
  })),
  initialImplementationId: "implementation-1",
  desiredImplementationId: "implementation-1",
  initializationData: "0x12345678",
};

describe("checked beacon proxy compiler", () => {
  it("binds constructor identity, runtime hashes, owner and exact guarded upgrade calldata", () => {
    const first = compileCheckedBeaconProxy(input);
    const upgrade = compileCheckedBeaconProxy({
      ...input,
      desiredImplementationId: "implementation-2",
    });
    expect(upgrade.beaconAddress).toBe(first.beaconAddress);
    expect(upgrade.proxyAddress).toBe(first.proxyAddress);
    expect(upgrade.manifest.manifestHash).not.toBe(first.manifest.manifestHash);
    const beacon = upgrade.manifest.contracts.find(({ id }) => id === "vault.beacon");
    const proxy = upgrade.manifest.contracts.find(({ id }) => id === "vault.proxy");
    if (beacon?.kind !== "managed" || proxy?.kind !== "managed")
      throw new Error("missing resources");
    expect(
      decodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
        `0x${beacon.deployment.initCode.slice(CHECKED_BEACON_INIT_CODE.length)}`,
      ),
    ).toEqual([
      testAddress("1"),
      expect.stringMatching(new RegExp(`^${input.owner}$`, "i")),
      testHash("1"),
    ]);
    expect(
      decodeAbiParameters(
        [
          { type: "address" },
          { type: "bytes32" },
          { type: "address" },
          { type: "bytes32" },
          { type: "bytes" },
        ],
        `0x${proxy.deployment.initCode.slice(CHECKED_PROXY_INIT_CODE.length)}`,
      ),
    ).toEqual([
      expect.stringMatching(new RegExp(`^${first.beaconAddress}$`, "i")),
      beacon.expectedRuntimeCodeHash,
      testAddress("1"),
      testHash("1"),
      input.initializationData,
    ]);
    expect(beacon.configuration[0]).toEqual({
      id: "implementation",
      readData: "0x5c60da1b",
      expectedResult: padHex(testAddress("2"), { size: 32 }),
      writeData: encodeFunctionData({
        abi: parseAbi(["function upgradeToChecked(address,bytes32)"]),
        functionName: "upgradeToChecked",
        args: [testAddress("2"), testHash("2")],
      }),
      value: "0",
    });
    expect(beacon.sender).toEqual({ kind: "owner-eoa", address: input.owner });
    expect(proxy.sender).toEqual(beacon.sender);
    expect(proxy.semanticChecks).toEqual([
      {
        kind: "erc1967-beacon",
        id: "beacon",
        caller: input.owner,
        expectedBeacon: first.beaconAddress,
        expectedImplementation: testAddress("2"),
        expectedAdmin: testAddress("0"),
      },
    ]);
    expect(beacon.deployment.requiresRuntime).toEqual(["implementation-1", "implementation-2"]);
    expect(proxy.deployment.requiresRuntime).toEqual(["implementation-1", "vault.beacon"]);
    expect(Object.isFrozen(upgrade)).toBe(true);
    expect(Object.isFrozen(beacon.configuration[0])).toBe(true);
  });

  it("roundtrips current literal manifests and normalizes equivalent inputs", () => {
    const compiled = compileCheckedBeaconProxy(input);
    expect(parseManifest(compiled.manifest)).toBe(compiled.manifest);
    expect(
      parseManifestText(
        JSON.stringify({
          version: compiled.manifest.version,
          contracts: compiled.manifest.contracts,
        }),
      ),
    ).toEqual(compiled.manifest);
    expect(
      compileCheckedBeaconProxy({
        ...input,
        implementations: [...input.implementations].reverse(),
        owner: input.owner.toUpperCase().replace("0X", "0x") as Hex,
      }),
    ).toEqual(compiled);
    expect(compiled.manifest.contracts.map(deriveResourceAddress)).toContain(compiled.proxyAddress);
    expect(
      compileCheckedBeaconProxy({ ...input, beaconSalt: testHash("d") }).proxyAddress,
    ).not.toBe(compiled.proxyAddress);
    expect(
      compileCheckedBeaconProxy({ ...input, initialImplementationId: "implementation-2" })
        .beaconAddress,
    ).not.toBe(compiled.beaconAddress);
  });

  it("rejects hostile, ambiguous or oversized source input without leaking details", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = { ...input };
    Object.defineProperty(hostile, "owner", {
      get() {
        throw new Error("secret");
      },
    });
    const bad = [
      null,
      revoked.proxy,
      hostile,
      { ...input, extra: true },
      { ...input, [Symbol()]: true },
      { ...input, owner: testAddress("0") },
      { ...input, initializationData: "0x" },
      { ...input, initializationData: `0x${"11".repeat(8193)}` },
      { ...input, beaconSalt: "0x00" },
      { ...input, implementations: new Array(2) },
      { ...input, implementations: new Array(65).fill(input.implementations[0]) },
      { ...input, implementations: revoked.proxy },
      { ...input, initialImplementationId: "absent" },
      { ...input, id: "a".repeat(121) },
      {
        ...input,
        implementations: [
          ...input.implementations,
          { ...input.implementations[0], id: "vault.proxy", address: testAddress("3") },
        ],
      },
    ];
    for (const value of bad) {
      try {
        compileCheckedBeaconProxy(value as CheckedBeaconProxyInput);
        expect.fail("accepted invalid input");
      } catch (error) {
        expect(error).toBeInstanceOf(MoesiManifestError);
        expect(error).toMatchObject({
          code: "invalid_deployment",
          path: "checkedBeaconProxy",
          message: "checked beacon proxy input is invalid",
        });
      }
    }
  });

  it("captures each outer getter once and owns mutable resource input", () => {
    const raw = structuredClone(input);
    let calls = 0;
    const compiled = compileCheckedBeaconProxy({
      ...raw,
      get owner() {
        calls++;
        return input.owner;
      },
    });
    expect(calls).toBe(1);
    const before = JSON.stringify(compiled);
    const implementation = raw.implementations[0];
    if (!implementation) throw new Error("missing fixture");
    Reflect.set(implementation, "expectedRuntimeCodeHash", keccak256("0x00"));
    expect(JSON.stringify(compiled)).toBe(before);
  });
});
