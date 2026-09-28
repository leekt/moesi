import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import {
  type Address,
  concatHex,
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  type Hex,
  http,
  keccak256,
  padHex,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineFleet } from "../src/fleet/index.js";
import {
  type CallReadRequest,
  type CodeReadRequest,
  CREATE2_FACTORY_V1_ADDRESS,
  CREATE2_FACTORY_V1_RUNTIME_CODE_HASH,
  CREATEX_DEPLOY_CREATE2_SELECTOR,
  CREATEX_FACTORY_V1_ADDRESS,
  CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
  createMoesi,
  deriveCreateXSenderProtectedRawSalt,
  type ManifestManagedResource,
  MemoryDeploymentRunStore,
  type MoesiManifest,
  type MoesiObservationAdapter,
  parseDeploymentRunRecord,
  type SemanticCheck,
  type StorageReadRequest,
} from "../src/index.js";
import { createViemExecutionProvider, createViemObservationAdapter } from "../src/viem/index.js";

const CHAIN_ID = 31_337;
const ANVIL_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const WRONG_ACCOUNT_ADDRESS = "0x1000000000000000000000000000000000000002" as const;
const SALT = `0x${"42".repeat(32)}` as Hex;
const CREATEX_ENTROPY = `0x${"52".repeat(11)}` as const;
const MISMATCH_SALT = `0x${"43".repeat(32)}` as Hex;
const ATTESTATION_SALT = `0x${"45".repeat(32)}` as Hex;
const PREREQUISITE_SALT = `0x${"46".repeat(32)}` as Hex;
const DEPENDENT_SALT = `0x${"47".repeat(32)}` as Hex;
const EXTERNAL_ADDRESS = "0x10000000000000000000000000000000000000aa" as const satisfies Address;
const ATTESTATION_CALLER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const satisfies Address;
const ATTESTATION_OWNER_SLOT = `0x${"0".repeat(64)}` as const satisfies Hex;
const ATTESTATION_MARKER_SLOT = `0x${"0".repeat(63)}1` as const satisfies Hex;
const ATTESTATION_OWNER_WORD =
  `0x${"0".repeat(24)}${"f39fd6e51aad88f6f4ce6ab8827279cfffb92266"}` as Hex;
const ATTESTATION_DRIFTED_OWNER_WORD = `0x${"0".repeat(24)}${"11".repeat(20)}` as Hex;
const ATTESTATION_MARKER_WORD = `0x${"ab".repeat(32)}` as const satisfies Hex;
const ATTESTATION_DRIFTED_MARKER_WORD = `0x${"cd".repeat(32)}` as const satisfies Hex;
const CREATE2_FACTORY_RUNTIME =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const CREATEX_CREATE2_ABI = [
  {
    type: "function",
    name: "deployCreate2",
    stateMutability: "payable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initCode", type: "bytes" },
    ],
    outputs: [{ name: "newContract", type: "address" }],
  },
] as const;

const CONFIGURABLE_ABI = [
  {
    type: "function",
    name: "value",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setValue",
    stateMutability: "nonpayable",
    inputs: [{ name: "nextValue", type: "uint256" }],
    outputs: [],
  },
] as const;

const MANAGED_ATTESTATION_ABI = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

interface CompiledContract {
  readonly initCode: Hex;
  readonly runtimeCode: Hex;
}

