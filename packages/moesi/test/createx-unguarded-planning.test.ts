import { encodeAbiParameters, getCreate2Address, type Hex, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { MoesiManifest } from "../src/index.js";
import {
  CREATEX_CREATE3_PROXY_INIT_CODE_HASH,
  CREATEX_DEPLOY_CREATE2_SELECTOR,
  CREATEX_DEPLOY_CREATE3_SELECTOR,
  CREATEX_FACTORY_V1_ADDRESS,
  deriveCreateXUnguardedRawSalt,
  MoesiManifestError,
  parseManifest,
  parseReviewedPlan,
  reviewPlan,
} from "../src/index.js";
import { deriveManagedResourceAddress } from "../src/manifest/target.js";
import { compileDeploymentCall } from "../src/planning/resource.js";

// Vectors proven against the pinned CreateX runtime on Anvil: deployCreate2 /
// deployCreate3 with this raw salt deployed code at exactly these addresses.
const ENTROPY = "0x0000000000000000001820" as const;
const INIT_CODE = "0x6080604052348015600e575f5ffd5b50607980601a5f395ff3fe" as const;
const RAW_SALT = `0x${"00".repeat(20)}00${ENTROPY.slice(2)}` as Hex;
const CREATE2_TARGET = "0xc43833bb2b6e5af0d9079ddc036d9ad87b4f7e92" as const;
const CREATE3_TARGET = "0x3fb299c23cbdf98bedb978ae17bc80d38e3de47c" as const;

const hash = (byte: string) => `0x${byte.repeat(64)}` as const;

function unguardedManifest(
  kind: "createx-create2-unguarded-v1" | "createx-create3-unguarded-v1",
  overrides: Record<string, unknown> = {},
): MoesiManifest {
  return {
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "managed",
        id: "kernel-impl",
        deployment: {
          kind,
          entropy: ENTROPY,
          initCode: INIT_CODE,
          value: "0",
          requiresRuntime: [],
          ...overrides,
        },
        expectedRuntimeCodeHash: hash("d"),
        configuration: [],
        checks: [],
        storageChecks: [],
      } as never,
    ],
  };
}

