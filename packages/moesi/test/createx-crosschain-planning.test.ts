import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  getCreate2Address,
  type Hex,
  keccak256,
} from "viem";
import { describe, expect, it } from "vitest";
import type { MoesiManifest } from "../src/index.js";
import {
  CREATEX_CREATE3_PROXY_INIT_CODE_HASH,
  CREATEX_FACTORY_V1_ADDRESS,
  compileDeploymentRecipe,
  createPlan,
  deriveCreateXCrosschainRawSalt,
  deriveCreateXSenderCrosschainRawSalt,
  MoesiManifestError,
  parseManifest,
  parseReviewedPlan,
  predictManifestAddresses,
  resourceChainBinding,
  reviewPlan,
} from "../src/index.js";
import { compileDeploymentCall } from "../src/planning/resource.js";

const ENTROPY = "0x0000000000000000001820" as const;
const INIT_CODE = "0x6080604052348015600e575f5ffd5b50607980601a5f395ff3fe" as const;
const SENDER = "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa" as const;
const CHAIN_ID = 42_161;
const RUNTIME_HASH = "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f";

const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

type CrosschainKind =
  | "createx-create2-crosschain-v1"
  | "createx-create3-crosschain-v1"
  | "createx-create2-sender-crosschain-v1"
  | "createx-create3-sender-crosschain-v1";

const SENDER_KINDS = new Set<CrosschainKind>([
  "createx-create2-sender-crosschain-v1",
  "createx-create3-sender-crosschain-v1",
]);

function manifest(
  kind: CrosschainKind,
  overrides: Record<string, unknown> = {},
  sender: unknown = SENDER_KINDS.has(kind) ? { kind: "owner-eoa", address: SENDER } : undefined,
): MoesiManifest {
  return {
    version: "moesi.manifest/v7",
    contracts: [
      {
        kind: "managed",
        id: "legacy",
        deployment: {
          kind,
          chainId: CHAIN_ID,
          entropy: ENTROPY,
          initCode: INIT_CODE,
          value: "0",
          requiresRuntime: [],
          ...overrides,
        },
        ...(sender === undefined ? {} : { sender }),
        expectedRuntimeCodeHash: hash("d"),
        configuration: [],
        checks: [],
        storageChecks: [],
      } as never,
    ],
  };
}

/** Independent restatement of CreateX `_guard` for the two crosschain branches. */
function expectedAddress(kind: CrosschainKind, chainId: number): Hex {
  const senderBound = SENDER_KINDS.has(kind);
  const rawSalt = concatHex([
    senderBound ? SENDER : `0x${"00".repeat(20)}`,
    "0x01",
    ENTROPY,
  ]).toLowerCase() as Hex;
  const guardedSalt = senderBound
    ? keccak256(
        encodeAbiParameters(
          [{ type: "address" }, { type: "uint256" }, { type: "bytes32" }],
          [SENDER, BigInt(chainId), rawSalt],
        ),
      )
    : keccak256(
        encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [BigInt(chainId), rawSalt]),
      );
  const create3 = kind.startsWith("createx-create3");
  const deployed = getCreate2Address({
    from: CREATEX_FACTORY_V1_ADDRESS,
    salt: guardedSalt,
    bytecodeHash: create3 ? CREATEX_CREATE3_PROXY_INIT_CODE_HASH : keccak256(INIT_CODE),
  });
  return (
    create3 ? getContractAddress({ opcode: "CREATE", from: deployed, nonce: 1n }) : deployed
  ).toLowerCase() as Hex;
}

const KINDS: readonly CrosschainKind[] = [
  "createx-create2-crosschain-v1",
  "createx-create3-crosschain-v1",
  "createx-create2-sender-crosschain-v1",
  "createx-create3-sender-crosschain-v1",
];

