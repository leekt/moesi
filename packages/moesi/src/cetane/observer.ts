import { type Hex, http } from "cetane";
import { httpBatch } from "cetane/transports/httpBatch";
import {
  MoesiObservationError,
  OBSERVATION_FAILURE_CATEGORIES,
  type ObservationAttempt,
  type ObservationFailureCategory,
  withObservationAbort,
} from "../observation/failure.js";
import type { MoesiObservationAdapter, SnapshotReference } from "../observation/types.js";
import { checkCanonicalAncestry } from "./canonical-ancestry.js";
import { ObservationHttpError, observationFetch } from "./observation-http.js";
import { type RpcEndpoint, rpcEndpoint } from "./rpc-endpoint.js";

export type CetaneObserverPin = "latest" | "safe" | "finalized" | { readonly lagBlocks: number };
export interface CreateCetaneObserverInput {
  /** Optional caller-owned fetch implementation; useful for browser integration and tests. */
  readonly fetchFn?: typeof fetch;
  readonly chains: Readonly<
    Record<number, { readonly rpcUrls: readonly string[]; readonly pin?: CetaneObserverPin }>
  >;
  readonly retry?: {
    readonly attempts?: number;
    readonly on?: readonly ObservationFailureCategory[];
    /** Shared endpoint cooldown after throttling; doubles per attempt up to five seconds. */
    readonly rateLimitDelayMs?: number;
  };
  readonly timeoutMs?: number;
  /** Maximum active reads across chains. Defaults to eight. */
  readonly concurrency?: number;
  /** Batch JSON-RPC reads while preserving each call's exact caller and block hash. */
  readonly batch?: boolean;
}

type RpcInput = { readonly method: string; readonly params?: readonly unknown[] };
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const RETRY: readonly ObservationFailureCategory[] = [
  "transport",
  "http-5xx",
  "non-json",
  "rate-limited",
  "state-unavailable",
  "timeout",
  "chain-mismatch",
  "invalid-response",
];

function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new MoesiObservationError("invalid_observer_configuration");
  return value;
}

function captureConfiguration(value: unknown): CreateCetaneObserverInput {
  function record(value: unknown, allowed?: readonly string[]): Record<string, unknown> {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      throw new Error("invalid_configuration");
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" ||
        !("value" in descriptor) ||
        (allowed && !allowed.includes(key))
      )
        throw new Error("invalid_configuration");
      output[key] = descriptor.value;
    }
    return output;
  }
  function array(value: unknown, max: number): unknown[] {
    if (!Array.isArray(value) || value.length > max) throw new Error("invalid_configuration");
    const output = [];
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      if (!descriptor || !("value" in descriptor)) throw new Error("invalid_configuration");
      output.push(descriptor.value);
    }
    return output;
  }
  const input = record(value, ["chains", "retry", "timeoutMs", "concurrency", "batch", "fetchFn"]);
  if (input.fetchFn !== undefined && typeof input.fetchFn !== "function")
    throw new Error("invalid_configuration");
  if (input.batch !== undefined && typeof input.batch !== "boolean")
    throw new Error("invalid_configuration");
  const chainEntries = Object.entries(record(input.chains));
  if (chainEntries.length > 256) throw new Error("invalid_configuration");
  const chains = Object.fromEntries(
    chainEntries.map(([chainId, value]) => {
      const config = record(value, ["rpcUrls", "pin"]);
      const rpcUrls = array(config.rpcUrls, 32).map((url) => {
        if (typeof url !== "string" || url.length > 16_384)
          throw new Error("invalid_configuration");
        return url;
      });
      const pin =
        config.pin === undefined || ["latest", "safe", "finalized"].includes(config.pin as string)
          ? (config.pin ?? "latest")
          : record(config.pin, ["lagBlocks"]);
      return [chainId, { rpcUrls, pin }];
    }),
  );
  const retry =
    input.retry === undefined ? {} : record(input.retry, ["attempts", "on", "rateLimitDelayMs"]);
  if (retry.on !== undefined) retry.on = array(retry.on, OBSERVATION_FAILURE_CATEGORIES.length);
  return { ...input, chains, retry } as unknown as CreateCetaneObserverInput;
}

