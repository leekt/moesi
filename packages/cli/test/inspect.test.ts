import {
  CREATE2_FACTORY_V1_ADDRESS,
  createMoesi,
  type MoesiManifest,
  type ReviewedPlan,
} from "moesi";
import { getCreate2Address, keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import type { CliIo } from "../src/command.js";
import { runCli } from "../src/command.js";
import type { CliFetch } from "../src/rpc.js";

const CHAIN_ID = 8453;
const BLOCK_HASH = `0x${"11".repeat(32)}` as const;
const CODE = "0x6000" as const;
const RUNTIME_HASH = keccak256(CODE);
const FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3" as const;
const EXPECTED_RESULT = `0x${"00".repeat(31)}2a` as const;
const CURRENT_RESULT = `0x${"00".repeat(32)}` as const;
const OWNER = `0x${"aa".repeat(20)}` as const;

function manifest(): MoesiManifest {
  return {
    version: "moesi.manifest/v1",
    contracts: [
      {
        id: "counter",
        deployment: {
          kind: "create2-factory-v1",
          salt: `0x${"bb".repeat(32)}`,
          initCode: "0x60006000",
          value: "7",
        },
        expectedRuntimeCodeHash: RUNTIME_HASH,
        configuration: [
          {
            id: "value",
            readData: "0x3fa4f245",
            expectedResult: EXPECTED_RESULT,
            writeData: `0x55241077${"00".repeat(31)}2a`,
            value: "3",
          },
        ],
        sender: { kind: "owner-eoa", address: OWNER },
        enforcement: {
          callScope: "required-onchain",
          expiry: "required",
          operationLimit: "required",
        },
      },
    ],
  };
}

async function reviewedPlan(
  disposition: "changes" | "blocked" | "converged" = "changes",
): Promise<ReviewedPlan> {
  return createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "16", blockHash: BLOCK_HASH };
      },
      async readCode({ address }) {
        if (address === CREATE2_FACTORY_V1_ADDRESS) {
          return disposition === "blocked" ? "0x" : FACTORY_RUNTIME;
        }
        return disposition === "converged" ? CODE : "0x";
      },
      async readCall() {
        return EXPECTED_RESULT;
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({ manifest: manifest(), chains: [CHAIN_ID] });
}

async function partialPlan(): Promise<ReviewedPlan> {
  const desired = manifest();
  const first = desired.contracts[0];
  if (first === undefined) throw new Error("inspect fixture has no contract");
  const configured = { ...first, id: "configured", deployment: { ...first.deployment } };
  const missing = {
    ...first,
    id: "missing",
    deployment: { ...first.deployment, salt: `0x${"cc".repeat(32)}` as const },
    configuration: [],
  };
  const configuredAddress = getCreate2Address({
    from: CREATE2_FACTORY_V1_ADDRESS,
    salt: configured.deployment.salt,
    bytecodeHash: keccak256(configured.deployment.initCode),
  }).toLowerCase();
  return createMoesi({
    observer: {
      async captureSnapshot() {
        return { blockNumber: "16", blockHash: BLOCK_HASH };
      },
      async readCode({ address }) {
        return address === configuredAddress ? CODE : "0x";
      },
      async readCall() {
        return CURRENT_RESULT;
      },
      async checkBlockAncestry() {
        return true;
      },
    },
  }).plan({
    manifest: { version: "moesi.manifest/v1", contracts: [configured, missing] },
    chains: [CHAIN_ID],
  });
}

function artifact(plan: ReviewedPlan): string {
  return JSON.stringify({ version: "moesi.cli-plan/v1", plan });
}

function harness(source: string): {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly reads: () => number;
  readonly authorityAccesses: () => number;
} {
  const output: string[] = [];
  const errors: string[] = [];
  let reads = 0;
  let authorityAccesses = 0;
  const unavailable = (boundary: string): never => {
    authorityAccesses += 1;
    throw new Error(`inspect must not access ${boundary}`);
  };
  return {
    io: {
      stdout: (text) => output.push(text),
      stderr: (text) => errors.push(text),
      async readFile() {
        reads += 1;
        return source;
      },
      fetch: (async () => unavailable("fetch")) as CliFetch,
      createRunStore() {
        return unavailable("Run store");
      },
      readEnv() {
        return unavailable("environment");
      },
      createViemRuntime() {
        return unavailable("execution provider");
      },
      installSignalHandlers() {
        return unavailable("signal handlers");
      },
    },
    stdout: () => output.join(""),
    stderr: () => errors.join(""),
    reads: () => reads,
    authorityAccesses: () => authorityAccesses,
  };
}

