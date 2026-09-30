import { type Address, type Hex, keccak256 } from "viem";
import { MoesiExecutionError } from "../errors.js";
import { type ExecutionPacking, parseExecutionPacking } from "../execution/operations.js";
import type { PreparedProviderExecution } from "../execution/prepared.js";
import type { MoesiExecutionProvider } from "../execution/provider.js";
import type {
  FinalizedProviderEvidence,
  ProviderExecutionEvidence,
  ProviderExecutionReference,
  ReviewedPlanOperation,
} from "../execution/reference.js";
import type {
  ExecutionProviderChainReview,
  ExecutionProviderReason,
  ExecutionProviderReview,
} from "../execution/review.js";
import { deepFreeze, hashCanonical } from "../internal.js";
import type { MoesiObservationAdapter } from "../observation/types.js";
import {
  decodeMulticall3Aggregate,
  encodeMulticall3Aggregate,
  MULTICALL3_ADDRESS,
  MULTICALL3_RUNTIME_CODE_HASH,
} from "../planning/multicall3.js";
import type { DeploymentCall, ExecutionRequirements, ReviewedPlan } from "../planning/types.js";
import { checkCanonicalAncestry } from "./canonical-ancestry.js";

export const MOESI_VIEM_PROVIDER_ID = "viem" as const;
export const MOESI_VIEM_PROVIDER_ROUTE = "viem-direct-eoa" as const;
/** Per-chain packing route: one EOA transaction into Multicall3 `aggregate`. */
export const MOESI_VIEM_MULTICALL3_ROUTE = "viem-eoa-multicall3" as const;

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const VIEM_REFERENCE_PATTERN =
  /^viem-(tx|multicall3)-v1:(0x[0-9a-fA-F]{64}):confirmations-([1-9][0-9]?)$/;
const QUANTITY_PATTERN = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;
const MAX_CONFIRMATIONS = 64;

/**
 * The minimal wallet surface the direct provider needs. Any viem
 * `WalletClient` satisfies it structurally. The provider sends exactly one
 * ordinary transaction per reviewed action, or per chain operation through
 * Multicall3 when per-chain packing was reviewed, and never replaces or
 * reprices it.
 */
export interface ViemWalletClientLike {
  readonly account: { readonly address: Address; readonly type: string } | undefined;
  readonly chain: { readonly id: number } | undefined;
  sendTransaction(args: {
    readonly account: { readonly address: Address; readonly type: string };
    readonly chain: { readonly id: number };
    readonly to: Address;
    readonly data: Hex;
    readonly value: bigint;
  }): Promise<Hex>;
}

/**
 * The minimal read surface the direct provider needs. Any viem `PublicClient`
 * satisfies it structurally through its EIP-1193 `request`.
 */
export interface ViemPublicClientLike {
  readonly chain: { readonly id: number } | undefined;
  /** Caller-owned viem `PublicClient.request`; validated before use. */
  readonly request: unknown;
}

export interface CreateViemExecutionProviderInput {
  readonly walletClientForChain: (chainId: number) => ViemWalletClientLike | undefined;
  readonly publicClientForChain: (chainId: number) => ViemPublicClientLike | undefined;
  /** Explicit confirmations required before provider evidence is terminal. */
  readonly confirmations: number;
}

interface ViemChainBinding {
  readonly wallet: ViemWalletClientLike;
  readonly reader: ViemPublicClientLike;
  readonly sender: Address;
  readonly account: { readonly address: Address; readonly type: string };
  readonly chain: { readonly id: number };
  readonly sendTransaction: ViemWalletClientLike["sendTransaction"];
}

interface ViemPreparedBinding {
  readonly chains: ReadonlyMap<number, ViemChainBinding>;
  readonly calls: ReadonlyMap<string, DeploymentCall>;
  readonly confirmations: number;
  readonly packing: ExecutionPacking;
}