/** Classify only bounded scalar facts; never retain the original error or its text. */
function classify(error: unknown, endpoint: number): ObservationAttempt {
  let category: ObservationFailureCategory = "unknown";
  let rpcCode: number | null = null;
  let httpStatus: number | null = null;
  const seen = new Set<object>();
  for (
    let depth = 0;
    typeof error === "object" && error !== null && depth < 8 && !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const own = (key: string) => Object.getOwnPropertyDescriptor(error, key)?.value as unknown;
    const name = own("name");
    const code = own("code");
    const status = own("status");
    const detail = own("details") ?? own("message");
    const message = typeof detail === "string" ? detail.slice(0, 4096).toLowerCase() : "";
    if (typeof code === "number" && Number.isSafeInteger(code)) rpcCode = code;
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
      httpStatus = status;
    if (name === "TransportError" || error instanceof TypeError) category = "transport";
    if (name === "TimeoutError") category = "timeout";
    if (error instanceof SyntaxError) category = "non-json";
    if (error instanceof ObservationHttpError) category = error.category;
    if (rpcCode !== null && category === "unknown") category = "rpc-error";
    if (
      /missing trie|historical state|state.*(unavailable|not available)|archive.*(request|require)|header not found|block not found/.test(
        message,
      ) ||
      code === -32603
    )
      category = "state-unavailable";
    if (
      /rate.?limit|usage limit|request limit reached|too many requests/.test(message) ||
      code === -32005
    )
      category = "rate-limited";
    if (code === 3 || /execution reverted/.test(message)) category = "reverted";
    error = own("cause");
  }
  if (httpStatus === 429) category = "rate-limited";
  else if (httpStatus !== null && httpStatus >= 500) category = "http-5xx";
  else if (httpStatus !== null && httpStatus >= 400) category = "http-error";
  return { endpoint, category, rpcCode, httpStatus };
}

function block(value: unknown): SnapshotReference & { readonly parentHash: Hex | null } {
  if (typeof value !== "object" || value === null)
    throw new MoesiObservationError("observation_failed");
  const record = value as Record<string, unknown>;
  if (
    typeof record.number !== "string" ||
    !QUANTITY.test(record.number) ||
    typeof record.hash !== "string" ||
    !HASH.test(record.hash)
  )
    throw new MoesiObservationError("observation_failed");
  return {
    blockNumber: BigInt(record.number).toString(),
    blockHash: record.hash.toLowerCase() as Hex,
    parentHash:
      typeof record.parentHash === "string" && HASH.test(record.parentHash)
        ? (record.parentHash.toLowerCase() as Hex)
        : null,
  };
}

/** URL-only read pool. All retries keep the requested canonical block hash. */
export function createCetaneObserver(input: CreateCetaneObserverInput): MoesiObservationAdapter {
  try {
    return buildObserver(captureConfiguration(input));
  } catch {
    throw new MoesiObservationError("invalid_observer_configuration");
  }
}

