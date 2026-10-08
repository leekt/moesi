import { readFileSync } from "node:fs";
import { type Address, type Hex, keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  CREATEX_FACTORY_V1_ADDRESS,
  createMoesi,
  MemoryDeploymentRunStore,
  type MoesiExecutionProvider,
  type MoesiManifest,
  type MoesiObservationAdapter,
  parseDeploymentRunRecord,
  parseManifest,
  parseReviewedPlan,
  predictManifestAddresses,
} from "../src/index.js";

const ACCOUNT = "0xc3a56de6dfc1dcef5113927ec09513918e8c44aa";
const OTHER = "0x1111111111111111111111111111111111111111";
const ENTROPY = "0x04a9469db98e61f23775c1";
const TARGET = "0xafdea3e6716239482c2378a3bf6d24fbdd99b077";
const RUNTIME = "0x6000";
const BLOCK = `0x${"ab".repeat(32)}` as Hex;
const FACTORY_CODE = readFileSync(
  new URL("./fixtures/CreateX.runtime.hex", import.meta.url),
  "utf8",
).trim() as Hex;

function manifest(
  kind: "createx-create2-v1" | "createx-create3-v1" = "createx-create3-v1",
  address: Address = ACCOUNT,
): MoesiManifest {
  return {
    version: "moesi.manifest/v8",
    contracts: [
      {
        kind: "managed",
        id: "AcrossAdapter",
        deployment: {
          kind,
          entropy: ENTROPY,
          initCode: "0x6002600c60003960026000f36000",
          value: "0",
          requiresRuntime: [],
        },
        sender: { kind: "smart-account", accountId: "fleet", address },
        expectedRuntimeCodeHash: keccak256(RUNTIME),
        checks: [],
        storageChecks: [],
        configuration: [],
      },
    ],
  };
}

function observer(deployed = false): MoesiObservationAdapter {
  return {
    async captureSnapshot() {
      return { blockNumber: "1", blockHash: BLOCK };
    },
    async readCode({ address }) {
      return address === CREATEX_FACTORY_V1_ADDRESS ? FACTORY_CODE : deployed ? RUNTIME : "0x";
    },
    async readCall() {
      return "0x";
    },
    async checkBlockAncestry() {
      return true;
    },
  };
}

function provider(sender: Address): MoesiExecutionProvider {
  return {
    id: "smart-fixture",
    review: vi.fn<MoesiExecutionProvider["review"]>(async ({ plan }) => ({
      providerId: "smart-fixture",
      status: "supported",
      reasons: [],
      chains: plan.requirements.map(({ chainId }) => ({
        chainId,
        sender,
        accountId: "fleet",
        route: "fixture",
        signer: "owner" as const,
        signerReason: "caller-supplied-eoa",
        fallback: null,
        enforcement: {
          calls: "interactive-owner",
          expiry: "not-enforced",
          operationCount: "not-enforced",
        },
      })),
    })),
    prepare: vi.fn(async () => {
      throw new Error("unexpected prepare");
    }),
    submit: vi.fn(async () => {
      throw new Error("unexpected submission");
    }),
    observe: vi.fn<MoesiExecutionProvider["observe"]>(async () => ({ status: "pending" })),
  };
}

