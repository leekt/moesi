import { readFileSync } from "node:fs";
import { getCreate2Address, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type {
  CodeReadRequest,
  ManagedContractResource,
  MoesiObservationAdapter,
  ResolvedMoesiManifest,
  SnapshotReference,
} from "../src/index.js";
import {
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  CREATEX_DEPLOY_CREATE2_SELECTOR,
  CREATEX_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  deriveCreateXCreate2RawSalt,
  MoesiManifestError,
  MoesiPlanError,
  parseManifest,
  parseReviewedPlan,
} from "../src/index.js";
import { deriveManagedResourceAddress } from "../src/manifest/target.js";
import { compileDeploymentCall } from "../src/planning/resource.js";

const CREATE2_FACTORY_V1_RUNTIME_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;
// Deployment-patched canonical runtime for CreateX v1.0.0 (`cbac803`); the
// ordinary compiler artifact has zero immutable placeholders and a different hash.
const CREATEX_RUNTIME_CODE = readFileSync(
  new URL("./fixtures/CreateX.runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;
const OWNER = "0xc3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab" as const;
const ENTROPY = "0x04a9469db98e61f23775c1" as const;
const INIT_CODE = "0x6080" as const;
const RAW_SALT = "0xc3a5e4c8a4f4eb9d8a4eb9d8a4eb9d8a4eb44aab0004a9469db98e61f23775c1" as const;
const CREATEX_TARGET = "0x9e66e2c5c6df57a7465bd4f1ece3ad00449bf05c" as const;

const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

function createXManifest(
  input: {
    readonly entropy?: Hex;
    readonly sender?: unknown;
    readonly includeSender?: boolean;
  } = {},
): ResolvedMoesiManifest {
  return {
    version: "moesi.manifest/v3",
    contracts: [
      {
        kind: "managed",
        id: "createx",
        deployment: {
          kind: "createx-create2-v1",
          entropy: input.entropy ?? ENTROPY,
          initCode: INIT_CODE,
          value: "7",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: keccak256("0x6000"),
        configuration: [],
        checks: [],
        storageChecks: [],
        ...(input.includeSender === false
          ? {}
          : { sender: input.sender ?? { kind: "owner-eoa", address: OWNER } }),
      } as ManagedContractResource,
    ],
  };
}

function arachnidResource(): ManagedContractResource {
  return {
    kind: "managed",
    id: "arachnid",
    deployment: {
      kind: "create2-factory-v1",
      salt: hash("a"),
      initCode: INIT_CODE,
      value: "0",
      requiresRuntime: [],
    },
    expectedRuntimeCodeHash: keccak256("0x6000"),
    configuration: [],
    checks: [],
    storageChecks: [],
  };
}

function mixedManifest(): ResolvedMoesiManifest {
  return {
    version: "moesi.manifest/v3",
    contracts: [arachnidResource(), ...(createXManifest().contracts as ManagedContractResource[])],
  };
}

function missingObserver(
  input: { readonly arachnidFactoryCode?: Hex; readonly createXFactoryCode?: Hex } = {},
): { readonly adapter: MoesiObservationAdapter; readonly reads: CodeReadRequest[] } {
  const reads: CodeReadRequest[] = [];
  return {
    reads,
    adapter: {
      async captureSnapshot(): Promise<SnapshotReference> {
        return { blockNumber: "100", blockHash: hash("1") };
      },
      async readCode(request): Promise<Hex> {
        reads.push(request);
        if (request.address === CREATE2_FACTORY_V1_ADDRESS) {
          return input.arachnidFactoryCode ?? CREATE2_FACTORY_V1_RUNTIME_CODE;
        }
        if (request.address === CREATEX_FACTORY_V1_ADDRESS) {
          return input.createXFactoryCode ?? CREATEX_RUNTIME_CODE;
        }
        return "0x";
      },
      async readCall(): Promise<Hex> {
        return "0x";
      },
      async checkBlockAncestry(): Promise<boolean> {
        return true;
      },
    },
  };
}

function createXResource(manifest: ResolvedMoesiManifest): ManagedContractResource {
  const resource = manifest.contracts.find(({ id }) => id === "createx");
  if (resource?.kind !== "managed" || resource.deployment.kind !== "createx-create2-v1") {
    throw new Error("CreateX test resource disappeared");
  }
  return resource;
}

function expectManifestError(operation: () => unknown, code: MoesiManifestError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoesiManifestError);
    expect((error as MoesiManifestError).code).toBe(code);
    return;
  }
  throw new Error(`expected MoesiManifestError ${code}`);
}

function expectPlanError(operation: () => unknown, code: MoesiPlanError["code"]): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoesiPlanError);
    expect((error as MoesiPlanError).code).toBe(code);
    return;
  }
  throw new Error(`expected MoesiPlanError ${code}`);
}

