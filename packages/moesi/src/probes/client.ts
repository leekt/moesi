import type { Address, Hex } from "viem";
import { MoesiProbeError } from "./error.js";
import { probeHex, probeRecord } from "./validation.js";

/**
 * Minimal caller-owned client capability the probes operate through. Any viem
 * PublicClient satisfies it structurally; Moesi never creates a transport, so
 * authentication, pooling, timeouts, and retries stay with the caller.
 */
export interface ProbeClient {
  call(args: {
    readonly to: Address;
    readonly data: Hex;
    readonly blockNumber?: bigint;
    readonly stateOverride?: readonly { readonly address: Address; readonly code: Hex }[];
  }): Promise<{ readonly data?: Hex }>;
  getCode(args: {
    readonly address: Address;
    readonly blockNumber?: bigint;
  }): Promise<Hex | undefined>;
  getBlock?(args: {
    readonly blockNumber?: bigint;
    readonly blockTag?: "latest";
  }): Promise<{ readonly baseFeePerGas?: bigint | null; readonly difficulty?: bigint }>;
  request?(args: { readonly method: string; readonly params: unknown[] }): Promise<unknown>;
}

/**
 * Any client whose methods are call-compatible with ProbeClient — in
 * particular every viem PublicClient. Parameter types are deliberately
 * `never` so richer parameter shapes (viem's CallParameters unions) remain
 * assignable; parseProbeClient normalizes to the exact ProbeClient shape.
 */
export type ProbeClientLike =
  | ProbeClient
  | {
      call(args: never): Promise<unknown>;
      getCode(args: never): Promise<unknown>;
      getBlock?(args: never): Promise<unknown>;
      request?(args: never): Promise<unknown>;
    };

/** Snapshot methods once; normalize every response and failure at the RPC boundary. */
export function parseProbeClient(input: unknown): ProbeClient {
  let call: (...args: never[]) => unknown;
  let getCode: (...args: never[]) => unknown;
  let getBlock: unknown;
  let request: unknown;
  try {
    if (typeof input !== "object" || input === null) throw null;
    const callInput = Reflect.get(input, "call");
    const codeInput = Reflect.get(input, "getCode");
    if (typeof callInput !== "function" || typeof codeInput !== "function") throw null;
    call = callInput;
    getCode = codeInput;
    getBlock = Reflect.get(input, "getBlock");
    request = Reflect.get(input, "request");
    if (getBlock !== undefined && typeof getBlock !== "function") throw null;
    if (request !== undefined && typeof request !== "function") throw null;
  } catch {
    throw new MoesiProbeError(
      "missing-transport",
      "probe client capabilities are invalid or unreadable",
    );
  }
  async function invoke(method: (...args: never[]) => unknown, args: unknown): Promise<unknown> {
    try {
      return await Reflect.apply(method, input, [args]);
    } catch (error) {
      // Never retain the original error, its cause, message, data, or request.
      const code = rpcMethodUnavailable(error) ? "method-unavailable" : "transport-failed";
      throw new MoesiProbeError(code, "probe RPC request did not produce evidence");
    }
  }
  return Object.freeze({
    async call(args: Parameters<ProbeClient["call"]>[0]) {
      const response = probeRecord(await invoke(call, args), "invalid-response");
      return Object.freeze({
        data: response.data === undefined ? ("0x" as const) : probeHex(response.data),
      });
    },
    async getCode(args: Parameters<ProbeClient["getCode"]>[0]) {
      const code = await invoke(getCode, args);
      // viem represents empty eth_getCode data as undefined.
      return code === undefined ? "0x" : probeHex(code);
    },
    ...(typeof getBlock === "function"
      ? {
          async getBlock(args: Parameters<NonNullable<ProbeClient["getBlock"]>>[0]) {
            const block = probeRecord(
              await invoke(getBlock as (...args: never[]) => unknown, args),
              "invalid-response",
            );
            const baseFeePerGas = block.baseFeePerGas;
            const difficulty = block.difficulty;
            for (const value of [baseFeePerGas, difficulty]) {
              if (
                value !== undefined &&
                value !== null &&
                (typeof value !== "bigint" || value < 0n || value >= 1n << 256n)
              ) {
                throw new MoesiProbeError("invalid-response", "probe block header is invalid");
              }
            }
            if (difficulty === null)
              throw new MoesiProbeError("invalid-response", "probe block difficulty is invalid");
            return Object.freeze({
              ...(baseFeePerGas === undefined
                ? {}
                : { baseFeePerGas: baseFeePerGas as bigint | null }),
              ...(difficulty === undefined ? {} : { difficulty: difficulty as bigint }),
            });
          },
        }
      : {}),
    ...(typeof request === "function"
      ? {
          request: (args: Parameters<NonNullable<ProbeClient["request"]>>[0]) =>
            invoke(request as (...args: never[]) => unknown, args),
        }
      : {}),
  });
}

/** Follow bounded own-data causes without ever inspecting diagnostic prose. */
function rpcMethodUnavailable(error: unknown): boolean {
  const seen = new Set<unknown>();
  try {
    for (
      let depth = 0;
      depth < 8 && typeof error === "object" && error !== null && !seen.has(error);
      depth += 1
    ) {
      seen.add(error);
      const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
      if (typeof code === "number") return code === -32601 || code === -32004 || code === 4200;
      error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
    }
  } catch {
    /* Malformed diagnostics remain inconclusive. */
  }
  return false;
}