/**
 * The built-in direct viem execution provider. It executes reviewed calls as
 * ordinary EOA transactions through caller-owned wallet clients. It is not an
 * account-abstraction emulation: it blocks before signing when a plan requires
 * a smart-account sender, a different exact sender, or onchain enforcement it
 * cannot provide, and its review always shows the actual enforcement level.
 *
 * Per-chain packing sends each chain's steps as one Multicall3 `aggregate`
 * transaction. Multicall3 becomes each inner call's `msg.sender`, so review
 * allows it only for sender-independent, value-free chains whose Multicall3
 * runtime is the canonical one; `aggregate` reverts every call if one fails.
 */
export function createViemExecutionProvider(
  input: CreateViemExecutionProviderInput,
): MoesiExecutionProvider {
  const confirmations = parseConfirmations(input.confirmations);

  async function review({
    plan,
    packing,
  }: {
    readonly plan: ReviewedPlan;
    readonly packing: ExecutionPacking;
  }): Promise<ExecutionProviderReview> {
    const reasons: ExecutionProviderReason[] = [];
    const parsedPacking = parseExecutionPacking(packing);
    const chains: ExecutionProviderChainReview[] = [];
    for (const requirements of plan.requirements) {
      chains.push(
        await reviewChainRequirements(input, requirements, reasons, confirmations, parsedPacking),
      );
    }
    return deepFreeze({
      providerId: MOESI_VIEM_PROVIDER_ID,
      status: reasons.length === 0 ? ("supported" as const) : ("blocked" as const),
      chains,
      reasons,
    });
  }

  async function prepare({
    plan,
    review: acceptedReview,
    packing,
  }: {
    readonly plan: ReviewedPlan;
    readonly review: ExecutionProviderReview;
    readonly packing: ExecutionPacking;
  }): Promise<PreparedProviderExecution> {
    if (acceptedReview.providerId !== MOESI_VIEM_PROVIDER_ID) {
      throw new MoesiExecutionError(
        "provider_mismatch",
        "the execution review does not belong to the viem provider",
      );
    }
    if (acceptedReview.status !== "supported") {
      throw new MoesiExecutionError(
        "provider_review_blocked",
        "the viem execution review is blocked",
      );
    }
    const currentReview = await review({ plan, packing });
    if (
      currentReview.status !== "supported" ||
      !sameSupportedReview(acceptedReview, currentReview)
    ) {
      throw new MoesiExecutionError(
        "provider_prepare_failed",
        "the plan or viem provider binding changed since execution review",
      );
    }
    const chains = new Map<number, ViemChainBinding>();
    for (const requirements of plan.requirements) {
      const wallet = input.walletClientForChain(requirements.chainId);
      const reader = input.publicClientForChain(requirements.chainId);
      const account = wallet?.account;
      const walletChain = wallet?.chain;
      const sender = account?.address?.toLowerCase() as Address | undefined;
      if (
        !wallet ||
        !reader ||
        !account ||
        !walletChain ||
        !isEoaAccount(account) ||
        !sender ||
        walletChain?.id !== requirements.chainId ||
        reader.chain?.id !== requirements.chainId ||
        typeof reader.request !== "function" ||
        typeof wallet.sendTransaction !== "function"
      ) {
        throw new MoesiExecutionError(
          "provider_prepare_failed",
          `wallet or observer for chain ${requirements.chainId} is unavailable or contradictory`,
        );
      }
      const acceptedChain = acceptedReview.chains.find(
        (candidate) => candidate.chainId === requirements.chainId,
      );
      if (!acceptedChain || acceptedChain.sender === null || sender !== acceptedChain.sender) {
        throw new MoesiExecutionError(
          "provider_prepare_failed",
          "wallet sender changed since the execution review",
        );
      }
      chains.set(requirements.chainId, {
        wallet,
        reader,
        sender,
        account,
        chain: walletChain,
        sendTransaction: wallet.sendTransaction,
      });
    }
    const calls = new Map<string, DeploymentCall>(
      plan.steps.map((step) => [`${step.chainId}:${step.id}`, step.call]),
    );
    return deepFreeze({
      providerId: MOESI_VIEM_PROVIDER_ID,
      planId: plan.planId,
      binding: {
        chains,
        calls,
        confirmations,
        packing: parseExecutionPacking(packing),
      } satisfies ViemPreparedBinding,
    });
  }

  async function submit({
    prepared,
    action,
  }: {
    readonly prepared: PreparedProviderExecution;
    readonly action: {
      readonly planId: Hex;
      readonly chainId: number;
      readonly step: ReviewedPlan["steps"][number];
    };
  }): Promise<ProviderExecutionReference> {
    const binding = parsePreparedBinding(prepared);
    if (action.planId !== prepared.planId) {
      throw new MoesiExecutionError(
        "plan_mismatch",
        "the submitted action does not belong to the prepared plan",
      );
    }
    const expected = binding.calls.get(`${action.chainId}:${action.step.id}`);
    if (
      !expected ||
      expected.target !== action.step.call.target ||
      expected.data !== action.step.call.data ||
      expected.value !== action.step.call.value
    ) {
      throw new MoesiExecutionError(
        "invalid_action",
        "the submitted action does not match the prepared reviewed call",
      );
    }
    if (binding.packing !== "per-step") {
      throw new MoesiExecutionError(
        "invalid_action",
        "per-chain packing submits operations, not single actions",
      );
    }
    const chain = requireChainBinding(binding, action.chainId);
    const hash = await sendReviewedTransaction(chain, action.step.call);
    return Object.freeze({
      providerId: MOESI_VIEM_PROVIDER_ID,
      chainId: action.chainId,
      reference: encodeViemReference("tx", hash, binding.confirmations),
    });
  }

  async function submitBatch({
    prepared,
    operation,
  }: {
    readonly prepared: PreparedProviderExecution;
    readonly operation: ReviewedPlanOperation;
  }): Promise<ProviderExecutionReference> {
    const binding = parsePreparedBinding(prepared);
    if (operation.planId !== prepared.planId) {
      throw new MoesiExecutionError(
        "plan_mismatch",
        "the submitted operation does not belong to the prepared plan",
      );
    }
    if (binding.packing !== "per-chain" || operation.steps.length === 0) {
      throw new MoesiExecutionError(
        "invalid_action",
        "the operation does not match the prepared per-chain packing",
      );
    }
    for (const step of operation.steps) {
      const expected = binding.calls.get(`${operation.chainId}:${step.id}`);
      if (
        step.chainId !== operation.chainId ||
        step.sender !== null ||
        !expected ||
        expected.target !== step.call.target ||
        expected.data !== step.call.data ||
        expected.value !== step.call.value
      ) {
        throw new MoesiExecutionError(
          "invalid_action",
          "the submitted operation does not match the prepared reviewed calls",
        );
      }
    }
    const chain = requireChainBinding(binding, operation.chainId);
    // Re-attest the exact Multicall3 runtime immediately before signing.
    if ((await readMulticall3(chain.reader)) !== "canonical") {
      throw new MoesiExecutionError(
        "invalid_action",
        `chain ${operation.chainId} Multicall3 is unavailable or not canonical`,
      );
    }
    const call = encodeMulticall3Aggregate(operation.steps.map((step) => step.call));
    const hash = await sendReviewedTransaction(chain, call);
    return Object.freeze({
      providerId: MOESI_VIEM_PROVIDER_ID,
      chainId: operation.chainId,
      reference: encodeViemReference("multicall3", hash, binding.confirmations),
    });
  }

  async function observe({
    reference,
  }: {
    readonly reference: ProviderExecutionReference;
  }): Promise<ProviderExecutionEvidence> {
    const parsedReference = parseViemReference(reference.reference);
    if (reference.providerId !== MOESI_VIEM_PROVIDER_ID || parsedReference === null) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    const reader = input.publicClientForChain(reference.chainId);
    if (!reader || reader.chain?.id !== reference.chainId) {
      return { status: "unreadable", reason: "observation-unavailable" };
    }
    const rpcChain = await readRpcChain(reader, reference.chainId);
    if (rpcChain === "mismatch") return { status: "unreadable", reason: "invalid-evidence" };
    if (rpcChain === "unreadable") {
      return { status: "unreadable", reason: "observation-unavailable" };
    }
    const { kind, hash, confirmations: referenceConfirmations } = parsedReference;
    let receiptValue: unknown;
    try {
      receiptValue = await requestRpc(reader, {
        method: "eth_getTransactionReceipt",
        params: [hash],
      });
    } catch {
      return { status: "unreadable", reason: "observation-unavailable" };
    }
    if (receiptValue === null) return { status: "pending" };
    const receipt = parseReceipt(receiptValue);
    if (receipt === null || receipt.transactionHash !== hash) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    let transactionValue: unknown;
    let latestValue: unknown;
    let blockValue: unknown;
    try {
      [transactionValue, latestValue, blockValue] = await Promise.all([
        requestRpc(reader, { method: "eth_getTransactionByHash", params: [hash] }),
        requestRpc(reader, { method: "eth_blockNumber" }),
        requestRpc(reader, {
          method: "eth_getBlockByNumber",
          params: [toQuantity(receipt.blockNumber), false],
        }),
      ]);
    } catch {
      return { status: "unreadable", reason: "observation-unavailable" };
    }
    const transaction = parseTransaction(transactionValue);
    const latest = parseQuantity(latestValue);
    if (blockValue === null) return { status: "pending" };
    const block = parseBlock(blockValue);
    if (
      transaction === null ||
      latest === null ||
      block === null ||
      transaction.hash !== hash ||
      transaction.blockNumber !== receipt.blockNumber ||
      transaction.blockHash !== receipt.blockHash ||
      transaction.from !== receipt.from ||
      transaction.to !== receipt.to
    ) {
      return { status: "unreadable", reason: "invalid-evidence" };
    }
    if (block.number !== receipt.blockNumber || block.hash !== receipt.blockHash) {
      return { status: "pending" };
    }
    if (latest < receipt.blockNumber) return { status: "pending" };
    if (latest - receipt.blockNumber + 1n < BigInt(referenceConfirmations)) {
      return { status: "pending" };
    }
    if (receipt.status === "reverted") return { status: "failed", reason: "reverted" };
    let calls: readonly DeploymentCall[];
    if (kind === "multicall3") {
      const inner =
        transaction.to === MULTICALL3_ADDRESS && transaction.value === 0n
          ? decodeMulticall3Aggregate(transaction.data)
          : null;
      if (inner === null) return { status: "unreadable", reason: "invalid-evidence" };
      calls = inner;
    } else {
      calls = [
        { target: transaction.to, data: transaction.data, value: transaction.value.toString(10) },
      ];
    }
    const finalized: FinalizedProviderEvidence = {
      chainId: reference.chainId,
      sender: transaction.from,
      calls,
      providerEvidenceId: hash,
      submissionRoute: kind === "multicall3" ? "multicall3-aggregate" : "transaction",
      blockNumber: receipt.blockNumber.toString(10),
      blockHash: receipt.blockHash,
    };
    return { status: "finalized", finalized: deepFreeze(finalized) };
  }

  return Object.freeze({
    id: MOESI_VIEM_PROVIDER_ID,
    // Multicall3 batching changes msg.sender; callers opt in with per-chain packing.
    defaultPacking: "per-step" as const,
    review,
    prepare,
    submit,
    submitBatch,
    observe,
  });
}

