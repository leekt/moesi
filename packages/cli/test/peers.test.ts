import {
  createMoesi,
  type MoesiExecutionProvider,
  type MoesiManifest,
  parseDeploymentRunRecord,
} from "moesi";
import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import { type CliIo, runCli } from "../src/command.js";
import { renderPlanArtifact } from "../src/inspection-output.js";

const HASH = `0x${"aa".repeat(32)}` as const;
const PEER = "0x2222222222222222222222222222222222222222";
const SENDER = "0x1111111111111111111111111111111111111111";
const manifest: MoesiManifest = {
  version: "moesi.manifest/v6",
  contracts: [
    {
      kind: "managed",
      id: "book",
      deployment: {
        kind: "create2-factory-v1",
        salt: HASH,
        initCode: "0x6000",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256("0x6000"),
      checks: [],
      storageChecks: [],
      configuration: [
        {
          id: "route",
          readData: "0x11111111",
          expectedResult: "0x01",
          writeData: "0x22222222",
          value: "0",
          after: [{ chainId: 2, address: PEER, expectedRuntimeCodeHash: keccak256("0x6000") }],
        },
      ],
    },
  ],
};
function fixture() {
  const files = new Map([["manifest.json", JSON.stringify(manifest)]]);
  const output: string[] = [];
  const errors: string[] = [];
  const fetch: CliIo["fetch"] = vi.fn(async (input, init) => {
    const { id, method } = JSON.parse(String(init?.body));
    const chainId = String(input).includes("peer") ? 2 : 1;
    const result =
      method === "eth_chainId"
        ? `0x${chainId}`
        : method === "eth_getBlockByNumber"
          ? { number: "0xa", hash: HASH }
          : method === "eth_getCode"
            ? chainId === 2
              ? "0x"
              : "0x6000"
            : method === "eth_call"
              ? "0x01"
              : null;
    if (result === null) throw new Error("unexpected local RPC request");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
  });
  const io: CliIo = {
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
    readFile: async (path) => files.get(path)!,
    fetch,
  };
  return { files, output, errors, io };
}
const bindings = ["--chain", "1=http://local.invalid", "--peer-chain", "2=http://peer.invalid"];

describe("CLI read-only peer chain bindings", () => {
  it("plans only deployment chains, renders pending peers and verifies from the same peer RPC", async () => {
    const { io, output, errors, files } = fixture();
    expect(await runCli(["plan", "--manifest", "manifest.json", ...bindings, "--json"], io)).toBe(
      3,
    );
    const artifact = JSON.parse(output.pop()!);
    expect(
      artifact.plan.snapshots.map((snapshot: { chainId: number }) => snapshot.chainId),
    ).toEqual([1]);
    expect(artifact.plan.peers[0].status.kind).toBe("missing");
    expect(artifact.plan.disposition).toBe("pending");
    files.set("plan.json", JSON.stringify(artifact));
    expect(await runCli(["inspect", "--plan", "plan.json"], io)).toBe(0);
    expect(output.at(-1)).toContain(`peer 2 ${PEER} status=missing`);
    expect(output.at(-1)).toContain("readiness=pending-peer");
    expect(await runCli(["verify", "--plan", "plan.json", ...bindings], io)).toBe(3);
    expect(output.at(-1)).toContain("reason=peer-pending");
    expect(output.at(-1)).toContain(`peer 2 ${PEER} status=missing`);
    expect(errors).toEqual([]);
  });

  it.each([
    ["--chain", "1=http://local.invalid"],
    [...bindings, "--peer-chain", "3=http://extra.invalid"],
    [...bindings, "--peer-chain", "2=http://duplicate.invalid"],
    [...bindings, "--peer-chain", "1=http://duplicate.invalid"],
  ])("rejects missing, extraneous and duplicate peer bindings before RPC", async (...flags) => {
    const { io, errors } = fixture();
    expect(await runCli(["plan", "--manifest", "manifest.json", ...flags], io)).toBe(1);
    expect(errors.join("")).toContain("invalid_arguments");
    expect(io.fetch).not.toHaveBeenCalled();
  });

  it("supplies peer readers during apply without loading peer signers", async () => {
    const { io, files, errors } = fixture();
    const observer = {
      async captureSnapshot() {
        return { blockNumber: "10", blockHash: HASH };
      },
      async readCode() {
        return "0x6000";
      },
      async readCall() {
        return "0x";
      },
      async checkBlockAncestry() {
        return true;
      },
    };
    const plan = await createMoesi({ observer }).plan({ manifest, chains: [1] });
    files.set("plan.json", renderPlanArtifact(plan));
    const provider: MoesiExecutionProvider = {
      id: "viem",
      async review() {
        return {
          providerId: "viem",
          status: "supported",
          reasons: [],
          chains: [
            {
              chainId: 1,
              sender: SENDER,
              accountId: null,
              route: "viem-direct-eoa:confirmations-1",
              signer: "owner" as const,
              signerReason: "caller-supplied-eoa",
              enforcement: {
                calls: "interactive-owner",
                expiry: "not-enforced",
                operationCount: "not-enforced",
              },
            },
          ],
        };
      },
      async prepare() {
        throw new Error("read-only execution review");
      },
      async submit() {
        throw new Error("must not submit");
      },
      async observe() {
        return { status: "pending" };
      },
    };
    const createViemRuntime = vi.fn(() => ({ observer, provider }));
    const readEnv = vi.fn(() => `0x${"11".repeat(32)}`);
    const runtimeIo = { ...io, createViemRuntime, readEnv };
    const args = [
      "--provider",
      "viem",
      ...bindings,
      "--signer",
      "1=TEST_KEY",
      "--confirmations",
      "1",
      "--store",
      "unused",
    ];
    expect(await runCli(["apply", "--plan", "plan.json", ...args], runtimeIo)).toBe(2);
    expect(createViemRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        chains: [
          { chainId: 1, url: "http://local.invalid/" },
          { chainId: 2, url: "http://peer.invalid/" },
        ],
        privateKeys: new Map([[1, `0x${"11".repeat(32)}`]]),
      }),
    );
    expect(readEnv).toHaveBeenCalledExactlyOnceWith("TEST_KEY");
    // A peer signer is not in the deployment plan and must fail before its environment is read.
    readEnv.mockClear();
    createViemRuntime.mockClear();
    expect(
      await runCli(["apply", "--plan", "plan.json", ...args, "--signer", "2=PEER_KEY"], runtimeIo),
    ).toBe(1);
    expect(readEnv).not.toHaveBeenCalledWith("PEER_KEY");
    expect(createViemRuntime).not.toHaveBeenCalled();
    expect(errors.at(-1)).toContain("invalid_arguments");
  });
});