describe("moesi inspect", () => {
  it("renders the exact canonical wrapper without runtime or execution authority", async () => {
    const plan = await reviewedPlan();
    const test = harness(artifact(plan));

    expect(await runCli(["inspect", "--plan", "./plan.json", "--json"], test.io)).toBe(0);
    expect(test.stdout()).toBe(`${artifact(plan)}\n`);
    expect(JSON.parse(test.stdout())).toEqual({ version: "moesi.cli-plan/v1", plan });
    expect(test.stderr()).toBe("");
    expect(test.reads()).toBe(1);
    expect(test.authorityAccesses()).toBe(0);
  });

  it("fully renders normalized plan evidence, ordered work, and requirements", async () => {
    const plan = await reviewedPlan();
    const test = harness(artifact(plan));
    const deploy = plan.steps.find(({ kind }) => kind === "deploy");
    const configure = plan.steps.find(({ kind }) => kind === "configure");
    const requirement = plan.requirements[0];
    const manifestContract = plan.manifest.contracts[0];
    const cell = plan.cells[0];
    if (
      deploy === undefined ||
      configure === undefined ||
      requirement === undefined ||
      manifestContract === undefined ||
      cell === undefined
    ) {
      throw new Error("inspect fixture lacks reviewed plan details");
    }
    const requirementCall = requirement.calls[0];
    if (requirementCall === undefined) throw new Error("inspect fixture has no requirement call");
    const deployIndex = plan.steps.indexOf(deploy);
    const configureIndex = plan.steps.indexOf(configure);
    const deployPostcondition = deploy.postconditions[0];
    if (deployPostcondition === undefined) throw new Error("inspect fixture has no postcondition");
    if (deployPostcondition.kind !== "runtime-code-hash") {
      throw new Error("expected deployment runtime postcondition");
    }

    expect(await runCli(["inspect", "--plan", "./plan.json"], test.io)).toBe(0);
    const output = test.stdout();
    expect(output).toContain(`Moesi reviewed plan ${plan.planId}`);
    expect(output).toContain(`version ${plan.version}`);
    expect(output).toContain(`disposition ${plan.disposition}`);
    expect(output).toContain(`manifest-hash ${plan.manifestHash}`);
    expect(output).toContain(
      `manifest contract counter deployment kind=create2-factory-v1 salt=${manifestContract.deployment.salt} initCode=0x60006000 value=7`,
    );
    expect(output).toContain(
      `manifest contract counter configuration value readData=0x3fa4f245 expectedResult=${EXPECTED_RESULT} writeData=0x55241077${"00".repeat(31)}2a value=3`,
    );
    expect(output).toContain(`manifest contract counter sender kind=owner-eoa address=${OWNER}`);
    expect(output).toContain(
      "manifest contract counter enforcement callScope=required-onchain expiry=required operationLimit=required",
    );
    expect(output).toContain(`snapshot ${CHAIN_ID} blockNumber=16 blockHash=${BLOCK_HASH}`);
    expect(output).toContain(
      `capability ${CHAIN_ID} create2-factory-v1 address=${CREATE2_FACTORY_V1_ADDRESS}`,
    );
    expect(output).toContain(
      `cell ${CHAIN_ID} counter address=${cell.address} expectedRuntimeCodeHash=${RUNTIME_HASH} status=missing`,
    );
    expect(output).toContain(
      `cell ${CHAIN_ID} counter configuration value readData=0x3fa4f245 caller=${OWNER} expectedResult=${EXPECTED_RESULT} evidence=not-observed`,
    );
    expect(output).toContain(
      `step ${CHAIN_ID} ${deploy.id} index=${deployIndex} call target=${deploy.call.target} data=${deploy.call.data} value=${deploy.call.value}`,
    );
    expect(output).toContain(
      `step ${CHAIN_ID} ${configure.id} index=${configureIndex} call target=${configure.call.target} data=${configure.call.data} value=${configure.call.value}`,
    );
    expect(output).toContain(
      `step ${CHAIN_ID} ${deploy.id} index=${deployIndex} postcondition 0 kind=runtime-code-hash address=${deployPostcondition.address} expectedHash=${RUNTIME_HASH}`,
    );
    expect(output).toContain(
      `step ${CHAIN_ID} ${configure.id} index=${configureIndex} postcondition 0 kind=static-call target=${configure.call.target} data=0x3fa4f245 caller=${OWNER} expectedResult=${EXPECTED_RESULT}`,
    );
    expect(output).toContain(`requirement ${CHAIN_ID} calls 2`);
    expect(output).toContain(
      `requirement ${CHAIN_ID} call 0 target=${requirementCall.target} data=${requirementCall.data} value=${requirementCall.value}`,
    );
    expect(output).toContain(`requirement ${CHAIN_ID} postconditions 2`);
    expect(output).toContain(
      `requirement ${CHAIN_ID} sender kind=reviewed-owner-eoa address=${OWNER}`,
    );
    for (const providerBoundField of [
      "providerId",
      "route=",
      "confirmations=",
      "reviewId",
      "runStoreId",
      "execution-state",
    ]) {
      expect(output).not.toContain(providerBoundField);
    }
    expect(test.stderr()).toBe("");
    expect(test.authorityAccesses()).toBe(0);
  });

  it("returns zero for every valid reviewed-plan disposition", async () => {
    const plans = [
      await reviewedPlan("converged"),
      await reviewedPlan("changes"),
      await reviewedPlan("blocked"),
      await partialPlan(),
    ];
    expect(plans.map(({ disposition }) => disposition)).toEqual([
      "converged",
      "changes",
      "blocked",
      "partial",
    ]);

    for (const plan of plans) {
      const test = harness(artifact(plan));
      expect(await runCli(["inspect", "--plan", "./plan.json"], test.io)).toBe(0);
      expect(test.stderr()).toBe("");
      expect(test.authorityAccesses()).toBe(0);
    }
  });

  it("does not claim discarded configuration evidence was never observed", async () => {
    const desired = manifest();
    const contract = desired.contracts[0];
    if (contract === undefined) throw new Error("inspect fixture has no contract");
    const firstReadData = "0x11111111" as const;
    const failedReadData = "0x22222222" as const;
    const plan = await createMoesi({
      observer: {
        async captureSnapshot() {
          return { blockNumber: "16", blockHash: BLOCK_HASH };
        },
        async readCode() {
          return CODE;
        },
        async readCall({ data }) {
          if (data === firstReadData) return EXPECTED_RESULT;
          throw new Error("credential-bearing read failure");
        },
        async checkBlockAncestry() {
          return true;
        },
      },
    }).plan({
      chains: [CHAIN_ID],
      manifest: {
        version: "moesi.manifest/v1",
        contracts: [
          {
            ...contract,
            configuration: [
              {
                id: "first",
                readData: firstReadData,
                expectedResult: EXPECTED_RESULT,
                writeData: "0x33333333",
                value: "0",
              },
              {
                id: "second",
                readData: failedReadData,
                expectedResult: EXPECTED_RESULT,
                writeData: "0x44444444",
                value: "0",
              },
            ],
          },
        ],
      },
    });
    const test = harness(artifact(plan));

    expect(await runCli(["inspect", "--plan", "./plan.json"], test.io)).toBe(0);
    expect(test.stdout()).toContain(
      `cell ${CHAIN_ID} counter configuration first readData=${firstReadData} caller=${OWNER} expectedResult=${EXPECTED_RESULT} evidence=not-recorded`,
    );
    expect(test.stdout()).toContain(
      `cell ${CHAIN_ID} counter configuration second readData=${failedReadData} caller=${OWNER} expectedResult=${EXPECTED_RESULT} evidence=unreadable reason=configuration-read-failed`,
    );
    expect(test.stdout()).not.toContain("credential-bearing read failure");
  });

  it.each([
    ["chain", ["--chain", "8453=https://rpc.example"]],
    ["provider", ["--provider", "viem"]],
    ["signer", ["--signer", "8453=MOESI_KEY"]],
    ["store", ["--store", ".moesi/runs"]],
    ["run", ["--run", `0x${"22".repeat(32)}`]],
    ["manifest", ["--manifest", "./moesi.json"]],
    ["review acceptance", ["--accept-review", `0x${"33".repeat(32)}`]],
    ["confirmation", ["--confirmations", "1"]],
    ["observation attempts", ["--observe-attempts", "1"]],
    ["observation delay", ["--observe-delay-ms", "0"]],
  ])("rejects the %s flag before reading the plan", async (_label, flags) => {
    const test = harness("must not be read");

    expect(await runCli(["inspect", "--plan", "./plan.json", ...flags], test.io)).toBe(1);
    expect(test.stderr()).toBe("MOESI_CLI_ERROR invalid_arguments\n");
    expect(test.reads()).toBe(0);
    expect(test.authorityAccesses()).toBe(0);
  });

  it("strictly rejects malformed wrappers, tampering, and unknown schema fields", async () => {
    const plan = await reviewedPlan();
    const invalidValues: unknown[] = [
      plan,
      { version: "moesi.cli-plan/v2", plan },
      { version: "moesi.cli-plan/v1", plan, metadata: {} },
      { version: "moesi.cli-plan/v1", plan: { ...plan, planId: `0x${"ff".repeat(32)}` } },
      { version: "moesi.cli-plan/v1", plan: { ...plan, unexpected: [] } },
      {
        version: "moesi.cli-plan/v1",
        plan: { ...plan, cells: [{ ...plan.cells[0], unexpected: true }] },
      },
      {
        version: "moesi.cli-plan/v1",
        plan: {
          ...plan,
          manifest: {
            ...plan.manifest,
            contracts: [{ ...plan.manifest.contracts[0], unexpected: [] }],
          },
        },
      },
    ];

    for (const value of invalidValues) {
      const test = harness(JSON.stringify(value));
      expect(await runCli(["inspect", "--plan", "./plan.json", "--json"], test.io)).toBe(1);
      expect(JSON.parse(test.stderr())).toMatchObject({
        version: "moesi.cli-error/v1",
        error: { code: expect.any(String) },
      });
      expect(test.stdout()).toBe("");
      expect(test.authorityAccesses()).toBe(0);
    }
  });
});