describe.sequential("local Anvil viem convergence", () => {
  let anvil: ChildProcessWithoutNullStreams;
  let rpcUrl: string;
  let configurable: CompiledContract;
  let managedAttestation: CompiledContract;

  beforeAll(async () => {
    configurable = await compile("Configurable.sol", "Configurable");
    managedAttestation = await compile("ManagedAttestation.sol", "ManagedAttestation");
    const port = await availablePort();
    rpcUrl = `http://127.0.0.1:${port}`;
    anvil = spawn("anvil", ["--silent", "--chain-id", String(CHAIN_ID), "--port", String(port)], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitForRpc(rpcUrl, anvil);
    // Non-circular pin evidence: Anvil preloads the genuine Arachnid deployer
    // in genesis, so the repo's literal (and therefore the pinned hash derived
    // from it) must match real deployed code before any test overwrites it.
    const genesisFactory = await rpc(rpcUrl, "eth_getCode", [CREATE2_FACTORY_V1_ADDRESS, "latest"]);
    expect(genesisFactory).toBe(CREATE2_FACTORY_RUNTIME);
    expect(keccak256(CREATE2_FACTORY_RUNTIME)).toBe(CREATE2_FACTORY_V1_RUNTIME_CODE_HASH);
  }, 20_000);

  afterAll(async () => {
    if (!anvil || anvil.exitCode !== null) return;
    anvil.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      anvil.once("exit", () => resolve());
      setTimeout(resolve, 2_000);
    });
  });

  it("plans, reviews, executes, observes, verifies, and converges through moesi/viem", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    expect(keccak256(CREATE2_FACTORY_RUNTIME)).toBe(CREATE2_FACTORY_V1_RUNTIME_CODE_HASH);
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);

    const expectedAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: SALT,
      bytecodeHash: keccak256(configurable.initCode),
    });
    const desiredResult = `0x${"0".repeat(24)}${expectedAddress.slice(2).toLowerCase()}` as Hex;
    const addressReference = { kind: "resource-address-word", resourceId: "configurable" } as const;
    const expectedWriteData = encodeFunctionData({
      abi: CONFIGURABLE_ABI,
      functionName: "setValue",
      args: [BigInt(expectedAddress)],
    });
    const baseContract: ManifestManagedResource = {
      kind: "managed",
      id: "configurable",
      deployment: {
        kind: "create2-factory-v1",
        requiresRuntime: [],
        salt: SALT,
        initCode: configurable.initCode,
        value: "0",
      },
      expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
      checks: [],
      storageChecks: [],
      configuration: [
        {
          id: "value",
          readData: encodeFunctionData({ abi: CONFIGURABLE_ABI, functionName: "value" }),
          expectedResult: addressReference,
          writeData: {
            kind: "concat",
            parts: [expectedWriteData.slice(0, 10) as Hex, addressReference],
          },
          value: "0",
        },
      ],
    };
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const moesi = createMoesi({ observer, runStore: new MemoryDeploymentRunStore() });

    const wrongSenderManifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          ...baseContract,
          sender: { kind: "owner-eoa", address: "0x1000000000000000000000000000000000000001" },
        },
      ],
    };
    const wrongSenderPlan = await moesi.plan({
      manifest: wrongSenderManifest,
      chains: [CHAIN_ID],
    });
    const wrongSenderReview = await moesi.reviewExecution({ plan: wrongSenderPlan, provider });
    expect(wrongSenderReview.provider.status).toBe("blocked");
    expect(wrongSenderReview.provider.reasons).toContainEqual(
      expect.objectContaining({ code: "sender-mismatch", chainId: CHAIN_ID }),
    );

    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          ...baseContract,
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const plan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.cells[0]?.status.kind).toBe("missing");
    expect(plan.steps.map(({ kind }) => kind)).toEqual(["deploy", "configure"]);
    expect(plan.steps[1]?.call.data).toBe(expectedWriteData);
    expect(JSON.stringify(plan)).not.toContain("resource-address-word");
    expect(plan.requirements[0]?.calls).toEqual(plan.steps.map(({ call }) => call));
    const executionReview = await moesi.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const deployment = await moesi.apply({ plan, provider, executionReview }).wait();
    expect(deployment.chains[0]?.execution.kind).toBe("finalized");
    expect(deployment.chains[0]?.execution).toMatchObject({
      steps: [{ stepId: "configurable:deploy" }, { stepId: "configurable:configure:value" }],
    });
    expect(deployment.status).toBe("converged");
    expect(deployment.chains[0]?.status).toBe("converged");
    expect(deployment.chains[0]?.cells[0]?.configurations[0]?.status).toEqual({
      kind: "satisfied",
      observedResult: desiredResult,
    });
    expect(await publicClient.getCode({ address: expectedAddress })).toBe(configurable.runtimeCode);

    const deploymentExecution = deployment.chains[0]?.execution;
    if (deploymentExecution?.kind !== "finalized" || !deploymentExecution.steps[0]) {
      throw new Error("deployment lacked a finalized reference");
    }
    await expect(
      provider.observe({ reference: deploymentExecution.steps[0].reference }),
    ).resolves.toMatchObject({ status: "finalized" });

    const convergedPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.steps).toEqual([]);
  }, 30_000);

  it("converges sender-protected CreateX CREATE2 through its exact canonical runtime", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const wrongWalletClient = {
      account: { address: WRONG_ACCOUNT_ADDRESS, type: "local" as const },
      chain,
      async sendTransaction(): Promise<Hex> {
        throw new Error("wrong-sender wallet must never sign");
      },
    };
    const createXRuntime = (
      await readFile(new URL("./fixtures/CreateX.runtime.hex", import.meta.url), "utf8")
    ).trim() as Hex;
    expect(createXRuntime).toMatch(/^0x[0-9a-f]+$/);
    expect(keccak256(createXRuntime)).toBe(CREATEX_FACTORY_V1_RUNTIME_CODE_HASH);
    await rpc(rpcUrl, "anvil_setCode", [CREATEX_FACTORY_V1_ADDRESS, createXRuntime]);

    const rawSalt = deriveCreateXSenderProtectedRawSalt({
      sender: account.address,
      entropy: CREATEX_ENTROPY,
    });
    expect(rawSalt).toBe(concatHex([account.address, "0x00", CREATEX_ENTROPY]).toLowerCase());
    const guardedSalt = keccak256(
      encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [account.address, rawSalt]),
    );
    const expectedAddress = getCreate2Address({
      from: CREATEX_FACTORY_V1_ADDRESS,
      salt: guardedSalt,
      bytecodeHash: keccak256(configurable.initCode),
    }).toLowerCase() as Address;
    const expectedCalldata = encodeFunctionData({
      abi: CREATEX_CREATE2_ABI,
      functionName: "deployCreate2",
      args: [rawSalt, configurable.initCode],
    });
    expect(expectedCalldata.startsWith(CREATEX_DEPLOY_CREATE2_SELECTOR)).toBe(true);

    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "createx-configurable",
          deployment: {
            kind: "createx-create2-v1",
            entropy: CREATEX_ENTROPY,
            initCode: configurable.initCode,
            value: "0",
            requiresRuntime: [],
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const wrongProvider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? wrongWalletClient : undefined),
      confirmations: 1,
    });
    const store = new MemoryDeploymentRunStore();
    const client = createMoesi({ observer, runStore: store });
    const plan = await client.plan({ manifest, chains: [CHAIN_ID] });

    expect(plan.cells[0]).toMatchObject({ address: expectedAddress, status: { kind: "missing" } });
    expect(plan.capabilities).toEqual([
      {
        kind: "createx-factory-v1",
        chainId: CHAIN_ID,
        address: CREATEX_FACTORY_V1_ADDRESS,
        expectedRuntimeCodeHash: CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
        status: {
          kind: "available",
          observedRuntimeCodeHash: CREATEX_FACTORY_V1_RUNTIME_CODE_HASH,
        },
      },
    ]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      id: "createx-configurable:deploy",
      sender: { kind: "reviewed-owner-eoa", address: account.address.toLowerCase() },
      call: {
        target: CREATEX_FACTORY_V1_ADDRESS,
        data: expectedCalldata,
        value: "0",
      },
    });
    expect(plan.requirements[0]?.sender).toEqual({
      kind: "reviewed-owner-eoa",
      address: account.address.toLowerCase(),
    });

    const senderNonceBeforeWrongReview = await publicClient.getTransactionCount({
      address: account.address,
    });
    const wrongNonceBefore = await publicClient.getTransactionCount({
      address: WRONG_ACCOUNT_ADDRESS,
    });
    const wrongReview = await client.reviewExecution({ plan, provider: wrongProvider });
    expect(wrongReview.provider.status).toBe("blocked");
    expect(wrongReview.provider.reasons).toContainEqual(
      expect.objectContaining({ code: "sender-mismatch", chainId: CHAIN_ID }),
    );
    expect(() =>
      client.apply({ plan, provider: wrongProvider, executionReview: wrongReview }),
    ).toThrowError(expect.objectContaining({ code: "provider_review_blocked" }));
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
      senderNonceBeforeWrongReview,
    );
    expect(await publicClient.getTransactionCount({ address: WRONG_ACCOUNT_ADDRESS })).toBe(
      wrongNonceBefore,
    );
    expect(await publicClient.getCode({ address: expectedAddress })).toBeUndefined();

    const executionReview = await client.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const senderNonceBefore = await publicClient.getTransactionCount({ address: account.address });
    const deployment = await client.apply({ plan, provider, executionReview }).wait();

    expect(deployment.status).toBe("converged");
    expect(deployment.chains[0]?.status).toBe("converged");
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
      senderNonceBefore + 1,
    );
    expect(await publicClient.getCode({ address: expectedAddress })).toBe(configurable.runtimeCode);
    const execution = deployment.chains[0]?.execution;
    if (execution?.kind !== "finalized" || execution.steps[0] === undefined) {
      throw new Error("CreateX deployment lacked finalized evidence");
    }
    const reference = execution.steps[0].reference;
    const referenceMatch = /^viem-tx-v1:(0x[0-9a-f]{64}):confirmations-1$/.exec(
      reference.reference,
    );
    if (referenceMatch?.[1] === undefined) throw new Error("unexpected viem reference codec");
    const transaction = await publicClient.getTransaction({ hash: referenceMatch[1] as Hex });
    expect(transaction).toMatchObject({
      from: account.address.toLowerCase(),
      to: CREATEX_FACTORY_V1_ADDRESS,
      input: expectedCalldata,
      value: 0n,
      nonce: senderNonceBefore,
    });
    await expect(provider.observe({ reference })).resolves.toMatchObject({
      status: "finalized",
      finalized: {
        sender: account.address.toLowerCase(),
        calls: [{ target: CREATEX_FACTORY_V1_ADDRESS, data: expectedCalldata, value: "0" }],
      },
    });
    await expect(client.verify({ plan })).resolves.toMatchObject({ status: "converged" });
    const convergedPlan = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.steps).toEqual([]);
  }, 30_000);

  it("converges unguarded CreateX CREATE2 and CREATE3 from any sender", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const createXRuntime = (
      await readFile(new URL("./fixtures/CreateX.runtime.hex", import.meta.url), "utf8")
    ).trim() as Hex;
    await rpc(rpcUrl, "anvil_setCode", [CREATEX_FACTORY_V1_ADDRESS, createXRuntime]);

    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const client = createMoesi({ observer, runStore: new MemoryDeploymentRunStore() });

    for (const [kind, entropy] of [
      ["createx-create2-unguarded-v1", `0x${"61".repeat(11)}`],
      ["createx-create3-unguarded-v1", `0x${"62".repeat(11)}`],
    ] as const) {
      const manifest: MoesiManifest = {
        version: "moesi.manifest/v6",
        contracts: [
          {
            kind: "managed",
            id: "unguarded",
            deployment: {
              kind,
              entropy,
              initCode: configurable.initCode,
              value: "0",
              requiresRuntime: [],
            },
            expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
            checks: [],
            storageChecks: [],
            configuration: [],
          },
        ],
      };
      const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
      expect(plan.cells[0]?.status.kind).toBe("missing");
      expect(plan.steps.map(({ kind: stepKind }) => stepKind)).toEqual(["deploy"]);
      // Unguarded strategies bind no sender: the plan is sender-independent.
      expect(plan.requirements[0]?.sender).toEqual({ kind: "sender-independent" });
      const expectedAddress = plan.cells[0]?.address as Address;

      const executionReview = await client.reviewExecution({ plan, provider });
      expect(executionReview.provider.status).toBe("supported");
      const deployment = await client.apply({ plan, provider, executionReview }).wait();
      expect(deployment.status).toBe("converged");
      // The on-chain deployment landed at exactly the derived address: the
      // unguarded salt math matches what the real CreateX runtime computes.
      expect(await publicClient.getCode({ address: expectedAddress })).toBe(
        configurable.runtimeCode,
      );

      const convergedPlan = await client.plan({ manifest, chains: [CHAIN_ID] });
      expect(convergedPlan.disposition).toBe("converged");
      expect(convergedPlan.steps).toEqual([]);
      await expect(client.verify({ plan })).resolves.toMatchObject({ status: "converged" });
    }
  }, 30_000);

  it("observes and freshly verifies an exact-address external resource without authority", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const baseObserver = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const reads: CodeReadRequest[] = [];
    const calls: CallReadRequest[] = [];
    const storageReads: StorageReadRequest[] = [];
    const observer = {
      ...baseObserver,
      async readCode(request: CodeReadRequest): Promise<unknown> {
        reads.push(request);
        return baseObserver.readCode(request);
      },
      async readCall(request: CallReadRequest): Promise<unknown> {
        calls.push(request);
        return baseObserver.readCall(request);
      },
      async readStorage(request: StorageReadRequest): Promise<unknown> {
        storageReads.push(request);
        if (baseObserver.readStorage === undefined) throw new Error("storage reader unavailable");
        return baseObserver.readStorage(request);
      },
    };
    const client = createMoesi({ observer });
    const externalCaller = account.address.toLowerCase() as Address;
    const valueReadData = encodeFunctionData({ abi: CONFIGURABLE_ABI, functionName: "value" });
    const zeroResult = `0x${"00".repeat(32)}` as const;
    const driftedResult = `0x${"00".repeat(31)}2a` as const;
    const storageSlot = `0x${"00".repeat(31)}01` as const;
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "external",
          id: "canonical-infrastructure",
          address: EXTERNAL_ADDRESS,
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [
            {
              id: "value",
              caller: externalCaller,
              readData: valueReadData,
              expectedResult: zeroResult,
            },
          ],
          storageChecks: [
            {
              id: "raw-value",
              slot: storageSlot,
              expectedWord: zeroResult,
            },
          ],
        },
      ],
    };
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });

    await rpc(rpcUrl, "anvil_setCode", [EXTERNAL_ADDRESS, configurable.runtimeCode]);
    await rpc(rpcUrl, "evm_mine", []);
    try {
      const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
      expect(plan.disposition).toBe("converged");
      expect(plan.cells).toMatchObject([
        {
          resourceId: "canonical-infrastructure",
          address: EXTERNAL_ADDRESS,
          configuration: [],
          checks: [
            {
              id: "value",
              caller: externalCaller,
              readData: valueReadData,
              expectedResult: zeroResult,
            },
          ],
          storageChecks: [
            {
              id: "raw-value",
              slot: storageSlot,
              expectedWord: zeroResult,
            },
          ],
          status: { kind: "converged" },
        },
      ]);
      expect(plan.capabilities).toEqual([]);
      expect(plan.steps).toEqual([]);
      expect(plan.requirements).toEqual([]);

      const converged = await client.verify({ plan });
      expect(converged.status).toBe("converged");
      expect(converged.chains[0]?.cells[0]?.status).toEqual({
        kind: "satisfied",
        observedRuntimeCodeHash: keccak256(configurable.runtimeCode),
      });
      expect(converged.chains[0]?.cells[0]?.callChecks).toEqual([
        {
          kind: "call",
          target: EXTERNAL_ADDRESS,
          id: "value",
          expectedResult: zeroResult,
          status: { kind: "satisfied", observedResult: zeroResult },
        },
      ]);
      expect(converged.chains[0]?.cells[0]?.storageChecks).toEqual([
        {
          kind: "word",
          id: "raw-value",
          slot: storageSlot,
          expectedWord: zeroResult,
          status: { kind: "satisfied", observedWord: zeroResult },
        },
      ]);

      await rpc(rpcUrl, "anvil_setStorageAt", [EXTERNAL_ADDRESS, storageSlot, driftedResult]);
      await rpc(rpcUrl, "evm_mine", []);
      const storageDrifted = await client.verify({ plan });
      expect(storageDrifted.status).toBe("drifted");
      expect(storageDrifted.chains[0]?.cells[0]?.status).toEqual({
        kind: "drifted",
        observedRuntimeCodeHash: keccak256(configurable.runtimeCode),
      });
      expect(storageDrifted.chains[0]?.cells[0]?.storageChecks[0]?.status).toEqual({
        kind: "drifted",
        observedWord: driftedResult,
      });
      expect(storageDrifted.chains[0]?.cells[0]?.callChecks[0]?.status).toEqual({
        kind: "satisfied",
        observedResult: zeroResult,
      });

      await rpc(rpcUrl, "anvil_setCode", [EXTERNAL_ADDRESS, "0x6001"]);
      await rpc(rpcUrl, "evm_mine", []);
      const drifted = await client.verify({ plan });
      expect(drifted.status).toBe("drifted");
      expect(drifted.chains[0]?.cells[0]?.status).toEqual({
        kind: "drifted",
        observedRuntimeCodeHash: keccak256("0x6001"),
      });

      expect(reads.map(({ address }) => address)).toEqual([
        EXTERNAL_ADDRESS,
        EXTERNAL_ADDRESS,
        EXTERNAL_ADDRESS,
        EXTERNAL_ADDRESS,
      ]);
      expect(reads.some(({ address }) => address === CREATE2_FACTORY_V1_ADDRESS)).toBe(false);
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call.target).toBe(EXTERNAL_ADDRESS);
        expect(call.caller).toBe(externalCaller);
        expect(call.data).toBe(valueReadData);
        expect(call.snapshot.chainId).toBe(CHAIN_ID);
      }
      expect(storageReads).toHaveLength(3);
      for (const storageRead of storageReads) {
        expect(storageRead.address).toBe(EXTERNAL_ADDRESS);
        expect(storageRead.slot).toBe(storageSlot);
        expect(storageRead.snapshot.chainId).toBe(CHAIN_ID);
      }
      expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
        nonceBefore,
      );
    } finally {
      await rpc(rpcUrl, "anvil_setStorageAt", [EXTERNAL_ADDRESS, storageSlot, zeroResult]);
      await rpc(rpcUrl, "anvil_setCode", [EXTERNAL_ADDRESS, "0x"]);
      await rpc(rpcUrl, "evm_mine", []);
    }
  }, 30_000);

  it("keylessly attests a managed call and storage word without remediation authority", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const address = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: ATTESTATION_SALT,
      bytecodeHash: keccak256(managedAttestation.initCode),
    }).toLowerCase() as Address;
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    const deploymentHash = await walletClient.sendTransaction({
      account,
      chain,
      to: CREATE2_FACTORY_V1_ADDRESS,
      data: concatHex([ATTESTATION_SALT, managedAttestation.initCode]),
      value: 0n,
    });
    await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
    expect(await publicClient.getCode({ address })).toBe(managedAttestation.runtimeCode);
    expect(await publicClient.getStorageAt({ address, slot: ATTESTATION_OWNER_SLOT })).toBe(
      ATTESTATION_OWNER_WORD,
    );
    expect(await publicClient.getStorageAt({ address, slot: ATTESTATION_MARKER_SLOT })).toBe(
      ATTESTATION_MARKER_WORD,
    );

    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const client = createMoesi({ observer });
    const plan = await client.plan({
      chains: [CHAIN_ID],
      manifest: {
        version: "moesi.manifest/v6",
        contracts: [
          {
            kind: "managed",
            id: "attested",
            deployment: {
              kind: "create2-factory-v1",
              requiresRuntime: [],
              salt: ATTESTATION_SALT,
              initCode: managedAttestation.initCode,
              value: "0",
            },
            expectedRuntimeCodeHash: keccak256(managedAttestation.runtimeCode),
            checks: [
              {
                id: "owner",
                caller: ATTESTATION_CALLER,
                readData: encodeFunctionData({
                  abi: MANAGED_ATTESTATION_ABI,
                  functionName: "owner",
                }),
                expectedResult: ATTESTATION_OWNER_WORD,
              },
            ],
            storageChecks: [
              {
                id: "marker",
                slot: ATTESTATION_MARKER_SLOT,
                expectedWord: ATTESTATION_MARKER_WORD,
              },
            ],
            configuration: [],
          },
        ],
      },
    });

    expect(plan.disposition).toBe("converged");
    expect(plan.steps).toEqual([]);
    expect(plan.requirements).toEqual([]);
    expect(plan.cells[0]).toMatchObject({
      resourceId: "attested",
      address,
      configuration: [],
      checks: [
        {
          id: "owner",
          caller: ATTESTATION_CALLER,
          expectedResult: ATTESTATION_OWNER_WORD,
        },
      ],
      storageChecks: [
        {
          id: "marker",
          slot: ATTESTATION_MARKER_SLOT,
          expectedWord: ATTESTATION_MARKER_WORD,
        },
      ],
      status: {
        kind: "converged",
        configurationResults: [],
        callResults: [{ id: "owner", result: ATTESTATION_OWNER_WORD }],
        storageResults: [{ id: "marker", word: ATTESTATION_MARKER_WORD }],
      },
    });

    const converged = await client.verify({ plan });
    expect(converged).toMatchObject({
      status: "converged",
      chains: [
        {
          status: "converged",
          cells: [
            {
              resourceId: "attested",
              address,
              configurations: [],
              callChecks: [
                {
                  id: "owner",
                  expectedResult: ATTESTATION_OWNER_WORD,
                  status: { kind: "satisfied", observedResult: ATTESTATION_OWNER_WORD },
                },
              ],
              storageChecks: [
                {
                  id: "marker",
                  slot: ATTESTATION_MARKER_SLOT,
                  expectedWord: ATTESTATION_MARKER_WORD,
                  status: { kind: "satisfied", observedWord: ATTESTATION_MARKER_WORD },
                },
              ],
              status: {
                kind: "satisfied",
                observedRuntimeCodeHash: keccak256(managedAttestation.runtimeCode),
              },
            },
          ],
        },
      ],
    });

    await rpc(rpcUrl, "anvil_setStorageAt", [
      address,
      ATTESTATION_OWNER_SLOT,
      ATTESTATION_DRIFTED_OWNER_WORD,
    ]);
    await rpc(rpcUrl, "evm_mine", []);
    const callDrift = await client.verify({ plan });
    expect(callDrift.status).toBe("drifted");
    expect(callDrift.chains[0]?.cells[0]).toMatchObject({
      storageChecks: [
        { id: "marker", status: { kind: "satisfied", observedWord: ATTESTATION_MARKER_WORD } },
      ],
      callChecks: [
        {
          id: "owner",
          status: { kind: "drifted", observedResult: ATTESTATION_DRIFTED_OWNER_WORD },
        },
      ],
      configurations: [],
      status: { kind: "drifted" },
    });

    await rpc(rpcUrl, "anvil_setStorageAt", [
      address,
      ATTESTATION_OWNER_SLOT,
      ATTESTATION_OWNER_WORD,
    ]);
    await rpc(rpcUrl, "anvil_setStorageAt", [
      address,
      ATTESTATION_MARKER_SLOT,
      ATTESTATION_DRIFTED_MARKER_WORD,
    ]);
    await rpc(rpcUrl, "evm_mine", []);
    const storageDrift = await client.verify({ plan });
    expect(storageDrift.status).toBe("drifted");
    expect(storageDrift.chains[0]?.cells[0]).toMatchObject({
      storageChecks: [
        {
          id: "marker",
          status: { kind: "drifted", observedWord: ATTESTATION_DRIFTED_MARKER_WORD },
        },
      ],
      callChecks: [
        { id: "owner", status: { kind: "satisfied", observedResult: ATTESTATION_OWNER_WORD } },
      ],
      configurations: [],
      status: { kind: "drifted" },
    });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonceBefore);
  }, 30_000);

  it("satisfies constructor-established configuration without submitting the reviewed write", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    const salt = `0x${"47".repeat(32)}` as Hex;
    const expectedAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt,
      bytecodeHash: keccak256(managedAttestation.initCode),
    }).toLowerCase() as Address;

    // The constructor already sets owner to the reviewed expected result, and
    // the reviewed write targets a function the contract does not implement,
    // so submitting it would revert and permanently wedge the run.
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "attested",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt,
            initCode: managedAttestation.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(managedAttestation.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [
            {
              id: "owner",
              readData: encodeFunctionData({
                abi: MANAGED_ATTESTATION_ABI,
                functionName: "owner",
              }),
              expectedResult: ATTESTATION_OWNER_WORD,
              writeData:
                "0xf2fde38b000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
              value: "0",
            },
          ],
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const store = new MemoryDeploymentRunStore();
    const moesi = createMoesi({ observer, runStore: store });

    const plan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.steps.map(({ kind }) => kind)).toEqual(["deploy", "configure"]);
    const executionReview = await moesi.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");

    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });
    const run = moesi.apply({ plan, provider, executionReview });
    const deployment = await run.wait();

    expect(deployment.status).toBe("converged");
    expect(run.state).toBe("complete");
    // Exactly one transaction: the deployment. The reviewed write was never
    // submitted because its postcondition already held after the constructor.
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
      nonceBefore + 1,
    );
    expect(await publicClient.getCode({ address: expectedAddress })).toBe(
      managedAttestation.runtimeCode,
    );
    const record = parseDeploymentRunRecord(await store.get(run.runId));
    expect(record.steps).toMatchObject([
      { stepId: "attested:deploy", phase: "finalized" },
      { stepId: "attested:configure:owner", phase: "satisfied" },
    ]);

    const convergedPlan = await moesi.plan({ manifest, chains: [CHAIN_ID] });
    expect(convergedPlan.disposition).toBe("converged");
    expect(convergedPlan.steps).toEqual([]);
  }, 30_000);

  it("orders runtime prerequisites and gates a dependent deployment at one fresh snapshot", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);

    const prerequisiteAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: PREREQUISITE_SALT,
      bytecodeHash: keccak256(configurable.initCode),
    }).toLowerCase() as Address;
    const dependentAddress = getCreate2Address({
      from: CREATE2_FACTORY_V1_ADDRESS,
      salt: DEPENDENT_SALT,
      bytecodeHash: keccak256(configurable.initCode),
    }).toLowerCase() as Address;
    const baseObserver = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const events: Array<
      | {
          readonly kind: "read";
          readonly address: Address;
          readonly snapshot: CodeReadRequest["snapshot"];
        }
      | { readonly kind: "submit"; readonly resourceId: string }
    > = [];
    const observer: MoesiObservationAdapter = {
      ...baseObserver,
      async readCode(request: CodeReadRequest): Promise<unknown> {
        events.push({ kind: "read", address: request.address, snapshot: request.snapshot });
        return baseObserver.readCode(request);
      },
    };
    const baseProvider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const submittedResources = new Map<string, string>();
    let corrupted = false;
    const provider = Object.freeze({
      id: baseProvider.id,
      review: (request: Parameters<typeof baseProvider.review>[0]) => baseProvider.review(request),
      prepare: (request: Parameters<typeof baseProvider.prepare>[0]) =>
        baseProvider.prepare(request),
      async submit(request: Parameters<typeof baseProvider.submit>[0]) {
        events.push({ kind: "submit", resourceId: request.action.step.resourceId });
        const reference = await baseProvider.submit(request);
        submittedResources.set(reference.reference, request.action.step.resourceId);
        return reference;
      },
      async observe(request: Parameters<typeof baseProvider.observe>[0]) {
        const evidence = await baseProvider.observe(request);
        if (
          !corrupted &&
          evidence.status === "finalized" &&
          submittedResources.get(request.reference.reference) === "runtime-prerequisite"
        ) {
          corrupted = true;
          await rpc(rpcUrl, "anvil_setCode", [prerequisiteAddress, "0x6001"]);
          await rpc(rpcUrl, "evm_mine", []);
        }
        return evidence;
      },
    });
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "runtime-dependent",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: ["runtime-prerequisite"],
            salt: DEPENDENT_SALT,
            initCode: configurable.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: account.address },
        },
        {
          kind: "managed",
          id: "runtime-prerequisite",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: PREREQUISITE_SALT,
            initCode: configurable.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const store = new MemoryDeploymentRunStore();
    const client = createMoesi({ observer, runStore: store });
    const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.steps.map(({ id }) => id)).toEqual([
      "runtime-prerequisite:deploy",
      "runtime-dependent:deploy",
    ]);
    const executionReview = await client.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });
    events.length = 0;

    const run = client.apply({ plan, provider, executionReview });
    const blocked = await run.wait();

    expect(blocked.chains[0]?.execution).toMatchObject({
      kind: "failed",
      reason: "deployment-prerequisite-mismatch",
      steps: [{ stepId: "runtime-prerequisite:deploy" }],
    });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
      nonceBefore + 1,
    );
    expect(await publicClient.getCode({ address: dependentAddress })).toBeUndefined();
    expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
      { stepId: "runtime-prerequisite:deploy", phase: "finalized" },
      { stepId: "runtime-dependent:deploy", phase: "pending" },
    ]);
    const prerequisiteSubmitIndex = events.findIndex(
      (event) => event.kind === "submit" && event.resourceId === "runtime-prerequisite",
    );
    const gatedFactoryIndex = events.findIndex(
      (event, index) =>
        index > prerequisiteSubmitIndex &&
        event.kind === "read" &&
        event.address === CREATE2_FACTORY_V1_ADDRESS,
    );
    const gatedPrerequisiteIndex = events.findIndex(
      (event, index) =>
        index > gatedFactoryIndex && event.kind === "read" && event.address === prerequisiteAddress,
    );
    expect(prerequisiteSubmitIndex).toBeGreaterThanOrEqual(0);
    expect(gatedFactoryIndex).toBeGreaterThan(prerequisiteSubmitIndex);
    expect(gatedPrerequisiteIndex).toBeGreaterThan(gatedFactoryIndex);
    expect(
      events.some((event) => event.kind === "submit" && event.resourceId === "runtime-dependent"),
    ).toBe(false);
    const gatedFactory = events[gatedFactoryIndex];
    const gatedPrerequisite = events[gatedPrerequisiteIndex];
    expect(gatedFactory?.kind).toBe("read");
    expect(gatedPrerequisite?.kind).toBe("read");
    if (gatedFactory?.kind !== "read" || gatedPrerequisite?.kind !== "read") {
      throw new Error("runtime gate reads were not recorded");
    }
    expect(gatedPrerequisite.snapshot).toBe(gatedFactory.snapshot);

    await rpc(rpcUrl, "anvil_setCode", [prerequisiteAddress, configurable.runtimeCode]);
    await rpc(rpcUrl, "evm_mine", []);
    events.length = 0;
    const resumed = await createMoesi({ observer, runStore: store }).resume({
      runId: run.runId,
      provider,
    });
    const converged = await resumed.wait();

    expect(converged.status).toBe("converged");
    expect(converged.chains[0]?.execution).toMatchObject({
      kind: "finalized",
      steps: [{ stepId: "runtime-prerequisite:deploy" }, { stepId: "runtime-dependent:deploy" }],
    });
    expect(await publicClient.getCode({ address: prerequisiteAddress })).toBe(
      configurable.runtimeCode,
    );
    expect(await publicClient.getCode({ address: dependentAddress })).toBe(
      configurable.runtimeCode,
    );
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
      nonceBefore + 2,
    );
    const resumedFactoryIndex = events.findIndex(
      (event) => event.kind === "read" && event.address === CREATE2_FACTORY_V1_ADDRESS,
    );
    const resumedPrerequisiteIndex = events.findIndex(
      (event, index) =>
        index > resumedFactoryIndex &&
        event.kind === "read" &&
        event.address === prerequisiteAddress,
    );
    const dependentSubmitIndex = events.findIndex(
      (event) => event.kind === "submit" && event.resourceId === "runtime-dependent",
    );
    expect(resumedFactoryIndex).toBeGreaterThanOrEqual(0);
    expect(resumedPrerequisiteIndex).toBeGreaterThan(resumedFactoryIndex);
    expect(dependentSubmitIndex).toBeGreaterThan(resumedPrerequisiteIndex);
    const resumedFactory = events[resumedFactoryIndex];
    const resumedPrerequisite = events[resumedPrerequisiteIndex];
    if (resumedFactory?.kind !== "read" || resumedPrerequisite?.kind !== "read") {
      throw new Error("resumed runtime gate reads were not recorded");
    }
    expect(resumedPrerequisite.snapshot).toBe(resumedFactory.snapshot);
  }, 30_000);

  it("discovers and verifies proxy, owner and role semantics without repair authority", async () => {
    const fixture = await compile("DiscoveryProbe.sol", "DiscoveryProbe");
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: await walletClient.deployContract({ abi: [], bytecode: fixture.initCode }),
    });
    const address = receipt.contractAddress;
    if (!address) throw new Error("fixture deployment failed");
    const reader = createViemObservationAdapter({ publicClientForChain: () => publicClient });
    const calls: CallReadRequest[] = [];
    const client = createMoesi({
      observer: {
        ...reader,
        async readCall(input) {
          calls.push(input);
          return reader.readCall(input);
        },
      },
      runStore: new MemoryDeploymentRunStore(),
    });
    const request = {
      chains: [CHAIN_ID],
      resources: [
        {
          address,
          caller: account.address,
          erc1967: true,
          ownable: true,
          roles: [{ role: padHex("0x01", { size: 32 }), account: account.address }],
        },
      ],
    };
    const nonce = await publicClient.getTransactionCount({ address: account.address });
    const discovered = await client.discover(request);
    const observed = discovered.chains[0];
    if (observed?.kind !== "observed") throw new Error("chain was not observed");
    const resource = observed.resources[0];
    if (resource?.kind !== "deployed") throw new Error("resource was not observed");
    expect(resource.runtimeCodeHash).toBe(keccak256(fixture.runtimeCode));
    expect(resource.owner).toEqual({ kind: "readable", value: account.address.toLowerCase() });
    expect(resource.roles[0]?.member).toEqual({ kind: "readable", value: true });
    expect(resource.roles[0]?.adminRole).toEqual({
      kind: "readable",
      value: padHex("0x00", { size: 32 }),
    });
    expect(resource.erc1967?.target).toEqual({
      kind: "implementation",
      address: `0x${"cc".repeat(20)}`,
    });
    expect(resource.erc1967?.admin).toEqual({
      kind: "readable",
      value: account.address.toLowerCase(),
    });
    expect(
      calls.every(
        (call) =>
          call.snapshot.blockHash === observed.snapshot.blockHash &&
          call.caller === account.address.toLowerCase(),
      ),
    ).toBe(true);
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonce);

    const semanticChecks: readonly SemanticCheck[] = [
      {
        kind: "ownable-owner",
        id: "owner",
        caller: account.address,
        expectedOwner: account.address,
      },
      {
        kind: "access-control-role",
        id: "role",
        caller: account.address,
        role: padHex("0x01", { size: 32 }),
        account: account.address,
        expectedMember: true,
        expectedAdminRole: padHex("0x00", { size: 32 }),
      },
      {
        kind: "erc1967-direct",
        id: "proxy",
        expectedImplementation: `0x${"cc".repeat(20)}`,
        expectedAdmin: account.address,
      },
    ];
    const semanticManifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "external",
          id: "probe",
          address,
          expectedRuntimeCodeHash: keccak256(fixture.runtimeCode),
          checks: [],
          storageChecks: [],
          semanticChecks,
        },
      ],
    };
    const semanticPlan = await client.plan({ manifest: semanticManifest, chains: [CHAIN_ID] });
    expect(semanticPlan.disposition).toBe("converged");
    expect((await client.verify({ plan: semanticPlan })).status).toBe("converged");
    expect(semanticPlan.requirements).toEqual([]);

    const beaconMode = [
      {
        type: "function",
        name: "beaconMode",
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
      },
    ] as const;
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address,
        abi: beaconMode,
        functionName: "beaconMode",
      }),
    });
    const beaconResult = await client.discover(request);
    const beaconChain = beaconResult.chains[0];
    if (beaconChain?.kind !== "observed") throw new Error("chain was not observed");
    expect(beaconChain.resources[0]).toMatchObject({
      erc1967: {
        target: {
          kind: "beacon",
          address: address.toLowerCase(),
          implementation: { kind: "readable", value: `0x${"cc".repeat(20)}` },
        },
      },
    });
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonce + 1);
    expect((await client.verify({ plan: semanticPlan })).status).toBe("drifted");
    const drift = await client.plan({ manifest: semanticManifest, chains: [CHAIN_ID] });
    expect(drift.disposition).toBe("blocked");
    expect(drift.steps).toEqual([]);
    const beaconManifest: MoesiManifest = {
      ...semanticManifest,
      contracts: [
        {
          ...semanticManifest.contracts[0]!,
          semanticChecks: [
            ...semanticChecks.slice(0, 2),
            {
              kind: "erc1967-beacon",
              id: "proxy",
              caller: account.address,
              expectedBeacon: address,
              expectedImplementation: `0x${"cc".repeat(20)}`,
              expectedAdmin: account.address,
            },
          ],
        },
      ],
    };
    const beaconPlan = await client.plan({ manifest: beaconManifest, chains: [CHAIN_ID] });
    expect(beaconPlan.disposition).toBe("converged");
    expect((await client.verify({ plan: beaconPlan })).status).toBe("converged");
    const provider = createViemExecutionProvider({
      publicClientForChain: () => publicClient,
      walletClientForChain: () => walletClient,
      confirmations: 1,
    });
    const executionReview = await client.reviewExecution({ plan: beaconPlan, provider });
    const ownerChange = [
      {
        type: "function",
        name: "changeOwner",
        stateMutability: "nonpayable",
        inputs: [{ type: "address", name: "next" }],
        outputs: [],
      },
    ] as const;
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address,
        abi: ownerChange,
        functionName: "changeOwner",
        args: [WRONG_ACCOUNT_ADDRESS],
      }),
    });
    const changed = await client.verify({ plan: beaconPlan });
    expect(changed.status).toBe("drifted");
    expect(
      changed.chains[0]?.cells[0]?.callChecks
        .filter(({ status }) => status.kind === "drifted")
        .map(({ kind }) => kind),
    ).toEqual(["ownable-owner", "access-control-member"]);
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonce + 2);
    const run = client.apply({ plan: beaconPlan, provider, executionReview });
    const result = await run.wait();
    expect(result.status).toBe("failed");
    expect(result.chains[0]?.status).toBe("drifted");
    expect(
      result.chains[0]?.cells[0]?.callChecks
        .filter(({ status }) => status.kind === "drifted")
        .map(({ kind }) => kind),
    ).toEqual(["ownable-owner", "access-control-member"]);
    expect(await publicClient.getTransactionCount({ address: account.address })).toBe(nonce + 2);
  }, 30_000);

  it("deploys a 143-row route matrix and repairs only two drifted rows in one batch", async () => {
    const routeBook = await compile("RouteBook.sol", "RouteBook");
    const abi = parseAbi([
      "function setTargetTokens(uint256[] chains, address[] sources, address[] targets, uint8[] decimals)",
      "function checkTargetToken(uint256 chain, address source, address target) view returns (uint8)",
      "function writes() view returns (uint256)",
      "function rowsWritten() view returns (uint256)",
    ]);
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Route fixture",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const provider = createViemExecutionProvider({
      publicClientForChain: () => publicClient,
      walletClientForChain: () => walletClient,
      confirmations: 1,
    });
    const observer = createViemObservationAdapter({ publicClientForChain: () => publicClient });
    const client = createMoesi({ observer, runStore: new MemoryDeploymentRunStore() });
    const source = "0x1111111111111111111111111111111111111111";
    const target = "0x2222222222222222222222222222222222222222";
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "routes",
          deployment: {
            kind: "create2-factory-v1",
            salt: `0x${"75".repeat(32)}`,
            initCode: routeBook.initCode,
            value: "0",
            requiresRuntime: [],
          },
          expectedRuntimeCodeHash: keccak256(routeBook.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: Array.from({ length: 143 }, (_, i) => ({
            id: `route-${i}`,
            readData: encodeFunctionData({
              abi,
              functionName: "checkTargetToken",
              args: [BigInt(i + 1), source, target],
            }),
            expectedResult: encodeAbiParameters([{ type: "uint8" }], [6]),
            writeData: encodeFunctionData({
              abi,
              functionName: "setTargetTokens",
              args: [[BigInt(i + 1)], [source], [target], [6]],
            }),
            value: "0",
            batch: {
              key: "routes",
              parameters: ["uint256[]", "address[]", "address[]", "uint8[]"],
              maxRows: 64,
            },
          })),
        },
      ],
    };
    const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.steps.map((step) => step.configurationIds.length)).toEqual([0, 64, 64, 15]);
    const executionReview = await client.reviewExecution({ plan, provider });
    expect((await client.apply({ plan, provider, executionReview }).wait()).status).toBe(
      "converged",
    );
    const address = plan.cells[0]!.address;
    expect(await publicClient.readContract({ address, abi, functionName: "writes" })).toBe(3n);
    expect(await publicClient.readContract({ address, abi, functionName: "rowsWritten" })).toBe(
      143n,
    );
    const mutation = await walletClient.writeContract({
      address,
      abi,
      functionName: "setTargetTokens",
      args: [
        [3n, 143n],
        [source, source],
        [target, target],
        [18, 18],
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash: mutation });
    const repair = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(repair.steps.map((step) => step.configurationIds)).toEqual([["route-2", "route-142"]]);
    expect(decodeFunctionData({ abi, data: repair.steps[0]!.call.data }).args).toEqual([
      [3n, 143n],
      [source, source],
      [target, target],
      [6, 6],
    ]);
    const repairReview = await client.reviewExecution({ plan: repair, provider });
    expect(
      (await client.apply({ plan: repair, provider, executionReview: repairReview }).wait()).status,
    ).toBe("converged");
    expect(await publicClient.readContract({ address, abi, functionName: "writes" })).toBe(5n);
    expect(await publicClient.readContract({ address, abi, functionName: "rowsWritten" })).toBe(
      147n,
    );
    expect((await client.verify({ plan: repair })).status).toBe("converged");
    expect((await client.plan({ manifest, chains: [CHAIN_ID] })).steps).toEqual([]);
  }, 30_000);

  it("executes ABI-typed fleet struct-array fee batches and repairs just the changed asset", async () => {
    const artifact = await compile("RouteBook.sol", "RouteBook");
    const abi = parseAbi([
      "function setAssetFeeConfigs(address[] assets, (uint256 threshold,uint16 belowBps,uint16 aboveOrEqualBps,bool isSet)[] fees)",
      "function assetFeeConfigs(address) view returns ((uint256 threshold,uint16 belowBps,uint16 aboveOrEqualBps,bool isSet))",
    ]);
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Fleet fixture",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    const provider = createViemExecutionProvider({
      publicClientForChain: () => publicClient,
      walletClientForChain: () => walletClient,
      confirmations: 1,
    });
    const observer = createViemObservationAdapter({ publicClientForChain: () => publicClient });
    const client = createMoesi({ observer, runStore: new MemoryDeploymentRunStore() });
    const assets = [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    ] as const;
    const fee = {
      threshold: 1_000_000_000_000_000_000n,
      belowBps: 25,
      aboveOrEqualBps: 50,
      isSet: true,
    };
    const [group] = await defineFleet({
      chains: [CHAIN_ID],
      contracts: {
        Fees: {
          abi,
          resource: {
            kind: "managed",
            deployment: {
              kind: "create2-factory-v1",
              salt: `0x${"76".repeat(32)}`,
              initCode: artifact.initCode,
              value: "0",
              requiresRuntime: [],
            },
            expectedRuntimeCodeHash: keccak256(artifact.runtimeCode),
          },
        },
      },
      configure(_chain, ctx) {
        return {
          Fees: assets.map((asset, i) =>
            ctx.contract("Fees").rule({
              id: `fee-${i}`,
              read: { functionName: "assetFeeConfigs", args: [asset] },
              expect: fee,
              write: { functionName: "setAssetFeeConfigs", args: [[asset], [fee]] },
              batch: { key: "fees" },
            }),
          ),
        };
      },
    }).compile();
    const plan = await client.plan(group!);
    expect(plan.steps.map((step) => step.configurationIds)).toEqual([[], ["fee-0", "fee-1"]]);
    const executionReview = await client.reviewExecution({ plan, provider });
    expect((await client.apply({ plan, provider, executionReview }).wait()).status).toBe(
      "converged",
    );
    const address = plan.cells[0]!.address;
    expect(
      await publicClient.readContract({
        abi,
        address,
        functionName: "assetFeeConfigs",
        args: [assets[0]],
      }),
    ).toEqual(fee);
    const changed = await walletClient.writeContract({
      abi,
      address,
      functionName: "setAssetFeeConfigs",
      args: [[assets[1]], [{ ...fee, threshold: 7n }]],
    });
    await publicClient.waitForTransactionReceipt({ hash: changed });
    const repair = await client.plan(group!);
    expect(repair.steps.map((step) => step.configurationIds)).toEqual([["fee-1"]]);
    const accepted = await client.reviewExecution({ plan: repair, provider });
    expect(
      (await client.apply({ plan: repair, provider, executionReview: accepted }).wait()).status,
    ).toBe("converged");
    expect((await client.plan(group!)).steps).toEqual([]);
  }, 30_000);

  it("blocks before submission when the reviewed factory runtime changes", async () => {
    const chain = defineChain({
      id: CHAIN_ID,
      name: "Moesi local Anvil",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(ANVIL_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    const observer = createViemObservationAdapter({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
    });
    const provider = createViemExecutionProvider({
      publicClientForChain: (chainId) => (chainId === CHAIN_ID ? publicClient : undefined),
      walletClientForChain: (chainId) => (chainId === CHAIN_ID ? walletClient : undefined),
      confirmations: 1,
    });
    const store = new MemoryDeploymentRunStore();
    const client = createMoesi({ observer, runStore: store });
    const manifest: MoesiManifest = {
      version: "moesi.manifest/v6",
      contracts: [
        {
          kind: "managed",
          id: "factory-gated",
          deployment: {
            kind: "create2-factory-v1",
            requiresRuntime: [],
            salt: MISMATCH_SALT,
            initCode: configurable.initCode,
            value: "0",
          },
          expectedRuntimeCodeHash: keccak256(configurable.runtimeCode),
          checks: [],
          storageChecks: [],
          configuration: [],
          sender: { kind: "owner-eoa", address: account.address },
        },
      ],
    };
    const plan = await client.plan({ manifest, chains: [CHAIN_ID] });
    expect(plan.capabilities[0]?.status.kind).toBe("available");
    const executionReview = await client.reviewExecution({ plan, provider });
    expect(executionReview.provider.status).toBe("supported");
    const nonceBefore = await publicClient.getTransactionCount({ address: account.address });

    await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, "0x6001"]);
    try {
      const run = client.apply({ plan, provider, executionReview });
      const result = await run.wait();

      expect(result.chains[0]?.execution).toMatchObject({
        kind: "failed",
        reason: "deployment-capability-mismatch",
        steps: [],
      });
      expect(run.state).toBe("recovery-required");
      expect(await publicClient.getTransactionCount({ address: account.address })).toBe(
        nonceBefore,
      );
      expect(parseDeploymentRunRecord(await store.get(run.runId)).steps).toMatchObject([
        { stepId: "factory-gated:deploy", phase: "pending" },
      ]);
    } finally {
      await rpc(rpcUrl, "anvil_setCode", [CREATE2_FACTORY_V1_ADDRESS, CREATE2_FACTORY_RUNTIME]);
    }
  }, 30_000);
});

