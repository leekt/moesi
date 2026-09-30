import { readFileSync } from "node:fs";
import { encodeAbiParameters, type Hex, keccak256, padHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeCodeHash,
  type MoesiManifest,
  type MoesiObservationAdapter,
  observeRuntimeIdentity,
  parseManifest,
  parseManifestText,
  predictManifestAddresses,
  serializeManifest,
} from "../src/index.js";

const runtime = "0x6000";
const registry = `0x${"ab".repeat(20)}` as const;
const owner = "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa" as const;
const reference = { kind: "resource-address-word", resourceId: "registry" } as const;
const peer = {
  chainId: 10,
  address: `0x${"cd".repeat(20)}`,
  expectedRuntimeCodeHash: keccak256(runtime),
} as const;

const manifest: MoesiManifest = {
  version: "moesi.manifest/v6",
  contracts: [
    {
      kind: "managed",
      id: "zeta-counter",
      deployment: {
        kind: "create2-factory-v1",
        salt: `0x${"11".repeat(32)}`,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: ["registry"],
      },
      expectedRuntimeCodeHash: keccak256(runtime),
      configuration: [
        {
          id: "registry",
          readData: "0x12345678",
          expectedResult: reference,
          writeData: { kind: "concat", parts: ["0x11223344", reference] },
          value: "7",
        },
        {
          id: "route",
          readData: `0xaabbccdd${"00".repeat(31)}01`,
          expectedResult: padHex("0x01", { size: 32 }),
          writeData: `0x11111111${encodeAbiParameters([{ type: "uint256[]" }], [[1n]]).slice(2)}`,
          value: "0",
          batch: { key: "routes", parameters: ["uint256[]"], maxRows: 16 },
          after: [peer],
        },
      ],
      checks: [
        {
          id: "registry",
          caller: registry,
          readData: { kind: "concat", parts: ["0x55667788", reference] },
          expectedResult: reference,
        },
      ],
      storageChecks: [
        { id: "registry", slot: padHex("0x01", { size: 32 }), expectedWord: reference },
      ],
    },
    {
      kind: "managed",
      id: "adapter",
      deployment: {
        kind: "createx-create3-v1",
        entropy: "0x04A9469DB98E61F23775C1",
        initCode: "0x6002600c60003960026000f36000",
        value: "0",
        requiresRuntime: [],
      },
      sender: { kind: "smart-account", accountId: "fleet", address: owner },
      enforcement: {
        callScope: "required-onchain",
        expiry: "required",
        operationLimit: "optional",
      },
      expectedRuntimeCodeHash: keccak256(runtime),
      configuration: [],
      checks: [],
      storageChecks: [],
    },
    {
      kind: "managed",
      id: "unguarded",
      deployment: {
        kind: "createx-create2-unguarded-v1",
        entropy: `0x${"61".repeat(11)}`,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256(runtime),
      configuration: [],
      checks: [],
      storageChecks: [],
    },
    {
      kind: "external",
      id: "registry",
      address: registry,
      expectedRuntimeCodeHash: keccak256(runtime),
      checks: [],
      storageChecks: [],
      semanticChecks: [{ kind: "ownable-owner", id: "owner", caller: owner, expectedOwner: owner }],
    },
  ],
};

describe("serializeManifest", () => {
  it.each(["json", "yaml"] as const)(
    "round-trips %s to the same manifest hash and predicted addresses",
    (format) => {
      const expected = parseManifest(manifest);
      const text = serializeManifest(manifest, { format });
      const reparsed = parseManifestText(text);
      expect(reparsed.manifestHash).toBe(expected.manifestHash);
      expect(reparsed).toEqual(expected);
      expect(predictManifestAddresses(reparsed)).toEqual(predictManifestAddresses(manifest));
      // Canonical output: re-serializing the parsed text is byte-identical.
      expect(serializeManifest(reparsed, { format })).toBe(text);
      expect(serializeManifest(expected, { format })).toBe(text);
      expect(text.endsWith("\n")).toBe(true);
      expect(text).not.toContain("manifestHash");
    },
  );

  it("writes JSON and YAML 1.2 documents with exact quoted hex and decimal strings", () => {
    const json = serializeManifest(manifest, { format: "json" });
    expect(JSON.parse(json).version).toBe("moesi.manifest/v6");
    const yaml = serializeManifest(manifest, { format: "yaml" });
    expect(yaml.startsWith("---\nversion: moesi.manifest/v6\n")).toBe(true);
    // Hex and decimal quantities would otherwise resolve as YAML integers.
    expect(yaml).toMatch(/initCode: "0x6000"/);
    expect(yaml).toMatch(/value: "7"/);
    expect(yaml).not.toMatch(/[&*]\w/);
  });

  it("round-trips the published example manifest", () => {
    const source = readFileSync(
      new URL("../../../examples/minimal.manifest.json", import.meta.url),
      "utf8",
    );
    const expected = parseManifestText(source);
    for (const format of ["json", "yaml"] as const) {
      expect(parseManifestText(serializeManifest(expected, { format })).manifestHash).toBe(
        expected.manifestHash,
      );
    }
  });

  it("validates the manifest and options before writing anything", () => {
    expect(() =>
      serializeManifest({ ...manifest, version: "moesi.manifest/v5" } as never, {
        format: "json",
      }),
    ).toThrow(expect.objectContaining({ code: "unsupported_manifest_version" }));
    for (const options of [undefined, null, {}, { format: "toml" }, { format: "json", x: 1 }]) {
      expect(() => serializeManifest(manifest, options as never)).toThrow(
        expect.objectContaining({ code: "invalid_manifest", path: "options.format" }),
      );
    }
  });
});

describe("runtime identity authoring", () => {
  it("derives the exact runtime code hash from compiler runtime bytes", () => {
    expect(deriveRuntimeCodeHash("0x6000")).toBe(keccak256("0x6000"));
    expect(deriveRuntimeCodeHash("0xABCD")).toBe(keccak256("0xabcd"));
    for (const code of ["0x", "0x1", "6000", 1]) {
      expect(() => deriveRuntimeCodeHash(code as never)).toThrow(
        expect.objectContaining({ code: "invalid_resource", path: "runtimeCode" }),
      );
    }
  });

  function observer(code: unknown): MoesiObservationAdapter {
    return {
      captureSnapshot: vi.fn(async () => ({
        blockNumber: "9",
        blockHash: `0x${"22".repeat(32)}`,
      })),
      readCode: vi.fn(async () => {
        if (code instanceof Error) throw code;
        return code;
      }),
      readCall: vi.fn(async () => "0x"),
      checkBlockAncestry: vi.fn(async () => true),
    };
  }

  it("hashes observed code at one pinned snapshot and compares it with an expectation", async () => {
    const adapter = observer("0x6000");
    const address = `0x${"AB".repeat(20)}` as const;
    const observed = await observeRuntimeIdentity({ observer: adapter, chainId: 1, address });
    expect(observed).toEqual({
      kind: "observed",
      chainId: 1,
      address: address.toLowerCase(),
      snapshot: { chainId: 1, blockNumber: "9", blockHash: `0x${"22".repeat(32)}` },
      runtimeCodeHash: keccak256("0x6000"),
      matchesExpected: null,
    });
    expect(Object.isFrozen(observed)).toBe(true);
    expect(adapter.readCode).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 1,
        address: address.toLowerCase(),
        snapshot: observed.snapshot,
      }),
    );
    await expect(
      observeRuntimeIdentity({
        observer: adapter,
        chainId: 1,
        address,
        expectedRuntimeCodeHash: keccak256("0x6000").toUpperCase().replace("0X", "0x") as Hex,
      }),
    ).resolves.toMatchObject({ matchesExpected: true });
    await expect(
      observeRuntimeIdentity({
        observer: adapter,
        chainId: 1,
        address,
        expectedRuntimeCodeHash: keccak256("0x6001"),
      }),
    ).resolves.toMatchObject({ matchesExpected: false });
  });

  it("reports absent and unreadable code without retaining provider causes", async () => {
    const address = registry;
    await expect(
      observeRuntimeIdentity({ observer: observer("0x"), chainId: 1, address }),
    ).resolves.toMatchObject({ kind: "absent" });
    const failed = await observeRuntimeIdentity({
      observer: observer(new Error("https://secret.example/key")),
      chainId: 1,
      address,
    });
    expect(failed).toMatchObject({ kind: "unreadable", reason: "read-failed" });
    expect(JSON.stringify(failed)).not.toContain("secret");
    await expect(
      observeRuntimeIdentity({ observer: observer(7), chainId: 1, address }),
    ).resolves.toMatchObject({ kind: "unreadable", reason: "invalid-response" });
  });

  it("validates inputs before observation", async () => {
    const adapter = observer("0x6000");
    for (const input of [
      { observer: null, chainId: 1, address: registry },
      { observer: adapter, chainId: 0, address: registry },
      { observer: adapter, chainId: 1, address: "0x12" },
      { observer: adapter, chainId: 1, address: registry, expectedRuntimeCodeHash: "0x12" },
    ]) {
      await expect(observeRuntimeIdentity(input as never)).rejects.toMatchObject({
        code: "invalid_resource",
      });
    }
    expect(adapter.captureSnapshot).not.toHaveBeenCalled();
  });
});