function buildObserver(input: CreateCetaneObserverInput): MoesiObservationAdapter {
  const attempts = integer(input.retry?.attempts ?? 3, 1, 16);
  const rateLimitDelayMs = integer(input.retry?.rateLimitDelayMs ?? 500, 1, 5000);
  const timeoutMs = integer(input.timeoutMs ?? 10_000, 1, 120_000);
  const concurrency = integer(input.concurrency ?? 8, 1, 64);
  const retryOn = new Set(input.retry?.on ?? RETRY);
  if ([...retryOn].some((category) => !OBSERVATION_FAILURE_CATEGORIES.includes(category)))
    throw new MoesiObservationError("invalid_observer_configuration");
  const pools = new Map(
    Object.entries(input.chains).map(([key, config]) => {
      const chainId = integer(Number(key), 1, Number.MAX_SAFE_INTEGER);
      if (
        String(chainId) !== key ||
        !Array.isArray(config.rpcUrls) ||
        config.rpcUrls.length < 1 ||
        config.rpcUrls.length > 32
      )
        throw new MoesiObservationError("invalid_observer_configuration");
      const lagBlocks =
        config.pin === undefined || typeof config.pin === "string"
          ? 0
          : integer(config.pin.lagBlocks, 0, Number.MAX_SAFE_INTEGER);
      const clients = config.rpcUrls.map((url) => {
        let endpoint: RpcEndpoint;
        try {
          endpoint = rpcEndpoint(url);
        } catch {
          throw new MoesiObservationError("invalid_observer_configuration");
        }
        // Userinfo travels as an Authorization header; fetch rejects credentialed URLs.
        const client = (input.batch ? httpBatch : http)(endpoint.url, {
          fetch: observationFetch(input.fetchFn ?? fetch, timeoutMs),
          timeout: timeoutMs,
          headers: { ...endpoint.headers },
        });
        // Share only an in-flight identity check within one cancellation scope.
        // Never cache settled identities: endpoints can switch chains between reads.
        const identities = new Map<AbortSignal | undefined, Promise<unknown>>();
        return {
          client,
          readIdentity(signal: AbortSignal | undefined, fresh: boolean): Promise<unknown> {
            const pending = fresh ? undefined : identities.get(signal);
            if (pending) return pending;
            const options = signal ? { signal } : {};
            const read = client.request({ method: "eth_chainId", params: [] }, options);
            if (fresh) return read;
            const shared = read.finally(() => identities.delete(signal));
            identities.set(signal, shared);
            return shared;
          },
        };
      });
      const tag = typeof config.pin === "string" ? config.pin : "latest";
      const pool = { clients, tag, lagBlocks, preferred: 0, notBefore: clients.map(() => 0) };
      return [chainId, pool] as const;
    }),
  );
  if (pools.size === 0) throw new MoesiObservationError("invalid_observer_configuration");

  let active = 0;
  const queue: (() => void)[] = [];
  async function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new MoesiObservationError("observation_aborted");
    if (active >= concurrency) {
      let wake!: () => void;
      const waiting = new Promise<void>((resolve) => {
        wake = resolve;
        queue.push(wake);
      });
      try {
        await withObservationAbort(signal, () => waiting);
      } catch (error) {
        const index = queue.indexOf(wake);
        if (index >= 0) queue.splice(index, 1);
        else release();
        throw error;
      }
    } else active++;
    return release;
  }
  function release() {
    const next = queue.shift();
    if (next) next();
    else active--;
  }

  async function request(
    chainId: number,
    rpc: RpcInput,
    signal?: AbortSignal,
    requireParentHash = false,
  ): Promise<unknown> {
    const pool = pools.get(chainId);
    if (!pool) throw new MoesiObservationError("invalid_observer_configuration");
    const done = await acquire(signal);
    const failed: ObservationAttempt[] = [];
    try {
      const start = pool.preferred;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const endpoint = (start + attempt) % pool.clients.length;
        const { client, readIdentity } = pool.clients[endpoint]!;
        try {
          const delay = Math.min(5000, pool.notBefore[endpoint]! - Date.now());
          if (delay > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              await withObservationAbort(
                signal,
                () =>
                  new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, delay);
                  }),
              );
            } finally {
              clearTimeout(timer);
            }
          }
          const value = await withObservationAbort(signal, async () => {
            const options = signal ? { signal } : {};
            // The final ancestry fence must start a new check after rebinding the header.
            const identity = await readIdentity(signal, rpc.method === "eth_chainId");
            if (
              typeof identity !== "string" ||
              !QUANTITY.test(identity) ||
              BigInt(identity) !== BigInt(chainId)
            )
              throw new MoesiObservationError("observation_failed", {
                attempts: [
                  { endpoint, category: "chain-mismatch", rpcCode: null, httpStatus: null },
                ],
              });
            let value =
              rpc.method === "eth_chainId" ? identity : await client.request(rpc, options);
            if (
              rpc.method === "eth_getBlockByNumber" &&
              rpc.params?.[0] === "latest" &&
              pool.lagBlocks > 0
            ) {
              const head = block(value);
              const pinned = BigInt(head.blockNumber) - BigInt(pool.lagBlocks);
              if (pinned < 0n) throw new MoesiObservationError("observation_failed");
              value = await client.request(
                { method: "eth_getBlockByNumber", params: [`0x${pinned.toString(16)}`, false] },
                options,
              );
              if (BigInt(block(value).blockNumber) !== pinned)
                throw new MoesiObservationError("observation_failed");
            }
            if (
              rpc.method === "eth_getCode" ||
              rpc.method === "eth_call" ||
              rpc.method === "eth_getStorageAt"
            ) {
              const pattern =
                rpc.method === "eth_getStorageAt"
                  ? /^0x[0-9a-fA-F]{64}$/
                  : /^0x(?:[0-9a-fA-F]{2})*$/;
              if (typeof value !== "string" || !pattern.test(value))
                throw new MoesiObservationError("observation_failed", {
                  attempts: [
                    { endpoint, category: "invalid-response", rpcCode: null, httpStatus: null },
                  ],
                });
            }
            if (rpc.method === "eth_getBlockByNumber") {
              const result = block(value);
              if (
                (requireParentHash && result.parentHash === null) ||
                (typeof rpc.params?.[0] === "string" &&
                  QUANTITY.test(rpc.params[0]) &&
                  BigInt(result.blockNumber) !== BigInt(rpc.params[0]))
              )
                throw new MoesiObservationError("observation_failed");
            }
            return value;
          });
          pool.preferred = endpoint;
          return value;
        } catch (error) {
          if (
            signal?.aborted ||
            (error instanceof MoesiObservationError && error.code === "observation_aborted")
          )
            throw new MoesiObservationError("observation_aborted");
          const cause = error instanceof MoesiObservationError ? error.cause?.attempts[0] : null;
          const failure: ObservationAttempt =
            cause ??
            (error instanceof MoesiObservationError
              ? { endpoint, category: "invalid-response", rpcCode: null, httpStatus: null }
              : classify(error, endpoint));
          failed.push(failure);
          if (failure.category === "rate-limited")
            pool.notBefore[endpoint] = Math.max(
              pool.notBefore[endpoint]!,
              Date.now() + Math.min(5000, rateLimitDelayMs * 2 ** attempt),
            );
          if (!retryOn.has(failure.category)) break;
        }
      }
      throw new MoesiObservationError("observation_failed", { attempts: failed });
    } finally {
      done();
    }
  }
  return Object.freeze({
    async captureSnapshot(chainId, options) {
      const captured = block(
        await request(
          chainId,
          { method: "eth_getBlockByNumber", params: [pools.get(chainId)?.tag, false] },
          options?.signal,
        ),
      );
      return { blockNumber: captured.blockNumber, blockHash: captured.blockHash };
    },
    readCode: ({ chainId, address, snapshot, signal }) =>
      request(
        chainId,
        {
          method: "eth_getCode",
          params: [address, { blockHash: snapshot.blockHash, requireCanonical: true }],
        },
        signal,
      ),
    readCall: ({ chainId, target, data, caller, snapshot, signal }) =>
      request(
        chainId,
        {
          method: "eth_call",
          params: [
            { from: caller, to: target, data },
            { blockHash: snapshot.blockHash, requireCanonical: true },
          ],
        },
        signal,
      ),
    readStorage: ({ chainId, address, slot, snapshot, signal }) =>
      request(
        chainId,
        {
          method: "eth_getStorageAt",
          params: [address, slot, { blockHash: snapshot.blockHash, requireCanonical: true }],
        },
        signal,
      ),
    async checkBlockAncestry({ chainId, ancestor, descendant, signal }) {
      const matches = await checkCanonicalAncestry(ancestor, descendant, async (height) => {
        const current = block(
          await request(
            chainId,
            { method: "eth_getBlockByNumber", params: [`0x${height.toString(16)}`, false] },
            signal,
            true,
          ),
        );
        if (current.parentHash === null) throw new MoesiObservationError("observation_failed");
        return { ...current, parentHash: current.parentHash };
      });
      if (matches) await request(chainId, { method: "eth_chainId" }, signal);
      return matches;
    },
  } satisfies MoesiObservationAdapter);
}