/**
 * A viem-backed observation adapter for read-only plan/review/verify flows.
 * Reads are pinned to the exact captured block hash with `requireCanonical`;
 * there is no retry or block-number fallback.
 */
export function createViemObservationAdapter(input: {
  readonly publicClientForChain: (chainId: number) => ViemPublicClientLike | undefined;
}): MoesiObservationAdapter {
  function requireReader(chainId: number): ViemPublicClientLike {
    const reader = input.publicClientForChain(chainId);
    if (!reader || reader.chain?.id !== chainId) {
      throw new Error(`chain ${chainId} is not configured`);
    }
    return reader;
  }

  return {
    async captureSnapshot(chainId) {
      const reader = requireReader(chainId);
      if ((await readRpcChain(reader, chainId)) !== "match") {
        throw new Error("RPC chain identity is unavailable or contradictory");
      }
      const block = await requestRpc(reader, {
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      });
      const record = asPlainRecord(block);
      const number = record?.number;
      const hash = record?.hash;
      if (typeof number !== "string" || !QUANTITY_PATTERN.test(number)) {
        throw new Error("block number is invalid");
      }
      if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
        throw new Error("block hash is invalid");
      }
      return { blockNumber: BigInt(number).toString(10), blockHash: hash.toLowerCase() as Hex };
    },
    async readCode({ chainId, address, snapshot }) {
      return requestRpc(requireReader(chainId), {
        method: "eth_getCode",
        params: [address, { blockHash: snapshot.blockHash, requireCanonical: true }],
      });
    },
    async readCall({ chainId, target, data, caller, snapshot }) {
      return requestRpc(requireReader(chainId), {
        method: "eth_call",
        params: [
          { from: caller, to: target, data },
          { blockHash: snapshot.blockHash, requireCanonical: true },
        ],
      });
    },
    async readStorage({ chainId, address, slot, snapshot }) {
      return requestRpc(requireReader(chainId), {
        method: "eth_getStorageAt",
        params: [address, slot, { blockHash: snapshot.blockHash, requireCanonical: true }],
      });
    },
    async checkBlockAncestry({ chainId, ancestor, descendant }) {
      const reader = requireReader(chainId);
      if ((await readRpcChain(reader, chainId)) !== "match") {
        throw new Error("RPC chain identity is unavailable or contradictory");
      }
      const matches = await checkCanonicalAncestry(ancestor, descendant, async (height) => {
        const block = parseLinkedBlock(
          await requestRpc(reader, {
            method: "eth_getBlockByNumber",
            params: [`0x${height.toString(16)}`, false],
          }),
        );
        if (block === null || block.number !== height) {
          throw new Error("block ancestry response is invalid");
        }
        return {
          blockNumber: block.number.toString(10),
          blockHash: block.hash,
          parentHash: block.parentHash,
        };
      });
      if (matches && (await readRpcChain(reader, chainId)) !== "match") {
        throw new Error("RPC chain identity is unavailable or contradictory");
      }
      return matches;
    },
  };
}

