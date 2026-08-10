import { parseReviewedPlan, type ReviewedPlan } from "moesi";
import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/command.js";
import { runCli } from "../src/command.js";
import type { CliFetch } from "../src/rpc.js";

const BLOCK_HASH = `0x${"11".repeat(32)}`;
const RUNTIME_HASH = "0x07ad118d6cc8642c86c03827f276d8b791a65e5c99a3845faf186be720a1455d";
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
const EXTERNAL_ADDRESS = `0x${"ee".repeat(20)}`;
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "moesi.manifest/v1",
    contracts: [
      {
        kind: "managed",
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          salt: `0x${"bb".repeat(32)}`,
          initCode: "0x60006000",
          value: "0",
        },
        expectedRuntimeCodeHash: RUNTIME_HASH,
        configuration: [],
      },
    ],
    ...overrides,
  });
}

function rpc(
  options: {
    readonly code?: unknown;
    readonly factoryCode?: unknown;
    readonly call?: unknown;
    readonly blockError?: unknown;
    readonly codeError?: unknown;
    readonly callError?: unknown;
    readonly rpcChainId?: number;
    readonly requests?: RpcRequest[];
  } = {},
): CliFetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as RpcRequest;
    options.requests?.push(request);
    if (request.method === "eth_chainId") {
      return response(request.id, undefined, `0x${(options.rpcChainId ?? 8453).toString(16)}`);
    }
    if (request.method === "eth_getBlockByNumber") {
      return response(request.id, options.blockError, {
        number: "0x10",
        hash: BLOCK_HASH,
      });
    }
    if (request.method === "eth_call") {
      return response(request.id, options.callError, options.call ?? "0x");
    }
    const target = Array.isArray(request.params) ? request.params[0] : undefined;
    return response(
      request.id,
      options.codeError,
      target === CREATE2_FACTORY
        ? (options.factoryCode ?? CREATE2_FACTORY_RUNTIME)
        : (options.code ?? "0x"),
    );
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

function harness(options: { source?: string; fetch?: CliFetch } = {}): {
  io: CliIo;
  stdout: () => string;
  stderr: () => string;
} {
  const out: string[] = [];
  const error: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => error.push(text),
      async readFile() {
        return options.source ?? manifest();
      },
      fetch: options.fetch ?? rpc(),
    },
    stdout: () => out.join(""),
    stderr: () => error.join(""),
  };
}

const planArguments = (extra: readonly string[] = []): string[] => [
  "plan",
  "--manifest",
  "./moesi.json",
  "--chain",
  "8453=https://rpc.example/path?key=supersecret",
  ...extra,
];

