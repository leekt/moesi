import type { Address, Hex } from "viem";
import { MoesiProbeError } from "./error.js";

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

/** Snapshot the caller-owned capability once at the probe trust boundary. */
export function parseProbeClient(input: unknown): ProbeClient {
  if (typeof input !== "object" || input === null) {
    throw new MoesiProbeError("missing-transport", "probes require a caller-owned client");
  }
  const call = Reflect.get(input, "call") as unknown;
  const getCode = Reflect.get(input, "getCode") as unknown;
  if (typeof call !== "function" || typeof getCode !== "function") {
    throw new MoesiProbeError("missing-transport", "probe client must expose call and getCode");
  }
  const getBlock = Reflect.get(input, "getBlock") as unknown;
  const request = Reflect.get(input, "request") as unknown;
  return Object.freeze({
    call: (args: Parameters<ProbeClient["call"]>[0]) =>
      Reflect.apply(call, input, [args]) as ReturnType<ProbeClient["call"]>,
    getCode: (args: Parameters<ProbeClient["getCode"]>[0]) =>
      Reflect.apply(getCode, input, [args]) as ReturnType<ProbeClient["getCode"]>,
    ...(typeof getBlock === "function"
      ? {
          getBlock: (args: Parameters<NonNullable<ProbeClient["getBlock"]>>[0]) =>
            Reflect.apply(getBlock, input, [args]) as ReturnType<
              NonNullable<ProbeClient["getBlock"]>
            >,
        }
      : {}),
    ...(typeof request === "function"
      ? {
          request: (args: Parameters<NonNullable<ProbeClient["request"]>>[0]) =>
            Reflect.apply(request, input, [args]) as ReturnType<
              NonNullable<ProbeClient["request"]>
            >,
        }
      : {}),
  });
}

/** Classify an inner call failure as an EVM revert rather than a transport fault. */
export function isExecutionRevert(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes("execution reverted") ||
    message.includes("invalid opcode") ||
    message.includes("opcode 0x") ||
    message.includes("notactivated") ||
    message.includes("not activated") ||
    message.includes("vm exception") ||
    message.includes("reverted with") ||
    message.includes("revert with")
  );
}