async function reviewChainRequirements(
  input: CreateViemExecutionProviderInput,
  requirements: ExecutionRequirements,
  reasons: ExecutionProviderReason[],
  confirmations: number,
  packing: ExecutionPacking,
): Promise<ExecutionProviderChainReview> {
  const chainId = requirements.chainId;
  const wallet = input.walletClientForChain(chainId);
  let sender: Address | null = null;
  if (!wallet) {
    reasons.push({ code: "wallet-unavailable", chainId, stepId: null });
  } else {
    sender = (wallet.account?.address?.toLowerCase() as Address | undefined) ?? null;
    if (!sender) {
      reasons.push({ code: "sender-unavailable", chainId, stepId: null });
    }
    if (wallet.chain?.id !== chainId) {
      reasons.push({ code: "chain-mismatch", chainId, stepId: null });
    }
    if (!isEoaAccount(wallet.account)) {
      reasons.push({ code: "unsupported-account", chainId, stepId: null });
    }
    if (typeof wallet.sendTransaction !== "function") {
      reasons.push({ code: "submission-unavailable", chainId, stepId: null });
    }
    const required = requirements.sender;
    if (required.kind === "logical-smart-account") {
      reasons.push({ code: "smart-account-sender-required", chainId, stepId: null });
    } else if (
      (required.kind === "exact" || required.kind === "reviewed-owner-eoa") &&
      sender !== null &&
      required.address !== sender
    ) {
      reasons.push({ code: "sender-mismatch", chainId, stepId: null });
    }
  }
  const reader = input.publicClientForChain(chainId);
  if (!reader || typeof reader.request !== "function") {
    reasons.push({ code: "observer-unavailable", chainId, stepId: null });
  } else if (reader.chain?.id !== chainId) {
    reasons.push({ code: "observer-chain-mismatch", chainId, stepId: null });
  } else {
    const rpcChain = await readRpcChain(reader, chainId);
    if (rpcChain === "mismatch") {
      reasons.push({ code: "observer-chain-mismatch", chainId, stepId: null });
    } else if (rpcChain === "unreadable") {
      reasons.push({ code: "observer-unavailable", chainId, stepId: null });
    } else if (packing === "per-chain") {
      const multicall3 = await readMulticall3(reader);
      if (multicall3 === "unreadable") {
        reasons.push({ code: "observer-unavailable", chainId, stepId: null });
      } else if (multicall3 !== "canonical") {
        reasons.push({ code: "multicall3-unavailable", chainId, stepId: null });
      }
    }
  }
  if (packing === "per-chain") {
    // Multicall3 is the inner msg.sender and aggregate carries no value.
    if (requirements.sender.kind !== "sender-independent") {
      reasons.push({ code: "multicall3-sender-dependent", chainId, stepId: null });
    }
    if (requirements.calls.some(({ value }) => value !== "0")) {
      reasons.push({ code: "multicall3-value-unsupported", chainId, stepId: null });
    }
  }
  if (requirements.enforcement.callScope === "required-onchain") {
    reasons.push({ code: "onchain-call-scope-required", chainId, stepId: null });
  }
  if (requirements.enforcement.expiry === "required") {
    reasons.push({ code: "onchain-expiry-required", chainId, stepId: null });
  }
  if (requirements.enforcement.operationLimit === "required") {
    reasons.push({ code: "onchain-operation-limit-required", chainId, stepId: null });
  }
  return {
    chainId,
    sender,
    accountId: null,
    route: `${packing === "per-chain" ? MOESI_VIEM_MULTICALL3_ROUTE : MOESI_VIEM_PROVIDER_ROUTE}:confirmations-${confirmations}`,
    signer: sender === null ? "unavailable" : "owner",
    signerReason: sender === null ? "wallet-unavailable" : "caller-supplied-eoa",
    fallback: null,
    enforcement: {
      calls: "interactive-owner",
      expiry: "not-enforced",
      operationCount: "not-enforced",
    },
  };
}