describe("sender-protected CreateX with a resolved smart account", () => {
  it("predicts the two existing SRA CREATE3 vectors offline and freezes the result", () => {
    const first = manifest();
    const base = first.contracts[0]!;
    if (base.kind !== "managed" || base.deployment.kind !== "createx-create3-v1")
      throw new Error("fixture");
    const fleet: MoesiManifest = {
      ...first,
      contracts: [
        base,
        {
          ...base,
          id: "MultiPairChainlinkResolver",
          sender: { kind: "smart-account", accountId: "fleet", address: ACCOUNT },
          deployment: { ...base.deployment, entropy: "0x399266e1d763d90d62fe32" },
        },
      ],
    };
    const addresses = predictManifestAddresses(fleet);
    expect(addresses).toEqual([
      { resourceId: "AcrossAdapter", address: TARGET },
      {
        resourceId: "MultiPairChainlinkResolver",
        address: "0xd91b39e398490abaadc79011524d28e6854ef48d",
      },
    ]);
    expect(Object.isFrozen(addresses)).toBe(true);
    expect(Object.isFrozen(addresses[0])).toBe(true);
    expect(() => predictManifestAddresses({ ...fleet, contracts: [base, base] })).toThrowError(
      expect.objectContaining({ code: "duplicate_resource" }),
    );
  });

  it.each(["createx-create2-v1", "createx-create3-v1"] as const)(
    "binds %s address, salt, calldata and provider sender on two chains",
    async (kind) => {
      const input = manifest(kind);
      const client = createMoesi({ observer: observer() });
      const plan = await client.plan({ manifest: input, chains: [8453, 5042] });
      const predicted = predictManifestAddresses(input)[0]!.address;
      expect(plan.cells.map((cell) => cell.address)).toEqual([predicted, predicted]);
      expect(plan.steps).toHaveLength(2);
      for (const step of plan.steps) {
        expect(step.call.data.slice(0, 10)).toBe(
          kind === "createx-create3-v1" ? "0x9c36a286" : "0x26307668",
        );
        expect(step.call.data.slice(10, 74)).toBe(`${ACCOUNT.slice(2)}00${ENTROPY.slice(2)}`);
        expect(step.sender).toEqual({
          kind: "logical-smart-account",
          accountId: "fleet",
          address: ACCOUNT,
        });
      }
      expect(parseReviewedPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
      const ready = await client.reviewExecution({ plan, provider: provider(ACCOUNT) });
      expect(ready.provider.status).toBe("supported");
      const wrong = await client.reviewExecution({ plan, provider: provider(OTHER) });
      expect(wrong.provider.status).toBe("blocked");
      expect(wrong.provider.reasons.map(({ code }) => code)).toContain("review-sender-mismatch");
      const changed = await client.plan({ manifest: manifest(kind, OTHER), chains: [8453, 5042] });
      expect(changed.planId).not.toBe(plan.planId);
      expect(changed.cells[0]!.address).not.toBe(predicted);
    },
  );

  it("keeps CREATE3 independent of init code and allows the same exact sender as an EOA", () => {
    const input = manifest();
    const resource = input.contracts[0]!;
    if (resource.kind !== "managed") throw new Error("fixture");
    const changed: MoesiManifest = {
      ...input,
      contracts: [
        {
          ...resource,
          sender: { kind: "owner-eoa", address: ACCOUNT },
          deployment: {
            ...resource.deployment,
            kind: "createx-create3-v1",
            entropy: ENTROPY,
            initCode: "0x6001",
          },
        },
      ],
    };
    expect(predictManifestAddresses(changed)).toEqual(predictManifestAddresses(input));
    expect(parseManifest(changed).manifestHash).not.toBe(parseManifest(input).manifestHash);
  });

  it("rejects missing, zero and malformed smart-account addresses before observation", async () => {
    for (const address of [undefined, `0x${"0".repeat(40)}`, "0x12"]) {
      const input = structuredClone(manifest()) as unknown as {
        contracts: { sender: Record<string, unknown> }[];
      };
      input.contracts[0]!.sender.address = address;
      expect(() => parseManifest(input as unknown as MoesiManifest)).toThrowError(
        expect.objectContaining({ code: "invalid_sender" }),
      );
    }
    const selected = provider(OTHER);
    const client = createMoesi({ observer: observer(), runStore: new MemoryDeploymentRunStore() });
    const plan = await client.plan({ manifest: manifest(), chains: [1] });
    const review = await client.reviewExecution({ plan, provider: selected });
    expect(() => client.apply({ plan, provider: selected, executionReview: review })).toThrowError(
      expect.objectContaining({ code: "provider_review_blocked" }),
    );
    expect(selected.prepare).not.toHaveBeenCalled();
    expect(selected.submit).not.toHaveBeenCalled();
  });

  it("uses the pinned smart-account address as configuration simulation caller", async () => {
    const input = manifest();
    const resource = input.contracts[0]!;
    if (resource.kind !== "managed") throw new Error("fixture");
    const configuration = [
      {
        id: "owner-read",
        readData: "0x12345678" as Hex,
        expectedResult: "0x01" as Hex,
        writeData: "0x87654321" as Hex,
        value: "0",
      },
    ];
    const observed = observer(true);
    const calls = vi.fn(observed.readCall);
    const plan = await createMoesi({ observer: { ...observed, readCall: calls } }).plan({
      manifest: { ...input, contracts: [{ ...resource, configuration }] },
      chains: [1],
    });
    expect(calls).toHaveBeenCalledWith(expect.objectContaining({ caller: ACCOUNT }));
    expect(plan.steps[0]?.postconditions).toContainEqual(
      expect.objectContaining({ kind: "static-call", caller: ACCOUNT }),
    );
  });

  it("rejects inconsistent concrete addresses for one logical sender", async () => {
    const input = manifest();
    const other = manifest("createx-create3-v1", OTHER).contracts[0]!;
    await expect(
      createMoesi({ observer: observer() }).plan({
        manifest: { ...input, contracts: [...input.contracts, { ...other, id: "other" }] },
        chains: [1],
      }),
    ).rejects.toMatchObject({ code: "conflicting_senders" });
  });

  it("rejects stale outer versions before interpreting the changed sender shape", async () => {
    expect(() => parseManifest({ version: "moesi.manifest/v4" } as never)).toThrowError(
      expect.objectContaining({ code: "unsupported_manifest_version" }),
    );
    expect(() => parseReviewedPlan({ version: "moesi.reviewed-plan/v4" } as never)).toThrowError(
      expect.objectContaining({ code: "unsupported_plan_version" }),
    );
    expect(() => parseDeploymentRunRecord({ version: "moesi.deployment-run/v4" })).toThrowError(
      expect.objectContaining({ code: "unsupported_run_version" }),
    );
  });
});