describe("moesi CLI", () => {
  it("prints focused help without reading files or contacting RPC", async () => {
    let reads = 0;
    const test = harness();
    const io: CliIo = {
      ...test.io,
      async readFile() {
        reads += 1;
        return manifest();
      },
    };

    expect(await runCli(["--help"], io)).toBe(0);
    expect(test.stdout()).toContain("moesi plan");
    expect(test.stdout()).toContain("moesi inspect");
    expect(test.stdout()).toContain("moesi verify");
    expect(test.stdout()).toContain("moesi apply");
    expect(test.stdout()).toContain("moesi resume");
    expect(test.stdout()).toContain("moesi status");
    expect(test.stderr()).toBe("");
    expect(reads).toBe(0);
  });

  it("prints a deterministic human plan and returns 2 when changes exist", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({ fetch: rpc({ requests }) });

    expect(await runCli(planArguments(), test.io)).toBe(2);
    expect(test.stdout()).toContain("disposition changes");
    expect(test.stdout()).toContain("steps 1");
    expect(test.stdout()).toContain("8453 counter");
    expect(test.stdout()).toContain("capability create2-factory-v1 available");
    expect(test.stdout()).not.toContain("supersecret");
    expect(test.stderr()).toBe("");
    expect(requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getCode",
    ]);
    expect(requests[2]?.params[1]).toEqual({ blockHash: BLOCK_HASH, requireCanonical: true });
    expect(requests[3]?.params).toEqual([
      CREATE2_FACTORY,
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
  });

  it("shows missing-resource work as blocked when the canonical factory is absent", async () => {
    const test = harness({ fetch: rpc({ factoryCode: "0x" }) });

    expect(await runCli(planArguments(), test.io)).toBe(3);
    expect(test.stdout()).toContain("disposition blocked");
    expect(test.stdout()).toContain("steps 0");
    expect(test.stdout()).toContain("blocked 1");
    expect(test.stdout()).toContain("capability create2-factory-v1 missing");
    expect(test.stderr()).toBe("");
  });

  it("shows an exact-address external resource as verify-only without factory authority", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({
      source: manifest({
        contracts: [
          {
            kind: "external",
            id: "registry",
            address: EXTERNAL_ADDRESS,
            expectedRuntimeCodeHash: RUNTIME_HASH,
          },
        ],
      }),
      fetch: rpc({ code: "0x", requests }),
    });

    expect(await runCli(planArguments(), test.io)).toBe(3);
    expect(test.stdout()).toContain("disposition blocked");
    expect(test.stdout()).toContain("steps 0");
    expect(test.stdout()).toContain("blocked 1");
    expect(test.stdout()).toContain(
      `8453 registry ${EXTERNAL_ADDRESS} missing kind=external mode=verify-only execution-authority=none`,
    );
    expect(test.stdout()).not.toContain("capability create2-factory-v1");
    expect(requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
    ]);
    expect(test.stderr()).toBe("");
  });

  it("emits a JSON-safe converged plan with decimal snapshot numbers", async () => {
    const test = harness({ fetch: rpc({ code: "0x6000" }) });

    expect(await runCli(planArguments(["--json"]), test.io)).toBe(0);
    const output = JSON.parse(test.stdout()) as {
      version: string;
      plan: { disposition: string; snapshots: Array<{ blockNumber: string }> };
    };
    expect(output.version).toBe("moesi.cli-plan/v1");
    expect(output.plan.disposition).toBe("converged");
    expect(output.plan.snapshots[0]?.blockNumber).toBe("16");
    expect(parseReviewedPlan(output.plan as unknown as ReviewedPlan).planId).toBe(
      (output.plan as unknown as ReviewedPlan).planId,
    );
    expect(test.stderr()).toBe("");
  });

  it("keeps failed code reads as blocked unreadable evidence without leaking RPC details", async () => {
    const test = harness({
      fetch: rpc({ codeError: { code: -32000, message: "secret upstream provider body" } }),
    });

    expect(await runCli(planArguments(["--json"]), test.io)).toBe(3);
    expect(test.stdout()).toContain('"disposition":"blocked"');
    expect(test.stdout()).toContain('"reason":"read-failed"');
    expect(test.stdout()).not.toContain("secret upstream provider body");
    expect(test.stdout()).not.toContain("supersecret");
  });

  it("pins configuration reads and prints exact remediation work", async () => {
    const requests: RpcRequest[] = [];
    const source = JSON.parse(manifest()) as {
      contracts: Array<{ configuration: unknown[] }>;
    };
    source.contracts[0]!.configuration = [
      {
        id: "value",
        readData: "0x3fa4f245",
        expectedResult: `0x${"00".repeat(31)}2a`,
        writeData: `0x55241077${"00".repeat(31)}2a`,
        value: "0",
      },
    ];
    const test = harness({
      source: JSON.stringify(source),
      fetch: rpc({ code: "0x6000", call: `0x${"00".repeat(32)}`, requests }),
    });

    expect(await runCli(planArguments(["--json"]), test.io)).toBe(2);
    expect(JSON.parse(test.stdout()).plan.steps[0]).toMatchObject({
      kind: "configure",
      configurationId: "value",
    });
    expect(requests.map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_call",
    ]);
    expect(requests[3]?.params).toEqual([
      {
        from: `0x${"00".repeat(20)}`,
        to: expect.stringMatching(/^0x[0-9a-f]{40}$/i),
        data: "0x3fa4f245",
      },
      { blockHash: BLOCK_HASH, requireCanonical: true },
    ]);
  });

  it("returns a structured snapshot error without raw provider diagnostics", async () => {
    const test = harness({
      fetch: rpc({ blockError: { code: -32000, message: "credential-bearing block error" } }),
    });

    expect(await runCli(planArguments(["--json"]), test.io)).toBe(1);
    expect(JSON.parse(test.stderr())).toEqual({
      version: "moesi.cli-error/v1",
      error: { code: "snapshot_unreadable" },
    });
    expect(test.stderr()).not.toContain("credential-bearing block error");
    expect(test.stderr()).not.toContain("supersecret");
  });

  it("rejects an RPC bound to a different chain before observation", async () => {
    const requests: RpcRequest[] = [];
    const test = harness({ fetch: rpc({ rpcChainId: 1, requests }) });

    expect(await runCli(planArguments(["--json"]), test.io)).toBe(1);
    expect(JSON.parse(test.stderr()).error.code).toBe("snapshot_unreadable");
    expect(requests.map(({ method }) => method)).toEqual(["eth_chainId"]);
  });

  it("rejects invalid manifests and arguments with stable codes", async () => {
    const invalidManifest = harness({ source: manifest({ schemaVersion: 1 }) });
    expect(await runCli(planArguments(["--json"]), invalidManifest.io)).toBe(1);
    expect(JSON.parse(invalidManifest.stderr()).error.code).toBe("unknown_field");

    const invalidArguments = harness();
    expect(
      await runCli(
        ["plan", "--manifest", "./moesi.json", "--chain", "1=https://user:pass@rpc.example"],
        invalidArguments.io,
      ),
    ).toBe(1);
    expect(invalidArguments.stderr()).toBe("MOESI_CLI_ERROR invalid_arguments\n");
    expect(invalidArguments.stderr()).not.toContain("user:pass");
  });
});

interface RpcRequest {
  readonly id: number;
  readonly method: string;
  readonly params: readonly unknown[];
}