function parseConfirmations(value: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_CONFIRMATIONS
  ) {
    throw new MoesiExecutionError(
      "provider_invalid",
      `confirmations must be an integer between 1 and ${MAX_CONFIRMATIONS}`,
    );
  }
  return value;
}

type ViemReferenceKind = "tx" | "multicall3";

function encodeViemReference(kind: ViemReferenceKind, hash: string, confirmations: number): string {
  return `viem-${kind}-v1:${hash.toLowerCase()}:confirmations-${confirmations}`;
}

function parseViemReference(value: string): {
  readonly kind: ViemReferenceKind;
  readonly hash: Hex;
  readonly confirmations: number;
} | null {
  const match = VIEM_REFERENCE_PATTERN.exec(value);
  if (match === null) return null;
  const kind = match[1];
  const hash = match[2];
  const confirmationsText = match[3];
  if (
    (kind !== "tx" && kind !== "multicall3") ||
    hash === undefined ||
    confirmationsText === undefined
  )
    return null;
  const confirmations = Number(confirmationsText);
  if (
    !Number.isSafeInteger(confirmations) ||
    confirmations < 1 ||
    confirmations > MAX_CONFIRMATIONS ||
    String(confirmations) !== confirmationsText
  ) {
    return null;
  }
  return { kind, hash: hash.toLowerCase() as Hex, confirmations };
}

