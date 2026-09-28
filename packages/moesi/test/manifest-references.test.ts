import { concatHex, getCreate2Address, keccak256, padHex } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  createMoesi,
  type MoesiManifest,
  parseDeploymentRunRecord,
  parseManifest,
  parseManifestText,
  parseReviewedPlan,
} from "../src/index.js";

const runtime = "0x6000";
const registry = `0x${"ab".repeat(20)}` as const;
const word = padHex(registry, { size: 32 });
const reference = { kind: "resource-address-word", resourceId: "registry" } as const;
const manifest: MoesiManifest = {
  version: "moesi.manifest/v3",
  contracts: [
    {
      kind: "managed",
      id: "counter",
      deployment: {
        kind: "create2-factory-v1",
        salt: `0x${"11".repeat(32)}`,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256(runtime),
      configuration: [
        {
          id: "registry",
          readData: "0x12345678",
          expectedResult: reference,
          writeData: { kind: "concat", parts: ["0x11223344", reference] },
          value: "0",
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
      kind: "external",
      id: "registry",
      address: registry,
      expectedRuntimeCodeHash: keccak256(runtime),
      checks: [],
      storageChecks: [],
    },
  ],
};

function observer() {
  return {
    captureSnapshot: vi.fn(async () => ({ blockNumber: "1", blockHash: `0x${"22".repeat(32)}` })),
    readCode: vi.fn(async () => runtime),
    readCall: vi.fn(async ({ data }: { data: string }) =>
      data === "0x12345678" ? padHex("0x00", { size: 32 }) : word,
    ),
    readStorage: vi.fn(async () => word),
    checkBlockAncestry: vi.fn(async () => true),
  };
}

function withExpectedResult(value: unknown): MoesiManifest {
  const resource = manifest.contracts[0];
  if (resource?.kind !== "managed" || !resource.configuration[0])
    throw new Error("invalid fixture");
  return {
    ...manifest,
    contracts: [
      {
        ...resource,
        configuration: [{ ...resource.configuration[0], expectedResult: value as never }],
      },
      ...manifest.contracts.slice(1),
    ],
  };
}

describe("explicit resource-address words", () => {
  it("resolves before observation and binds exact literal calldata into an identical plan", async () => {
    const parsed = parseManifest(manifest);
    const resource = parsed.contracts.find(({ id }) => id === "counter");
    expect(resource?.kind).toBe("managed");
    if (resource?.kind !== "managed") throw new Error("missing managed fixture");
    expect(resource.configuration[0]?.writeData).toBe(concatHex(["0x11223344", word]));
    expect(resource.configuration[0]?.expectedResult).toBe(word);
    expect(resource.checks[0]?.readData).toBe(concatHex(["0x55667788", word]));
    expect(resource.storageChecks[0]?.expectedWord).toBe(word);
    expect(resource.deployment.requiresRuntime).toEqual([]);
    expect(Object.isFrozen(resource.configuration[0])).toBe(true);
    const literal = { version: parsed.version, contracts: parsed.contracts };
    const rpc = observer();
    const client = createMoesi({ observer: rpc });
    const plan = await client.plan({ manifest, chains: [1] });
    expect(await client.plan({ manifest: literal, chains: [1] })).toEqual(plan);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.call.data).toBe(concatHex(["0x11223344", word]));
    expect(plan.requirements[0]?.calls[0]?.data).toBe(concatHex(["0x11223344", word]));
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(JSON.stringify(plan)).not.toContain("resource-address-word");
    expect(
      rpc.readCall.mock.calls.some(([input]) => input.data === concatHex(["0x55667788", word])),
    ).toBe(true);
  });

  it("accepts equivalent JSON/YAML expressions and forward declarations", () => {
    const expected = parseManifest(manifest);
    expect(parseManifestText(JSON.stringify(manifest))).toEqual(expected);
    const yaml = `version: moesi.manifest/v3\ncontracts:\n${manifest.contracts.map((resource) => `  - ${JSON.stringify(resource)}`).join("\n")}`;
    expect(parseManifestText(yaml)).toEqual(expected);
    expect(parseManifest({ ...manifest, contracts: [...manifest.contracts].reverse() })).toEqual(
      expected,
    );
  });

  it("resolves deterministic managed addresses without introducing a runtime edge", () => {
    const copy = structuredClone(manifest);
    const external = copy.contracts[1];
    const managed = copy.contracts[0];
    if (
      !external ||
      managed?.kind !== "managed" ||
      managed.deployment.kind !== "create2-factory-v1"
    )
      throw new Error("invalid fixture");
    const expected = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: managed.deployment.salt,
      bytecode: managed.deployment.initCode,
    });
    const parsed = parseManifest({
      ...copy,
      contracts: [
        managed,
        {
          ...external,
          storageChecks: [
            {
              id: "counter",
              slot: padHex("0x01", { size: 32 }),
              expectedWord: { kind: "resource-address-word", resourceId: "counter" },
            },
          ],
        },
      ],
    });
    expect(
      parsed.contracts.find(({ id }) => id === "registry")?.storageChecks[0]?.expectedWord,
    ).toBe(padHex(expected.toLowerCase() as `0x${string}`, { size: 32 }));
  });

  it.each([
    { kind: "resource-address-word", resourceId: "missing" },
    { kind: "resource-address-word", resourceId: "registry", extra: true },
    { kind: "env", resourceId: "registry" },
    { kind: "concat", parts: [] },
    { kind: "concat", parts: [{ kind: "concat", parts: ["0x00"] }] },
    { kind: "concat", parts: ["0x0"] },
    { kind: "concat", parts: Array.from({ length: 257 }, () => "0x00") },
  ])("rejects invalid or unknown expressions before RPC", async (expression) => {
    const copy = withExpectedResult(expression);
    const rpc = observer();
    await expect(
      createMoesi({ observer: rpc }).plan({ manifest: copy, chains: [1] }),
    ).rejects.toMatchObject({
      code: expression.resourceId === "missing" ? "unknown_reference" : "invalid_reference",
    });
    expect(rpc.captureSnapshot).not.toHaveBeenCalled();
  });

  it("snapshots reference fields once and rejects unknown fields/getter failures", () => {
    let reads = 0;
    let resourceId = "registry";
    const copy = withExpectedResult({
      kind: "resource-address-word",
      get resourceId() {
        reads++;
        return resourceId;
      },
    });
    const parsed = parseManifest(copy);
    expect(reads).toBe(1);
    resourceId = "missing";
    expect(
      parsed.contracts[0]?.kind === "managed" &&
        parsed.contracts[0].configuration[0]?.expectedResult,
    ).toBe(word);
    const unreadable = withExpectedResult({
      kind: "resource-address-word",
      get resourceId() {
        throw new Error("private source");
      },
    });
    expect(() => parseManifest(unreadable)).toThrowError(
      expect.objectContaining({
        code: "invalid_reference",
        message: "manifest byte expression is invalid",
      }),
    );
  });

  it("preserves byte lengths and rejects expressions in literal-only fields", () => {
    const resource = manifest.contracts[0];
    if (resource?.kind !== "managed") throw new Error("invalid fixture");
    for (const [changed, code] of [
      [
        {
          ...resource,
          checks: [{ ...resource.checks[0], readData: { kind: "concat", parts: ["0x01"] } }],
        },
        "invalid_resource",
      ],
      [
        {
          ...resource,
          storageChecks: [
            {
              ...resource.storageChecks[0],
              expectedWord: { kind: "concat", parts: [reference, "0x00"] },
            },
          ],
        },
        "invalid_resource",
      ],
      [
        { ...resource, deployment: { ...resource.deployment, initCode: reference } },
        "invalid_deployment",
      ],
      [{ ...resource, checks: [{ ...resource.checks[0], caller: reference }] }, "invalid_resource"],
    ] as const) {
      expect(() =>
        parseManifest({
          ...manifest,
          contracts: [changed, ...manifest.contracts.slice(1)],
        } as never),
      ).toThrowError(expect.objectContaining({ code }));
    }
    const parts = ["0x11223344", reference];
    Object.defineProperty(parts, "map", {
      value() {
        throw new Error("caller method executed");
      },
    });
    expect(parseManifest(withExpectedResult({ kind: "concat", parts })).contracts[0]?.kind).toBe(
      "managed",
    );
    const sparse = new Array(2);
    sparse[0] = "0x11223344";
    expect(() => parseManifest(withExpectedResult({ kind: "concat", parts: sparse }))).toThrowError(
      expect.objectContaining({ code: "invalid_reference" }),
    );
  });

  it("rejects stale schemas before field diagnostics", () => {
    expect(() =>
      parseManifest({ version: "moesi.manifest/v2", obsolete: true } as never),
    ).toThrowError(expect.objectContaining({ code: "unsupported_manifest_version" }));
    expect(() =>
      parseReviewedPlan({ version: "moesi.reviewed-plan/v2", obsolete: true } as never),
    ).toThrowError(expect.objectContaining({ code: "unsupported_plan_version" }));
    expect(() =>
      parseDeploymentRunRecord({ version: "moesi.deployment-run/v2", obsolete: true }),
    ).toThrowError(expect.objectContaining({ code: "unsupported_run_version" }));
  });
});
