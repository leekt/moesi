import type { Address, Hex } from "cetane";
import { type Abi, encodeDeployData, keccak256, stringToHex } from "cetane/utils";
import { deepFreeze, hashCanonical } from "./internal.js";

export type MoesiArtifactErrorCode =
  | "artifact_invalid"
  | "artifact_format_unsupported"
  | "artifact_runtime_metadata_required"
  | "artifact_library_missing"
  | "artifact_library_mismatch"
  | "artifact_constructor_invalid"
  | "artifact_runtime_required"
  | "artifact_runtime_mismatch";

/** Fixed diagnostics never include compiler source, argument values, or raw errors. */
export class MoesiArtifactError extends Error {
  constructor(
    readonly code: MoesiArtifactErrorCode,
    readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = "MoesiArtifactError";
  }
}

export interface EvaluatedArtifactRuntime {
  /** Bind evaluation to the linked creation code and exact constructor arguments. */
  readonly initCodeHash: Hex;
  /** Expected runtime evaluated in the intended deployment context, never adopted from live drift. */
  readonly code: Hex;
}

export interface CompiledSolidityArtifact {
  readonly version: "moesi.compiled-artifact/v1";
  readonly initCode: Hex;
  readonly expectedRuntimeCodeHash: Hex;
  readonly provenance: Readonly<{
    artifactHash: Hex;
    metadataHash: Hex | null;
    buildInfoId: string | null;
    initCodeHash: Hex;
    libraries: Readonly<Record<string, Address>>;
    runtime: "compiler" | "evaluated";
  }>;
}

export interface PreparedSolidityArtifact {
  readonly initCode: Hex;
  readonly initCodeHash: Hex;
  readonly runtimeTemplate: Hex;
  readonly requiresRuntimeEvaluation: boolean;
  /** Complete literal manifest bytes. This validates evidence; it performs no RPC or deployment. */
  readonly compile: (runtime?: EvaluatedArtifactRuntime) => Readonly<CompiledSolidityArtifact>;
}

const fail = (code: MoesiArtifactErrorCode, path: string): never => {
  throw new MoesiArtifactError(code, path);
};
const invalid = (path: string): never => fail("artifact_invalid", path);

/** Capture caller/file input once without getters, toJSON, or unbounded traversal. */
function capture(
  value: unknown,
  path: string,
  depth = 0,
  budget = { nodes: 100_000, bytes: 8_388_608 },
): unknown {
  if (--budget.nodes < 0 || depth > 32) return invalid(path);
  if (typeof value === "string") {
    budget.bytes -= value.length;
    if (budget.bytes < 0) return invalid(path);
    return value;
  }
  if (value === null || typeof value === "boolean" || typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "object" || value === null) return invalid(path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length) ||
      length > 16_384 ||
      Reflect.ownKeys(descriptors).length !== length + 1
    )
      return invalid(path);
    return Object.freeze(
      Array.from({ length }, (_, index) => {
        const item = descriptors[String(index)];
        if (!item || !("value" in item)) return invalid(path);
        return capture(item.value, path, depth + 1, budget);
      }),
    );
  }
  const proto = Object.getPrototypeOf(value);
  if (
    (proto !== Object.prototype && proto !== null) ||
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")
  )
    return invalid(path);
  return Object.freeze(
    Object.fromEntries(
      Object.keys(descriptors)
        .sort()
        .map((key) => {
          const item = descriptors[key]!;
          if (!("value" in item) || !item.enumerable) return invalid(path);
          return [key, capture(item.value, path, depth + 1, budget)];
        }),
    ),
  );
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(path);
  return value as Record<string, unknown>;
}
function exact(value: unknown, path: string, keys: readonly string[]) {
  const result = record(value, path);
  if (Object.keys(result).some((key) => !keys.includes(key))) return invalid(path);
  return result;
}
function bytes(value: unknown, path: string): Hex {
  if (
    typeof value !== "string" ||
    !/^0x(?:[a-fA-F0-9]{2})+$/.test(value) ||
    value.length > 2_097_154
  )
    return invalid(path);
  return value.toLowerCase() as Hex;
}
type Range = Readonly<{ start: number; length: number }>;
function ranges(value: unknown, path: string, size: number, width: number): Range[] {
  if (!Array.isArray(value) || value.length === 0) return invalid(path);
  return value.map((entry) => {
    const item = exact(entry, path, ["start", "length"]);
    if (
      !Number.isSafeInteger(item.start) ||
      (item.start as number) < 0 ||
      item.length !== width ||
      (item.start as number) + width > size
    )
      return invalid(path);
    return { start: item.start as number, length: width };
  });
}
function disjoint(ranges: readonly Range[], path: string) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  if (
    sorted.some(
      (item, index) =>
        index > 0 && item.start < sorted[index - 1]!.start + sorted[index - 1]!.length,
    )
  )
    return invalid(path);
}