function requireChainBinding(binding: ViemPreparedBinding, chainId: number): ViemChainBinding {
  const chain = binding.chains.get(chainId);
  if (
    !chain ||
    chain.account.address.toLowerCase() !== chain.sender ||
    !isEoaAccount(chain.account) ||
    chain.chain.id !== chainId ||
    chain.wallet.account !== chain.account ||
    chain.wallet.chain !== chain.chain ||
    typeof chain.wallet.sendTransaction !== "function" ||
    chain.wallet.sendTransaction !== chain.sendTransaction
  ) {
    throw new MoesiExecutionError(
      "invalid_action",
      `chain ${chainId} wallet binding changed after preparation`,
    );
  }
  return chain;
}

async function sendReviewedTransaction(
  chain: ViemChainBinding,
  call: DeploymentCall,
): Promise<Hex> {
  const hash: unknown = await Reflect.apply(chain.sendTransaction, chain.wallet, [
    {
      account: chain.account,
      chain: chain.chain,
      to: call.target,
      data: call.data,
      value: BigInt(call.value),
    },
  ]);
  if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) {
    throw new MoesiExecutionError(
      "invalid_action",
      "the wallet returned an invalid transaction reference",
    );
  }
  return hash.toLowerCase() as Hex;
}

/** Latest-state Multicall3 presence; never proof for anything but routing. */
async function readMulticall3(
  reader: ViemPublicClientLike,
): Promise<"canonical" | "absent" | "different" | "unreadable"> {
  let code: unknown;
  try {
    code = await requestRpc(reader, {
      method: "eth_getCode",
      params: [MULTICALL3_ADDRESS, "latest"],
    });
  } catch {
    return "unreadable";
  }
  if (typeof code !== "string" || !HEX_PATTERN.test(code)) return "unreadable";
  if (code === "0x") return "absent";
  return keccak256(code as Hex) === MULTICALL3_RUNTIME_CODE_HASH ? "canonical" : "different";
}