describe("CreateX CREATE2 manifest strategy", () => {
  it("normalizes exact entropy and binds the strategy to one owner EOA", () => {
    const parsed = parseManifest(
      createXManifest({ entropy: ENTROPY.toUpperCase().replace("0X", "0x") as Hex }),
    );
    const resource = createXResource(parsed);

    expect(resource.deployment).toMatchObject({
      kind: "createx-create2-v1",
      entropy: ENTROPY,
      initCode: INIT_CODE,
      value: "7",
      requiresRuntime: [],
    });
    expect(resource.sender).toEqual({ kind: "owner-eoa", address: OWNER });

    expectManifestError(
      () => parseManifest(createXManifest({ includeSender: false })),
      "invalid_sender",
    );
    expectManifestError(
      () =>
        parseManifest(
          createXManifest({ sender: { kind: "smart-account", accountId: "kernel:ops" } }),
        ),
      "invalid_sender",
    );
    expectManifestError(
      () =>
        parseManifest(
          createXManifest({
            sender: { kind: "owner-eoa", address: "0x0000000000000000000000000000000000000000" },
          }),
        ),
      "invalid_sender",
    );
  });

  it.each([
    "0x",
    "0x1234",
    `0x${"a".repeat(20)}`,
    `0x${"a".repeat(24)}`,
    "0xgggggggggggggggggggggg",
  ])("rejects hostile entropy %s", (entropy) => {
    expectManifestError(
      () => parseManifest(createXManifest({ entropy: entropy as Hex })),
      "invalid_deployment",
    );
  });

  it("snapshots a readable entropy accessor once and rejects strategy escape hatches", () => {
    let reads = 0;
    const base = createXResource(createXManifest());
    const deployment = Object.create(null) as Record<string, unknown>;
    Object.assign(deployment, {
      kind: "createx-create2-v1",
      initCode: INIT_CODE,
      value: "7",
      requiresRuntime: [],
    });
    Object.defineProperty(deployment, "entropy", {
      enumerable: true,
      get() {
        reads += 1;
        return ENTROPY;
      },
    });
    const parsed = parseManifest({
      version: "moesi.manifest/v3",
      contracts: [{ ...base, deployment: deployment as never }],
    });
    expect(createXResource(parsed).deployment).toMatchObject({ entropy: ENTROPY });
    expect(reads).toBe(1);

    for (const [field, value] of [
      ["salt", hash("a")],
      ["rawSalt", RAW_SALT],
      ["guard", "none"],
      ["factory", CREATEX_FACTORY_V1_ADDRESS],
    ] as const) {
      expectManifestError(
        () =>
          parseManifest({
            version: "moesi.manifest/v3",
            contracts: [
              {
                ...base,
                deployment: { ...base.deployment, [field]: value } as never,
              },
            ],
          }),
        "unknown_field",
      );
    }
  });
});