async function compile(fileName: string, contractName: string): Promise<CompiledContract> {
  const source = await readFile(new URL(`./fixtures/${fileName}`, import.meta.url), "utf8");
  const require = createRequire(import.meta.url);
  const solc = require("solc") as { readonly compile: (input: string) => string };
  const output = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [fileName]: { content: source } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          outputSelection: {
            "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] },
          },
        },
      }),
    ),
  ) as SolcOutput;
  const artifact = output.contracts?.[fileName]?.[contractName];
  const initCode = artifact?.evm?.bytecode?.object;
  const runtimeCode = artifact?.evm?.deployedBytecode?.object;
  if (typeof initCode !== "string" || typeof runtimeCode !== "string") {
    throw new Error(`solc did not produce ${contractName}`);
  }
  return { initCode: `0x${initCode}`, runtimeCode: `0x${runtimeCode}` };
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const value = server.address();
  if (typeof value !== "object" || value === null) throw new Error("failed to reserve a port");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value.port;
}

async function waitForRpc(url: string, child: ChildProcessWithoutNullStreams): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error("Anvil exited before becoming ready");
    try {
      await rpc(url, "eth_chainId", []);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Anvil did not become ready");
}

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const value = (await response.json()) as { result?: unknown; error?: unknown };
  if (!response.ok || value.error !== undefined) throw new Error("local RPC request failed");
  return value.result;
}

interface SolcOutput {
  readonly contracts?: Record<
    string,
    Record<
      string,
      {
        readonly evm?: {
          readonly bytecode?: { readonly object?: unknown };
          readonly deployedBytecode?: { readonly object?: unknown };
        };
      }
    >
  >;
}