describe("unguarded CreateX strategies", () => {
  it("derives the raw salt as zero-address, 0x00 flag, entropy", () => {
    expect(deriveCreateXUnguardedRawSalt(ENTROPY)).toBe(RAW_SALT);
    expect(deriveCreateXUnguardedRawSalt("0xAAbbccddeeff0011223344")).toBe(
      `0x${"00".repeat(20)}00aabbccddeeff0011223344`,
    );
    for (const bad of ["0x", "0x00", `0x${"00".repeat(12)}`, "zz", 7]) {
      expect(() => deriveCreateXUnguardedRawSalt(bad)).toThrow(MoesiManifestError);
    }
  });

  it("matches the anvil-proven unguarded CREATE2 vector", () => {
    const manifest = parseManifest(unguardedManifest("createx-create2-unguarded-v1"));
    const resource = manifest.contracts[0];
    if (resource?.kind !== "managed") throw new Error("missing managed resource");
    expect(deriveManagedResourceAddress(resource)).toBe(CREATE2_TARGET);
    const call = compileDeploymentCall(resource);
    expect(call.target).toBe(CREATEX_FACTORY_V1_ADDRESS);
    expect(call.data).toBe(
      `${CREATEX_DEPLOY_CREATE2_SELECTOR}${encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes" }],
        [RAW_SALT, INIT_CODE],
      ).slice(2)}`,
    );
    // The guarded salt CreateX derives for this shape is keccak256(abi.encode(rawSalt)).
    expect(
      getCreate2Address({
        from: CREATEX_FACTORY_V1_ADDRESS,
        salt: keccak256(encodeAbiParameters([{ type: "bytes32" }], [RAW_SALT])),
        bytecodeHash: keccak256(INIT_CODE),
      }).toLowerCase(),
    ).toBe(CREATE2_TARGET);
  });

  it("matches the anvil-proven unguarded CREATE3 vector independent of initCode", () => {
    const manifest = parseManifest(unguardedManifest("createx-create3-unguarded-v1"));
    const resource = manifest.contracts[0];
    if (resource?.kind !== "managed") throw new Error("missing managed resource");
    expect(deriveManagedResourceAddress(resource)).toBe(CREATE3_TARGET);
    const call = compileDeploymentCall(resource);
    expect(call.target).toBe(CREATEX_FACTORY_V1_ADDRESS);
    expect(call.data.startsWith(CREATEX_DEPLOY_CREATE3_SELECTOR)).toBe(true);

    const otherInitCode = parseManifest(
      unguardedManifest("createx-create3-unguarded-v1", { initCode: "0x60016001" }),
    ).contracts[0];
    if (otherInitCode?.kind !== "managed") throw new Error("missing managed resource");
    expect(deriveManagedResourceAddress(otherInitCode)).toBe(CREATE3_TARGET);
    expect(CREATEX_CREATE3_PROXY_INIT_CODE_HASH).toBe(
      keccak256("0x67363d3d37363d34f03d5260086018f3"),
    );
  });

  it("accepts sender-independent resources and validates entropy at the boundary", () => {
    // No sender declared: unguarded deployments are executable by anyone.
    const parsed = parseManifest(unguardedManifest("createx-create2-unguarded-v1"));
    const resource = parsed.contracts[0];
    if (resource?.kind !== "managed") throw new Error("missing managed resource");
    expect(resource.sender).toBeUndefined();
    expect(resource.deployment.kind).toBe("createx-create2-unguarded-v1");

    expect(() =>
      parseManifest(unguardedManifest("createx-create2-unguarded-v1", { entropy: "0x00" })),
    ).toThrow(MoesiManifestError);
    expect(() =>
      parseManifest(unguardedManifest("createx-create3-unguarded-v1", { salt: hash("1") })),
    ).toThrow(MoesiManifestError);
  });

  it("round-trips both strategies through the reviewed-plan codec with a stable planId", async () => {
    for (const kind of ["createx-create2-unguarded-v1", "createx-create3-unguarded-v1"] as const) {
      const manifest = parseManifest(unguardedManifest(kind));
      const resource = manifest.contracts[0];
      if (resource?.kind !== "managed") throw new Error("missing managed resource");
      const address = deriveManagedResourceAddress(resource);
      const plan = reviewPlan({
        manifest: { version: manifest.version, contracts: manifest.contracts },
        snapshots: [{ chainId: 1, blockNumber: "1", blockHash: hash("1") }],
        capabilities: [
          {
            kind: "createx-factory-v1",
            chainId: 1,
            address: CREATEX_FACTORY_V1_ADDRESS,
            expectedRuntimeCodeHash:
              "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f",
            status: {
              kind: "available",
              observedRuntimeCodeHash:
                "0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f",
            },
          },
        ],
        cells: [
          {
            resourceId: "kernel-impl",
            chainId: 1,
            address,
            expectedRuntimeCodeHash: hash("d"),
            configuration: [],
            checks: [],
            storageChecks: [],
            status: { kind: "missing" },
          },
        ],
        steps: [
          {
            id: "kernel-impl:deploy",
            resourceId: "kernel-impl",
            chainId: 1,
            kind: "deploy",
            configurationIds: [],
            drift: "missing",
            call: compileDeploymentCall(resource),
            postconditions: [{ kind: "runtime-code-hash", address, expectedHash: hash("d") }],
            sender: null,
            enforcement: {
              callScope: "interactive-review-sufficient",
              expiry: "optional",
              operationLimit: "optional",
            },
          },
        ],
      });
      expect(plan.steps[0]?.call.target).toBe(CREATEX_FACTORY_V1_ADDRESS);
      expect(plan.requirements[0]?.sender).toEqual({ kind: "sender-independent" });
      const reparsed = parseReviewedPlan(JSON.parse(JSON.stringify(plan)));
      expect(reparsed.planId).toBe(plan.planId);
    }
  });
});