describe("crosschain-protected CreateX strategies", () => {
  it("derives raw salts with the 0x01 crosschain flag", () => {
    expect(deriveCreateXCrosschainRawSalt(ENTROPY)).toBe(
      `0x${"00".repeat(20)}01${ENTROPY.slice(2)}`,
    );
    expect(deriveCreateXSenderCrosschainRawSalt({ sender: SENDER, entropy: ENTROPY })).toBe(
      `${SENDER}01${ENTROPY.slice(2)}`,
    );
    expect(() => deriveCreateXCrosschainRawSalt("0x00")).toThrow(MoesiManifestError);
    expect(() =>
      deriveCreateXSenderCrosschainRawSalt({ sender: `0x${"00".repeat(20)}`, entropy: ENTROPY }),
    ).toThrow(expect.objectContaining({ code: "invalid_sender" }));
  });

  it.each(KINDS)("predicts %s from the chain-bound CreateX guard", (kind) => {
    const [predicted] = predictManifestAddresses(manifest(kind));
    expect(predicted?.address).toBe(expectedAddress(kind, CHAIN_ID));
    const [otherChain] = predictManifestAddresses(manifest(kind, { chainId: 1 }));
    expect(otherChain?.address).toBe(expectedAddress(kind, 1));
    expect(otherChain?.address).not.toBe(predicted?.address);
  });

  it.each(KINDS)("compiles %s calldata with the raw salt", (kind) => {
    const parsed = parseManifest(manifest(kind));
    const resource = parsed.contracts[0];
    if (resource?.kind !== "managed") throw new Error("missing managed resource");
    expect(resourceChainBinding(resource)).toBe(CHAIN_ID);
    const create3 = kind.startsWith("createx-create3");
    const rawSalt = SENDER_KINDS.has(kind)
      ? deriveCreateXSenderCrosschainRawSalt({ sender: SENDER, entropy: ENTROPY })
      : deriveCreateXCrosschainRawSalt(ENTROPY);
    const compiled = compileDeploymentRecipe({
      deployment: resource.deployment,
      ...(resource.sender === undefined ? {} : { sender: resource.sender }),
    } as never);
    expect(compiled.address).toBe(expectedAddress(kind, CHAIN_ID));
    expect(compiled.call).toEqual({
      target: CREATEX_FACTORY_V1_ADDRESS,
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: create3 ? "deployCreate3" : "deployCreate2",
            stateMutability: "payable",
            inputs: [
              { name: "salt", type: "bytes32" },
              { name: "initCode", type: "bytes" },
            ],
            outputs: [{ name: "newContract", type: "address" }],
          },
        ],
        args: [rawSalt, INIT_CODE],
      }),
      value: "0",
    });
  });

  it("keeps CREATE3 crosschain targets independent of init code", () => {
    for (const kind of [
      "createx-create3-crosschain-v1",
      "createx-create3-sender-crosschain-v1",
    ] as const) {
      const [left] = predictManifestAddresses(manifest(kind));
      const [right] = predictManifestAddresses(manifest(kind, { initCode: "0x6000" }));
      expect(left?.address).toBe(right?.address);
    }
  });

  it("validates chainId, entropy and sender requirements at the manifest boundary", () => {
    for (const kind of KINDS) {
      for (const chainId of [undefined, 0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseManifest(manifest(kind, { chainId }))).toThrow(
          expect.objectContaining({ code: "invalid_deployment" }),
        );
      }
      expect(() => parseManifest(manifest(kind, { entropy: "0x00" }))).toThrow(
        expect.objectContaining({
          code: "invalid_deployment",
          path: expect.stringMatching(/entropy$/),
        }),
      );
      expect(() => parseManifest(manifest(kind, { salt: hash("1") }))).toThrow(MoesiManifestError);
    }
    for (const kind of SENDER_KINDS) {
      expect(() => parseManifest(manifest(kind, {}, null))).toThrow(MoesiManifestError);
      expect(() =>
        parseManifest(manifest(kind, {}, { kind: "owner-eoa", address: `0x${"00".repeat(20)}` })),
      ).toThrow(expect.objectContaining({ code: "invalid_sender" }));
    }
    const unbound = parseManifest(manifest("createx-create2-crosschain-v1"));
    expect(unbound.contracts[0]?.kind === "managed" && unbound.contracts[0].sender).toBe(undefined);
  });

  it("rejects planning a chain-bound resource on any other chain before observation", async () => {
    const parsed = parseManifest(manifest("createx-create2-crosschain-v1"));
    let observed = false;
    const observer = {
      async captureSnapshot() {
        observed = true;
        return { blockNumber: "1", blockHash: hash("1") };
      },
      async readCode() {
        observed = true;
        return "0x" as Hex;
      },
      async readCall() {
        return "0x" as Hex;
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    await expect(
      createPlan({ manifest: parsed, chains: [CHAIN_ID, 1], observer }),
    ).rejects.toMatchObject({
      name: "MoesiPlanningError",
      code: "chain_bound_resource",
      chainId: 1,
    });
    expect(observed).toBe(false);
  });

  it("round-trips the reviewed-plan codec and rejects a cell on a foreign chain", () => {
    const parsed = parseManifest(manifest("createx-create3-sender-crosschain-v1"));
    const resource = parsed.contracts[0];
    if (resource?.kind !== "managed") throw new Error("missing managed resource");
    const address = expectedAddress("createx-create3-sender-crosschain-v1", CHAIN_ID);
    const input = (chainId: number) => ({
      manifest: { version: parsed.version, contracts: parsed.contracts },
      snapshots: [{ chainId, blockNumber: "1", blockHash: hash("1") }],
      capabilities: [
        {
          kind: "createx-factory-v1" as const,
          chainId,
          address: CREATEX_FACTORY_V1_ADDRESS,
          expectedRuntimeCodeHash: RUNTIME_HASH,
          status: { kind: "available" as const, observedRuntimeCodeHash: RUNTIME_HASH },
        },
      ],
      cells: [
        {
          resourceId: "legacy",
          chainId,
          address,
          expectedRuntimeCodeHash: hash("d"),
          configuration: [],
          checks: [],
          storageChecks: [],
          status: { kind: "missing" as const },
        },
      ],
      steps: [
        {
          id: "legacy:deploy",
          resourceId: "legacy",
          chainId,
          kind: "deploy" as const,
          configurationIds: [],
          drift: "missing" as const,
          call: compileDeploymentCall(resource),
          postconditions: [
            { kind: "runtime-code-hash" as const, address, expectedHash: hash("d") },
          ],
          sender: { kind: "reviewed-owner-eoa" as const, address: SENDER },
          enforcement: {
            callScope: "interactive-review-sufficient" as const,
            expiry: "optional" as const,
            operationLimit: "optional" as const,
          },
        },
      ],
    });
    const plan = reviewPlan(input(CHAIN_ID) as never);
    expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan))).planId).toBe(plan.planId);
    expect(() => reviewPlan(input(1) as never)).toThrow(
      expect.objectContaining({ name: "MoesiPlanError", code: "manifest_mismatch" }),
    );
  });
});