function isEoaAccount(
  account: ViemWalletClientLike["account"],
): account is { readonly address: Address; readonly type: "local" | "json-rpc" } {
  return account?.type === "local" || account?.type === "json-rpc";
}

async function requestRpc(
  client: ViemPublicClientLike,
  input: { readonly method: string; readonly params?: readonly unknown[] },
): Promise<unknown> {
  if (typeof client.request !== "function") throw new Error("public client request is unavailable");
  return Reflect.apply(client.request, client, [input]) as Promise<unknown>;
}

async function readRpcChain(
  client: ViemPublicClientLike,
  expectedChainId: number,
): Promise<"match" | "mismatch" | "unreadable"> {
  try {
    const value = parseQuantity(await requestRpc(client, { method: "eth_chainId" }));
    if (value === null) return "unreadable";
    return value === BigInt(expectedChainId) ? "match" : "mismatch";
  } catch {
    return "unreadable";
  }
}

function sameSupportedReview(
  reviewed: ExecutionProviderReview,
  current: ExecutionProviderReview,
): boolean {
  return (
    reviewed.status === "supported" &&
    current.status === "supported" &&
    hashCanonical(reviewed) === hashCanonical(current)
  );
}

function parsePreparedBinding(input: PreparedProviderExecution): ViemPreparedBinding {
  if (input.providerId !== MOESI_VIEM_PROVIDER_ID) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the prepared execution does not belong to the viem provider",
    );
  }
  const binding = input.binding as ViemPreparedBinding;
  if (
    typeof binding !== "object" ||
    binding === null ||
    !(binding.chains instanceof Map) ||
    !(binding.calls instanceof Map) ||
    typeof binding.confirmations !== "number" ||
    (binding.packing !== "per-step" && binding.packing !== "per-chain")
  ) {
    throw new MoesiExecutionError(
      "provider_mismatch",
      "the prepared viem execution binding is invalid",
    );
  }
  return binding;
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) snapshot[key] = Reflect.get(value, key);
    return snapshot;
  } catch {
    return null;
  }
}