/** Foundry, solc contract output, and Hardhat 3 artifacts retain the compiler's reference maps. */
export function prepareSolidityArtifact(input: {
  readonly artifact: unknown;
  readonly constructorArgs?: readonly unknown[];
  /** Fully qualified source:library names, exactly matching the compiler's link references. */
  readonly libraries?: Readonly<Record<string, Address>>;
}): Readonly<PreparedSolidityArtifact> {
  try {
    const root = exact(capture(input, "input"), "input", [
      "artifact",
      "constructorArgs",
      "libraries",
    ]);
    const artifact = record(root.artifact, "artifact");
    let creation: Record<string, unknown>;
    let deployed: Record<string, unknown>;
    let buildInfoId: string | null = null;
    if (artifact._format !== undefined) {
      if (artifact._format !== "hh3-artifact-1")
        return fail("artifact_format_unsupported", "artifact._format");
      if (
        typeof artifact.buildInfoId !== "string" ||
        !/^solc-[0-9_]+-[a-zA-Z0-9_-]{1,128}$/.test(artifact.buildInfoId)
      )
        return invalid("artifact.buildInfoId");
      buildInfoId = artifact.buildInfoId;
      creation = { object: artifact.bytecode, linkReferences: artifact.linkReferences };
      deployed = {
        object: artifact.deployedBytecode,
        linkReferences: artifact.deployedLinkReferences,
        immutableReferences: artifact.immutableReferences,
      };
    } else if (artifact.evm !== undefined) {
      const evm = record(artifact.evm, "artifact.evm");
      creation = record(evm.bytecode, "artifact.evm.bytecode");
      deployed = record(evm.deployedBytecode, "artifact.evm.deployedBytecode");
    } else {
      creation = record(artifact.bytecode, "artifact.bytecode");
      deployed = record(artifact.deployedBytecode, "artifact.deployedBytecode");
      // Foundry's CompactDeployedBytecode omits an empty immutable map.
      if (deployed.immutableReferences === undefined && artifact.metadata !== undefined)
        deployed = { ...deployed, immutableReferences: {} };
    }
    if (deployed.immutableReferences === undefined)
      return fail(
        "artifact_runtime_metadata_required",
        "artifact.deployedBytecode.immutableReferences",
      );
    let metadata: unknown = artifact.metadata ?? null;
    if (typeof metadata === "string") {
      try {
        metadata = capture(JSON.parse(metadata), "artifact.metadata");
      } catch {
        return invalid("artifact.metadata");
      }
    }
    if (metadata !== null) record(metadata, "artifact.metadata");
    const metadataHash = metadata === null ? null : hashCanonical(metadata);
    const abi = artifact.abi;
    if (!Array.isArray(abi)) return invalid("artifact.abi");
    const constructors = abi.filter((item) => record(item, "artifact.abi").type === "constructor");
    if (constructors.length > 1) return invalid("artifact.abi");
    const libraries = record(root.libraries ?? {}, "libraries");
    const linked = Object.create(null) as Record<string, Address>;
    for (const [key, value] of Object.entries(libraries)) {
      if (
        typeof value !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(value) ||
        /^0x0{40}$/.test(value)
      )
        return invalid("libraries");
      linked[key] = value.toLowerCase() as Address;
    }
    const used = new Set<string>();
    const runtimeLinks: Range[] = [];
    function link(part: Record<string, unknown>, path: string, retained: Range[] = []): Hex {
      if (typeof part.object !== "string") return invalid(path);
      let code = part.object.replace(/^0x/, "");
      if (code.length === 0 || code.length > 2_097_152 || code.length % 2 !== 0)
        return invalid(path);
      const positions: { name: string; range: Range }[] = [];
      for (const [source, entries] of Object.entries(
        record(part.linkReferences, `${path}.linkReferences`),
      )) {
        for (const [name, value] of Object.entries(record(entries, `${path}.linkReferences`))) {
          const key = `${source}:${name}`;
          for (const range of ranges(value, `${path}.linkReferences`, code.length / 2, 20))
            positions.push({ name: key, range });
        }
      }
      disjoint(
        positions.map(({ range }) => range),
        path,
      );
      for (const { name, range } of positions) {
        const address = linked[name];
        if (!address) return fail("artifact_library_missing", "libraries");
        const slot = code.slice(range.start * 2, (range.start + range.length) * 2);
        const placeholder = `__$${keccak256(stringToHex(name)).slice(2, 36)}$__`;
        if (slot !== placeholder && slot.toLowerCase() !== address.slice(2))
          return fail("artifact_library_mismatch", path);
        code =
          code.slice(0, range.start * 2) +
          address.slice(2) +
          code.slice((range.start + range.length) * 2);
        used.add(name);
        retained.push(range);
      }
      return bytes(`0x${code}`, path);
    }
    const bytecode = link(creation, "artifact.bytecode");
    const runtimeTemplate = link(deployed, "artifact.deployedBytecode", runtimeLinks);
    if (Object.keys(linked).some((name) => !used.has(name)))
      return fail("artifact_library_mismatch", "libraries");
    const immutableGroups = Object.entries(
      record(deployed.immutableReferences, "artifact.deployedBytecode.immutableReferences"),
    ).map(([id, value]) => {
      if (!/^(0|[1-9][0-9]*)$/.test(id))
        return invalid("artifact.deployedBytecode.immutableReferences");
      return ranges(
        value,
        "artifact.deployedBytecode.immutableReferences",
        (runtimeTemplate.length - 2) / 2,
        32,
      );
    });
    // Solidity libraries patch their own address for direct-call protection.
    const librarySelf = /^0x730{40}3014/.test(runtimeTemplate) ? [{ start: 1, length: 20 }] : [];
    const mutable = [...immutableGroups.flat(), ...librarySelf];
    disjoint([...mutable, ...runtimeLinks], "artifact.deployedBytecode");
    const args = root.constructorArgs ?? [];
    if (!Array.isArray(args)) return fail("artifact_constructor_invalid", "constructorArgs");
    const constructorInputs = constructors.length === 0 ? [] : constructors[0].inputs;
    if (!Array.isArray(constructorInputs)) return invalid("artifact.abi");
    if (args.length !== constructorInputs.length)
      return fail("artifact_constructor_invalid", "constructorArgs");
    let initCode: Hex;
    try {
      initCode = encodeDeployData({ abi: abi as Abi, bytecode, args }).toLowerCase() as Hex;
    } catch {
      return fail("artifact_constructor_invalid", "constructorArgs");
    }
    if (initCode.length > 2_097_154) return invalid("constructorArgs");
    const initCodeHash = keccak256(initCode);
    const artifactHash = hashCanonical({
      abi,
      creation,
      deployed,
      metadataHash,
      buildInfoId,
      contractName: artifact.contractName ?? null,
      inputSourceName: artifact.inputSourceName ?? null,
    });
    const requiresRuntimeEvaluation = mutable.length > 0;
    return Object.freeze({
      initCode,
      initCodeHash,
      runtimeTemplate,
      requiresRuntimeEvaluation,
      compile(value?: EvaluatedArtifactRuntime): Readonly<CompiledSolidityArtifact> {
        try {
          let runtime = runtimeTemplate;
          if (value === undefined && requiresRuntimeEvaluation)
            return fail("artifact_runtime_required", "runtime");
          if (value !== undefined) {
            const evidence = exact(capture(value, "runtime"), "runtime", ["initCodeHash", "code"]);
            runtime = bytes(evidence.code, "runtime.code");
            if (evidence.initCodeHash !== initCodeHash || runtime.length !== runtimeTemplate.length)
              return fail("artifact_runtime_mismatch", "runtime");
            const actual = runtime.slice(2).split("");
            const expected = runtimeTemplate.slice(2).split("");
            for (const range of mutable) {
              actual.fill("0", range.start * 2, (range.start + range.length) * 2);
              expected.fill("0", range.start * 2, (range.start + range.length) * 2);
            }
            if (actual.join("") !== expected.join(""))
              return fail("artifact_runtime_mismatch", "runtime.code");
            for (const group of immutableGroups) {
              const words = group.map(({ start, length }) =>
                runtime.slice(2 + start * 2, 2 + (start + length) * 2),
              );
              if (new Set(words).size !== 1)
                return fail("artifact_runtime_mismatch", "runtime.code");
            }
          }
          return deepFreeze({
            version: "moesi.compiled-artifact/v1",
            initCode,
            expectedRuntimeCodeHash: keccak256(runtime),
            provenance: {
              artifactHash,
              metadataHash,
              buildInfoId,
              initCodeHash,
              libraries: linked,
              runtime: value === undefined ? "compiler" : "evaluated",
            },
          });
        } catch (error) {
          if (error instanceof MoesiArtifactError) throw error;
          return invalid("runtime");
        }
      },
    });
  } catch (error) {
    if (error instanceof MoesiArtifactError) throw error;
    return invalid("input");
  }
}
