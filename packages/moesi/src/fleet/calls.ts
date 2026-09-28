import {
  type Abi,
  type AbiFunction,
  type AbiParameter,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  getAbiItem,
  type Hex,
} from "viem";
import { snapshotArray } from "../internal.js";
import type { ConfigurationBatchParameter, ConfigurationRule } from "../manifest/types.js";
import { MoesiFleetError } from "./errors.js";
import type { FleetReadName, FleetRule, FleetWriteName } from "./types.js";

export function encodeFleetCall(
  abi: Abi,
  functionName: string,
  args: unknown,
  mutability: "read" | "write",
): { data: Hex; fn: AbiFunction } {
  try {
    const values = snapshotArray(args);
    if (!values) throw new Error();
    const fn = getAbiItem({ abi, name: functionName, args: values });
    if (
      !fn ||
      fn.type !== "function" ||
      (fn.stateMutability === "view" || fn.stateMutability === "pure") !== (mutability === "read")
    )
      throw new Error();
    return { data: encodeFunctionData({ abi: [fn], functionName: fn.name, args: values }), fn };
  } catch {
    throw new MoesiFleetError("invalid_abi_call");
  }
}
export function compileFleetRule<
  A extends Abi,
  R extends FleetReadName<A>,
  W extends FleetWriteName<A>,
>(abi: A, input: FleetRule<A, R, W>): ConfigurationRule {
  const read = encodeFleetCall(abi, input.read.functionName, input.read.args, "read");
  const write = encodeFleetCall(abi, input.write.functionName, input.write.args, "write");
  let expectedResult: Hex;
  try {
    expectedResult = encodeFunctionResult<Abi, string>({
      abi: [read.fn],
      functionName: read.fn.name,
      result: input.expect,
    });
  } catch {
    throw new MoesiFleetError("invalid_abi_call");
  }
  return {
    id: input.id,
    readData: read.data,
    expectedResult,
    writeData: write.data,
    value: (input.value ?? 0n).toString(),
    ...(input.after === undefined ? {} : { after: input.after }),
    ...(input.batch === undefined
      ? {}
      : {
          batch: {
            key: input.batch.key,
            maxRows: input.batch.maxRows ?? 256,
            parameters: write.fn.inputs.map(formatBatchParameter),
          },
        }),
  };
}
function formatBatchParameter(parameter: AbiParameter): ConfigurationBatchParameter {
  // The manifest boundary validates the exact supported batch ABI and one-row data.
  return (
    parameter.type.startsWith("tuple") && "components" in parameter
      ? `(${parameter.components.map(formatBatchParameter).join(",")})${parameter.type.slice(5)}`
      : parameter.type
  ) as ConfigurationBatchParameter;
}
export function decodeFleetRead(fn: AbiFunction, result: Hex): unknown {
  try {
    const decoded = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: result });
    if (encodeFunctionResult({ abi: [fn], functionName: fn.name, result: decoded }) !== result)
      throw new Error();
    return decoded;
  } catch {
    throw new MoesiFleetError("invalid_live_read");
  }
}