function parseQuantity(value: unknown): bigint | null {
  if (typeof value !== "string" || !QUANTITY_PATTERN.test(value)) return null;
  return BigInt(value);
}

function toQuantity(value: bigint): Hex {
  return `0x${value.toString(16)}`;
}

interface ParsedReceipt {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly status: "success" | "reverted";
}

function parseReceipt(value: unknown): ParsedReceipt | null {
  const record = asPlainRecord(value);
  if (record === null) return null;
  if (typeof record.transactionHash !== "string" || !HASH_PATTERN.test(record.transactionHash)) {
    return null;
  }
  const blockNumber = parseQuantity(record.blockNumber);
  if (blockNumber === null) return null;
  if (typeof record.blockHash !== "string" || !HASH_PATTERN.test(record.blockHash)) return null;
  if (typeof record.from !== "string" || !ADDRESS_PATTERN.test(record.from)) return null;
  if (typeof record.to !== "string" || !ADDRESS_PATTERN.test(record.to)) return null;
  if (record.status !== "0x1" && record.status !== "0x0") return null;
  return {
    transactionHash: record.transactionHash.toLowerCase() as Hex,
    blockNumber,
    blockHash: record.blockHash.toLowerCase() as Hex,
    from: record.from.toLowerCase() as Address,
    to: record.to.toLowerCase() as Address,
    status: record.status === "0x1" ? "success" : "reverted",
  };
}

interface ParsedTransaction {
  readonly hash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly from: Address;
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

function parseTransaction(value: unknown): ParsedTransaction | null {
  const record = asPlainRecord(value);
  if (record === null) return null;
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash)) return null;
  const blockNumber = parseQuantity(record.blockNumber);
  if (blockNumber === null) return null;
  if (typeof record.blockHash !== "string" || !HASH_PATTERN.test(record.blockHash)) return null;
  if (typeof record.from !== "string" || !ADDRESS_PATTERN.test(record.from)) return null;
  if (typeof record.to !== "string" || !ADDRESS_PATTERN.test(record.to)) return null;
  if (typeof record.input !== "string" || !HEX_PATTERN.test(record.input)) return null;
  const parsedValue = parseQuantity(record.value);
  if (parsedValue === null) return null;
  return {
    hash: record.hash.toLowerCase() as Hex,
    blockNumber,
    blockHash: record.blockHash.toLowerCase() as Hex,
    from: record.from.toLowerCase() as Address,
    to: record.to.toLowerCase() as Address,
    data: record.input.toLowerCase() as Hex,
    value: parsedValue,
  };
}

interface ParsedBlock {
  readonly number: bigint;
  readonly hash: Hex;
}

interface ParsedLinkedBlock extends ParsedBlock {
  readonly parentHash: Hex;
}

function parseBlock(value: unknown): ParsedBlock | null {
  const record = asPlainRecord(value);
  return record === null ? null : parseBlockRecord(record);
}

function parseBlockRecord(record: Record<string, unknown>): ParsedBlock | null {
  const number = parseQuantity(record.number);
  if (number === null) return null;
  if (typeof record.hash !== "string" || !HASH_PATTERN.test(record.hash)) return null;
  return { number, hash: record.hash.toLowerCase() as Hex };
}

function parseLinkedBlock(value: unknown): ParsedLinkedBlock | null {
  const record = asPlainRecord(value);
  const block = record === null ? null : parseBlockRecord(record);
  if (
    block === null ||
    record === null ||
    typeof record.parentHash !== "string" ||
    !HASH_PATTERN.test(record.parentHash)
  ) {
    return null;
  }
  return { ...block, parentHash: record.parentHash.toLowerCase() as Hex };
}