describe("CreateX CREATE2 planning", () => {
  it("matches a known sender-protected salt, target, and deploy call vector", () => {
    expect(keccak256(CREATEX_RUNTIME_CODE)).toBe(CREATEX_FACTORY_V1_RUNTIME_CODE_HASH);
    expect(
      deriveCreateXCreate2RawSalt({
        sender: OWNER.toUpperCase().replace("0X", "0x") as typeof OWNER,
        entropy: ENTROPY.toUpperCase().replace("0X", "0x") as Hex,
      }),
    ).toBe(RAW_SALT);

    const resource = createXResource(parseManifest(createXManifest()));
    expect(deriveManagedResourceAddress(resource)).toBe(CREATEX_TARGET);
    const call = compileDeploymentCall(resource);
    expect(call.target).toBe(CREATEX_FACTORY_V1_ADDRESS);
    expect(call.value).toBe("7");
    expect(call.data.slice(0, 10)).toBe(CREATEX_DEPLOY_CREATE2_SELECTOR);
    expect(call.data.slice(10, 74)).toBe(RAW_SALT.slice(2));
  });

  it("snapshots hostile direct salt inputs once", () => {
    let senderReads = 0;
    let entropyReads = 0;
    const input = Object.create(null) as { readonly sender: typeof OWNER; readonly entropy: Hex };
    Object.defineProperties(input, {
      sender: {
        enumerable: true,
        get() {
          senderReads += 1;
          return OWNER;
        },
      },
      entropy: {
        enumerable: true,
        get() {
          entropyReads += 1;
          return ENTROPY;
        },
      },
    });

    expect(deriveCreateXCreate2RawSalt(input)).toBe(RAW_SALT);
    expect(senderReads).toBe(1);
    expect(entropyReads).toBe(1);
  });

  it("captures both canonical factories by chain and strategy kind", async () => {
    const observed = missingObserver();
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: mixedManifest(),
      chains: [1],
    });

    expect(plan.capabilities).toEqual([
      {
        kind: "create2-factory-v1",
        chainId: 1,
        address: CREATE2_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available",
          observedRuntimeCodeHash: CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      },
      {
        kind: "createx-factory-v1",
        chainId: 1,
        address: CREATEX_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available",
          observedRuntimeCodeHash: CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      },
    ]);
    expect(plan.steps.map(({ id }) => id)).toEqual(["arachnid:deploy", "createx:deploy"]);
    expect(plan.steps[1]?.call.target).toBe(CREATEX_FACTORY_V1_ADDRESS);
    expect(plan.steps[1]?.sender).toEqual({ kind: "reviewed-owner-eoa", address: OWNER });
    expect(
      observed.reads.filter(
        ({ address }) =>
          address === CREATE2_FACTORY_V1_ADDRESS || address === CREATEX_FACTORY_V1_ADDRESS,
      ),
    ).toHaveLength(2);
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it.each([
    {
      label: "CreateX",
      arachnidFactoryCode: CREATE2_FACTORY_V1_RUNTIME_CODE,
      createXFactoryCode: "0x" as Hex,
      actionable: "arachnid:deploy",
      blockedKind: "createx-factory-v1",
    },
    {
      label: "Arachnid",
      arachnidFactoryCode: "0x" as Hex,
      createXFactoryCode: CREATEX_RUNTIME_CODE,
      actionable: "createx:deploy",
      blockedKind: "create2-factory-v1",
    },
  ])("blocks only the $label deployment when its own factory is absent", async (input) => {
    const observed = missingObserver(input);
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: mixedManifest(),
      chains: [1],
    });

    expect(plan.disposition).toBe("partial");
    expect(plan.steps.map(({ id }) => id)).toEqual([input.actionable]);
    expect(plan.capabilities.find(({ kind }) => kind === input.blockedKind)?.status).toEqual({
      kind: "missing",
    });
  });

  it("recomputes per-factory capability identity and actionability at the reviewed boundary", async () => {
    const observed = missingObserver();
    const plan = await createMoesi({ observer: observed.adapter }).plan({
      manifest: mixedManifest(),
      chains: [1],
    });

    const wrongKind = JSON.parse(JSON.stringify(plan));
    wrongKind.capabilities[1].kind = "createx-create2-v1";
    expectPlanError(() => parseReviewedPlan(wrongKind), "invalid_capability");

    const wrongFactory = JSON.parse(JSON.stringify(plan));
    wrongFactory.capabilities[1].address = CREATE2_FACTORY_V1_ADDRESS;
    expectPlanError(() => parseReviewedPlan(wrongFactory), "invalid_capability");

    const wrongRuntime = JSON.parse(JSON.stringify(plan));
    wrongRuntime.capabilities[1].status.observedRuntimeCodeHash =
      CREATE2_FACTORY_V1_RUNTIME_CODE_HASH;
    expectPlanError(() => parseReviewedPlan(wrongRuntime), "invalid_capability");

    const missingCapability = JSON.parse(JSON.stringify(plan));
    missingCapability.capabilities.pop();
    expectPlanError(() => parseReviewedPlan(missingCapability), "missing_capability");

    const newlyBlocked = JSON.parse(JSON.stringify(plan));
    newlyBlocked.capabilities[1].status = { kind: "missing" };
    expectPlanError(() => parseReviewedPlan(newlyBlocked), "orphan_step");

    const wrongCall = JSON.parse(JSON.stringify(plan));
    wrongCall.steps[1].call.target = CREATE2_FACTORY_V1_ADDRESS;
    expectPlanError(() => parseReviewedPlan(wrongCall), "orphan_step");

    const wrongEntropy = JSON.parse(JSON.stringify(plan));
    wrongEntropy.manifest.contracts[1].deployment.entropy = "0x04a9469db98e61f23775c2";
    expectPlanError(() => parseReviewedPlan(wrongEntropy), "manifest_mismatch");
  });
});

it("keeps the Arachnid target vector unchanged", () => {
  const resource = arachnidResource();
  if (resource.deployment.kind !== "create2-factory-v1") throw new Error("test strategy changed");
  expect(deriveManagedResourceAddress(resource)).toBe(
    getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: resource.deployment.salt,
      bytecodeHash: keccak256(resource.deployment.initCode),
    }).toLowerCase(),
  );
});
