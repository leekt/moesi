import { createMoesi } from "moesi";
import { keccak256 } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "../src/command.js";
import { runCli } from "../src/command.js";
import type { CliFetch } from "../src/rpc.js";

const CHAIN_ID = 1;
const BLOCK_HASH = `0x${"11".repeat(32)}` as const;
const CODE = "0x6000" as const;
const OTHER_CODE = "0x6001" as const;
const RUNTIME_HASH = keccak256(CODE);
const EXPECTED_RESULT = `0x${"00".repeat(31)}2a` as const;
const DRIFTED_RESULT = `0x${"00".repeat(32)}` as const;
const EXTERNAL_ADDRESS = `0x${"ee".repeat(20)}` as const;
const EXTERNAL_CALLER = `0x${"aa".repeat(20)}` as const;
const EXTERNAL_CHECK_DATA = "0x5c975abb" as const;
const EXTERNAL_STORAGE_SLOT = `0x${"00".repeat(31)}01` as const;
const EXPECTED_STORAGE_WORD = `0x${"00".repeat(31)}2b` as const;
const DRIFTED_STORAGE_WORD = `0x${"00".repeat(32)}` as const;
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}

async function planArtifact(chainIds: readonly number[] = [CHAIN_ID]): Promise<string> {
  const plan = await createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "16", blockHash: BLOCK_HASH };
      },
      async readCode() {
        return CODE;
      },
      async readCall() {
        return EXPECTED_RESULT;
      },
      async readStorage() {
        return EXPECTED_STORAGE_WORD;
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({
    chains: chainIds,
    manifest: {
      version: "moesi.manifest/v5",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: `0x${"bb".repeat(32)}`,
            initCode: "0x60006000",
            value: "0",
          },
          expectedRuntimeCodeHash: RUNTIME_HASH,
          checks: [],
          storageChecks: [],
          configuration: [
            {
              id: "value",
              readData: "0x3fa4f245",
              expectedResult: EXPECTED_RESULT,
              writeData: `0x55241077${"00".repeat(31)}2a`,
              value: "0",
            },
          ],
        },
      ],
    },
  });
  return JSON.stringify({ version: "moesi.cli-plan/v4", plan });
}

async function externalPlanArtifact(): Promise<string> {
  const plan = await createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "16", blockHash: BLOCK_HASH };
      },
      async readCode() {
        return CODE;
      },
      async readCall() {
        return EXPECTED_RESULT;
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({
    chains: [CHAIN_ID],
    manifest: {
      version: "moesi.manifest/v5",
      contracts: [
        {
          kind: "external",
          id: "registry",
          address: EXTERNAL_ADDRESS,
          expectedRuntimeCodeHash: RUNTIME_HASH,
          checks: [
            {
              id: "live",
              caller: EXTERNAL_CALLER,
              readData: EXTERNAL_CHECK_DATA,
              expectedResult: EXPECTED_RESULT,
            },
          ],
          storageChecks: [
            {
              id: "admin",
              slot: EXTERNAL_STORAGE_SLOT,
              expectedWord: EXPECTED_STORAGE_WORD,
            },
          ],
        },
      ],
    },
  });
  return JSON.stringify({ version: "moesi.cli-plan/v4", plan });
}

async function managedAttestationPlanArtifact(): Promise<string> {
  const plan = await createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "16", blockHash: BLOCK_HASH };
      },
      async readCode() {
        return CODE;
      },
      async readStorage() {
        return EXPECTED_STORAGE_WORD;
      },
      async readCall() {
        return EXPECTED_RESULT;
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({
    chains: [CHAIN_ID],
    manifest: {
      version: "moesi.manifest/v5",
      contracts: [
        {
          kind: "managed",
          id: "counter",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: `0x${"bb".repeat(32)}`,
            initCode: "0x60006000",
            value: "0",
          },
          expectedRuntimeCodeHash: RUNTIME_HASH,
          storageChecks: [
            {
              id: "admin",
              slot: EXTERNAL_STORAGE_SLOT,
              expectedWord: EXPECTED_STORAGE_WORD,
            },
          ],
          checks: [
            {
              id: "live",
              caller: EXTERNAL_CALLER,
              readData: EXTERNAL_CHECK_DATA,
              expectedResult: EXPECTED_RESULT,
            },
          ],
          configuration: [
            {
              id: "value",
              readData: "0x3fa4f245",
              expectedResult: EXPECTED_RESULT,
              writeData: "0x55241077",
              value: "0",
            },
          ],
        },
      ],
    },
  });
  return JSON.stringify({ version: "moesi.cli-plan/v4", plan });
}

function rpc(
  options: {
    readonly code?: string;
    readonly call?: string;
    readonly calls?: Readonly<Record<string, string>>;
    readonly storage?: string;
    readonly codeError?: unknown;
    readonly callError?: unknown;
    readonly storageError?: unknown;
    readonly requests?: RpcRequest[];
  } = {},
): CliFetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    options.requests?.push(request);
    if (request.method === "eth_chainId") {
      return response(request.id, undefined, "0x1");
    }
    if (request.method === "eth_getBlockByNumber") {
      return response(request.id, undefined, { number: "0x10", hash: BLOCK_HASH });
    }
    if (request.method === "eth_getCode") {
      return response(request.id, options.codeError, options.code ?? CODE);
    }
    if (request.method === "eth_getStorageAt") {
      return response(request.id, options.storageError, options.storage ?? EXPECTED_STORAGE_WORD);
    }
    if (request.method === "eth_call") {
      const data = (request.params[0] as { readonly data?: string } | undefined)?.data;
      return response(
        request.id,
        options.callError,
        (data === undefined ? undefined : options.calls?.[data]) ?? options.call ?? EXPECTED_RESULT,
      );
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  }) as CliFetch;
}

function response(id: number, error: unknown, result: unknown): Response {
  return new Response(
    JSON.stringify(
      error === undefined ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function harness(input: { readonly source: string; readonly fetch?: CliFetch }): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly executionAccesses: () => number;
} {
  const output: string[] = [];
  const errors: string[] = [];
  let executionAccesses = 0;
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      async readFile() {
        return input.source;
      },
      fetch: input.fetch ?? rpc(),
      createRunStore() {
        executionAccesses += 1;
        throw new Error("verification must not open a Run store");
      },
      readEnv() {
        executionAccesses += 1;
        throw new Error("verification must not read signer environment");
      },
      createViemRuntime() {
        executionAccesses += 1;
        throw new Error("verification must not create an execution provider");
      },
      installSignalHandlers() {
        executionAccesses += 1;
        throw new Error("verification must not install signal handlers");
      },
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
    executionAccesses: () => executionAccesses,
  };
}

const verifyArguments = (extra: readonly string[] = []): string[] => [
  "verify",
  "--plan",
  "./plan.json",
  "--chain",
  "1=https://rpc.example/path?token=rpc-secret",
  ...extra,
];

describe("moesi verify", () => {
  it("emits the direct core result for fresh pinned runtime and configuration evidence", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({ source: await planArtifact(), fetch: rpc({ requests }) });

    expect(await runCli(verifyArguments(["--json"]), test.io)).toBe(0);
    const output = JSON.parse(test.stdout());
    expect(output).toMatchObject({
      version: "moesi.verification-result/v2",
      status: "converged",
      chains: [
        {
          chainId: 1,
          status: "converged",
          snapshot: { chainId: 1, blockNumber: "16", blockHash: BLOCK_HASH },
          cells: [
            {
              resourceId: "counter",
              expectedRuntimeCodeHash: RUNTIME_HASH,
              status: { kind: "satisfied", observedRuntimeCodeHash: RUNTIME_HASH },
              configurations: [
                {
                  id: "value",
                  expectedResult: EXPECTED_RESULT,
                  status: { kind: "satisfied", observedResult: EXPECTED_RESULT },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(Object.keys(output)).toEqual(["version", "planId", "manifestHash", "status", "chains"]);
    expect(output.plan).toBeUndefined();
    expect(test.stdout()).not.toContain("rpc-secret");
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
    expect(requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_call",
    ]);
    expect(requests[2]?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    expect(requests[3]?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
  });

  it("renders concise runtime and configuration drift evidence and exits 2", async () => {
    const test = harness({
      source: await planArtifact(),
      fetch: rpc({ call: DRIFTED_RESULT }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("status drifted");
    expect(test.stdout()).toContain(`1 counter runtime satisfied address=`);
    expect(test.stdout()).toContain(`expected=${RUNTIME_HASH} observed=${RUNTIME_HASH}`);
    expect(test.stdout()).toContain("1 counter configuration value drifted");
    expect(test.stdout()).toContain(`expected=${EXPECTED_RESULT} observed=${DRIFTED_RESULT}`);
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("renders external check drift with the reviewed simulation caller and calldata", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await externalPlanArtifact(),
      fetch: rpc({ code: CODE, call: DRIFTED_RESULT, requests }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("status drifted");
    expect(test.stdout()).toContain(
      `1 registry call-check live drifted simulation-caller=${EXTERNAL_CALLER} readData=${EXTERNAL_CHECK_DATA} expected=${EXPECTED_RESULT} observed=${DRIFTED_RESULT} remediation=none execution-authority=none`,
    );
    const storage = requests.find(({ method }) => method === "eth_getStorageAt");
    expect(storage?.params).toEqual([
      EXTERNAL_ADDRESS,
      EXTERNAL_STORAGE_SLOT,
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
    expect(storage?.params).toHaveLength(3);
    const call = requests.find(({ method }) => method === "eth_call");
    expect(call?.params).toEqual([
      { from: EXTERNAL_CALLER, to: EXTERNAL_ADDRESS, data: EXTERNAL_CHECK_DATA },
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
    expect(call?.params).toHaveLength(2);
    expect(requests.some(({ params }) => params[0] === CREATE2_FACTORY)).toBe(false);
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("renders external storage drift and preserves the exact three-parameter pinned read", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await externalPlanArtifact(),
      fetch: rpc({ code: CODE, storage: DRIFTED_STORAGE_WORD, requests }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("status drifted");
    expect(test.stdout()).toContain(
      `1 registry storage-check admin drifted slot=${EXTERNAL_STORAGE_SLOT} expected=${EXPECTED_STORAGE_WORD} observed=${DRIFTED_STORAGE_WORD} remediation=none execution-authority=none`,
    );
    const storage = requests.find(({ method }) => method === "eth_getStorageAt");
    expect(storage?.params).toEqual([
      EXTERNAL_ADDRESS,
      EXTERNAL_STORAGE_SLOT,
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
    expect(storage?.params).toHaveLength(3);
    expect(requests.some(({ params }) => params[0] === CREATE2_FACTORY)).toBe(false);
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("renders scrubbed external storage unreadable evidence and stops before calls", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await externalPlanArtifact(),
      fetch: rpc({
        code: CODE,
        storageError: { code: -32000, message: "credential-bearing storage failure" },
        requests,
      }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(3);
    expect(test.stdout()).toContain("status unreadable");
    expect(test.stdout()).toContain("1 registry runtime satisfied");
    expect(test.stdout()).toContain(
      `1 registry storage-check admin unreadable slot=${EXTERNAL_STORAGE_SLOT} expected=${EXPECTED_STORAGE_WORD} observed=unavailable reason=read-failed remediation=none execution-authority=none`,
    );
    expect(requests.some(({ method }) => method === "eth_call")).toBe(false);
    expect(test.stdout()).not.toContain("credential-bearing storage failure");
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("separates managed storage, call-check, and repairable configuration verification", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await managedAttestationPlanArtifact(),
      fetch: rpc({
        storage: DRIFTED_STORAGE_WORD,
        calls: {
          [EXTERNAL_CHECK_DATA]: DRIFTED_RESULT,
          "0x3fa4f245": DRIFTED_RESULT,
        },
        requests,
      }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain(
      `1 counter storage-check admin drifted slot=${EXTERNAL_STORAGE_SLOT} expected=${EXPECTED_STORAGE_WORD} observed=${DRIFTED_STORAGE_WORD} remediation=none execution-authority=none`,
    );
    expect(test.stdout()).toContain(
      `1 counter call-check live drifted simulation-caller=${EXTERNAL_CALLER} readData=${EXTERNAL_CHECK_DATA} expected=${EXPECTED_RESULT} observed=${DRIFTED_RESULT} remediation=none execution-authority=none`,
    );
    expect(test.stdout()).toContain(
      `1 counter configuration value drifted simulation-caller=0x0000000000000000000000000000000000000000 readData=0x3fa4f245 expected=${EXPECTED_RESULT} observed=${DRIFTED_RESULT} remediation=write-action`,
    );
    expect(
      requests
        .filter(({ method }) => ["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["eth_getCode", "eth_getStorageAt", "eth_call", "eth_call"]);
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);

    const json = harness({
      source: await managedAttestationPlanArtifact(),
      fetch: rpc({
        storage: DRIFTED_STORAGE_WORD,
        calls: {
          [EXTERNAL_CHECK_DATA]: DRIFTED_RESULT,
          "0x3fa4f245": DRIFTED_RESULT,
        },
      }),
    });
    expect(await runCli(verifyArguments(["--json"]), json.io)).toBe(2);
    expect(JSON.parse(json.stdout()).chains[0].cells[0]).toMatchObject({
      storageChecks: [
        {
          id: "admin",
          slot: EXTERNAL_STORAGE_SLOT,
          expectedWord: EXPECTED_STORAGE_WORD,
          status: { kind: "drifted", observedWord: DRIFTED_STORAGE_WORD },
        },
      ],
      callChecks: [
        {
          id: "live",
          expectedResult: EXPECTED_RESULT,
          status: { kind: "drifted", observedResult: DRIFTED_RESULT },
        },
      ],
      configurations: [
        {
          id: "value",
          expectedResult: EXPECTED_RESULT,
          status: { kind: "drifted", observedResult: DRIFTED_RESULT },
        },
      ],
      status: { kind: "drifted", observedRuntimeCodeHash: RUNTIME_HASH },
    });
    expect(json.executionAccesses()).toBe(0);
  });

  it("returns 2 for runtime drift without performing configuration reads", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await planArtifact(),
      fetch: rpc({ code: OTHER_CODE, requests }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("1 counter runtime drifted");
    expect(test.stdout()).not.toContain("configuration value");
    expect(requests.some(({ method }) => method === "eth_call")).toBe(false);
  });

  it("renders exact-address external runtime evidence as verify-only", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: await externalPlanArtifact(),
      fetch: rpc({ code: OTHER_CODE, requests }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("status drifted");
    expect(test.stdout()).toContain(
      `1 registry runtime drifted address=${EXTERNAL_ADDRESS} expected=${RUNTIME_HASH} observed=${keccak256(OTHER_CODE)} kind=external mode=verify-only execution-authority=none`,
    );
    expect(
      requests.filter(({ method }) => method === "eth_getCode").map(({ params }) => params[0]),
    ).toEqual([EXTERNAL_ADDRESS]);
    expect(requests.some(({ params }) => params[0] === CREATE2_FACTORY)).toBe(false);
    expect(requests.some(({ method }) => method === "eth_call")).toBe(false);
    expect(test.stderr()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("returns unreadable evidence without leaking raw RPC diagnostics", async () => {
    const test = harness({
      source: await planArtifact(),
      fetch: rpc({
        codeError: { code: -32000, message: "credential-bearing upstream failure" },
      }),
    });

    expect(await runCli(verifyArguments(["--json"]), test.io)).toBe(3);
    expect(JSON.parse(test.stdout())).toMatchObject({
      version: "moesi.verification-result/v2",
      status: "unreadable",
      chains: [
        {
          status: "unreadable",
          cells: [{ status: { kind: "unreadable", reason: "read-failed" } }],
        },
      ],
    });
    expect(test.stdout()).not.toContain("credential-bearing upstream failure");
    expect(test.stdout()).not.toContain("rpc-secret");
    expect(test.stderr()).toBe("");
  });

  it("separates satisfied runtime from unreadable configuration evidence", async () => {
    const test = harness({
      source: await planArtifact(),
      fetch: rpc({
        callError: { code: -32000, message: "secret configuration failure" },
      }),
    });

    expect(await runCli(verifyArguments(), test.io)).toBe(3);
    expect(test.stdout()).toContain("status unreadable");
    expect(test.stdout()).toContain("1 counter runtime satisfied");
    expect(test.stdout()).toContain("1 counter configuration value unreadable");
    expect(test.stdout()).toContain("reason=read-failed");
    expect(test.stdout()).not.toContain("secret configuration failure");
    expect(test.stderr()).toBe("");
  });

  it("rejects non-exact chain coverage before contacting RPC", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("RPC must not be contacted");
    }) as unknown as CliFetch;
    const test = harness({ source: await planArtifact(), fetch });

    expect(
      await runCli(
        [...verifyArguments(["--chain", "2=https://rpc-two.example"]), "--json"],
        test.io,
      ),
    ).toBe(1);
    expect(JSON.parse(test.stderr())).toEqual({
      version: "moesi.cli-error/v1",
      error: { code: "invalid_arguments" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(test.stdout()).toBe("");
    expect(test.executionAccesses()).toBe(0);
  });

  it("reuses strict plan artifact validation and rejects execution options", async () => {
    const valid = JSON.parse(await planArtifact()) as Record<string, unknown>;
    const fetch = vi.fn(async () => {
      throw new Error("RPC must not be contacted");
    }) as unknown as CliFetch;
    const invalidArtifact = harness({
      source: JSON.stringify({ ...valid, extra: true }),
      fetch,
    });

    expect(await runCli(verifyArguments(["--json"]), invalidArtifact.io)).toBe(1);
    expect(JSON.parse(invalidArtifact.stderr()).error.code).toBe("plan_artifact_invalid");
    expect(fetch).not.toHaveBeenCalled();

    const stale = harness({
      source: JSON.stringify({ version: "moesi.cli-plan/v2", obsolete: true }),
      fetch,
    });
    expect(await runCli(verifyArguments(["--json"]), stale.io)).toBe(1);
    expect(JSON.parse(stale.stderr()).error.code).toBe("unsupported_plan_artifact_version");
    expect(fetch).not.toHaveBeenCalled();

    const executionOption = harness({ source: await planArtifact(), fetch });
    expect(
      await runCli(verifyArguments(["--provider", "viem", "--json"]), executionOption.io),
    ).toBe(1);
    expect(JSON.parse(executionOption.stderr()).error.code).toBe("invalid_arguments");
    expect(fetch).not.toHaveBeenCalled();
    expect(executionOption.executionAccesses()).toBe(0);
  });
});
