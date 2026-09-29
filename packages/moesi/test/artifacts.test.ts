import { createRequire } from "node:module";
import { encodeAbiParameters, type Hex, keccak256, stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { MoesiArtifactError, prepareSolidityArtifact } from "../src/index.js";

const solc = createRequire(import.meta.url)("solc");
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: {
        "Example.sol": {
          content: `pragma solidity ^0.8.20;
    library Math { function plus(uint x) public pure returns(uint) { return x + 1; } }
    contract Static { uint public value; constructor(uint v) { value = v; } }
    contract Immutable { address public immutable owner; constructor(address a) { owner = a; } function again() external view returns(address) { return owner; } }
    contract Linked { function plus(uint x) external pure returns(uint) { return Math.plus(x); } }
  `,
        },
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "shanghai",
        outputSelection: {
          "*": { "*": ["abi", "metadata", "evm.bytecode", "evm.deployedBytecode"] },
        },
      },
    }),
  ),
);
const artifacts = output.contracts["Example.sol"];
const address = `0x${"11".repeat(20)}` as const;
const foundry = (name: string) => ({
  abi: artifacts[name].abi,
  metadata: JSON.parse(artifacts[name].metadata),
  bytecode: artifacts[name].evm.bytecode,
  deployedBytecode: artifacts[name].evm.deployedBytecode,
});
const hardhat = (name: string) => ({
  _format: "hh3-artifact-1",
  contractName: name,
  sourceName: "contracts/Example.sol",
  inputSourceName: "project/contracts/Example.sol",
  buildInfoId: "solc-0_8_30-fixture",
  abi: artifacts[name].abi,
  bytecode: `0x${artifacts[name].evm.bytecode.object}`,
  deployedBytecode: `0x${artifacts[name].evm.deployedBytecode.object}`,
  linkReferences: artifacts[name].evm.bytecode.linkReferences,
  deployedLinkReferences: artifacts[name].evm.deployedBytecode.linkReferences,
  immutableReferences: artifacts[name].evm.deployedBytecode.immutableReferences,
});

describe("Solidity artifacts to literal manifest bytes", () => {
  it("encodes identical constructor bytes from solc, Foundry and Hardhat artifacts", () => {
    for (const artifact of [artifacts.Static, foundry("Static"), hardhat("Static")]) {
      const prepared = prepareSolidityArtifact({ artifact, constructorArgs: [42n] });
      expect(prepared.initCode).toBe(
        `0x${artifacts.Static.evm.bytecode.object}${encodeAbiParameters([{ type: "uint256" }], [42n]).slice(2)}`,
      );
      expect(prepared.requiresRuntimeEvaluation).toBe(false);
      const result = prepared.compile();
      expect(result.expectedRuntimeCodeHash).toBe(
        keccak256(`0x${artifacts.Static.evm.deployedBytecode.object}`),
      );
      expect(result.provenance.initCodeHash).toBe(keccak256(result.initCode));
      expect(Object.isFrozen(result.provenance.libraries)).toBe(true);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    }
  });

  it("retains compiler identity and changes identity when constructor or compiler inputs change", () => {
    const artifact = foundry("Static");
    const before = prepareSolidityArtifact({ artifact, constructorArgs: [42n] }).compile();
    const args = prepareSolidityArtifact({ artifact, constructorArgs: [43n] }).compile();
    expect(args.provenance.artifactHash).toBe(before.provenance.artifactHash);
    expect(args.provenance.initCodeHash).not.toBe(before.provenance.initCodeHash);
    artifact.metadata.compiler.version = "different-compiler";
    const changed = prepareSolidityArtifact({ artifact, constructorArgs: [42n] }).compile();
    expect(changed.provenance.metadataHash).not.toBe(before.provenance.metadataHash);
    expect(changed.provenance.artifactHash).not.toBe(before.provenance.artifactHash);
  });

  it("does not hash unresolved immutable placeholders as desired runtime", () => {
    const prepared = prepareSolidityArtifact({
      artifact: artifacts.Immutable,
      constructorArgs: [address],
    });
    expect(prepared.requiresRuntimeEvaluation).toBe(true);
    expect(() => prepared.compile()).toThrowError(
      expect.objectContaining({ code: "artifact_runtime_required", path: "runtime" }),
    );
    let code = prepared.runtimeTemplate;
    for (const ranges of Object.values(
      artifacts.Immutable.evm.deployedBytecode.immutableReferences,
    ) as { start: number; length: number }[][])
      for (const { start, length } of ranges)
        code =
          `${code.slice(0, 2 + start * 2)}${encodeAbiParameters([{ type: "address" }], [address]).slice(2)}${code.slice(2 + (start + length) * 2)}` as Hex;
    const result = prepared.compile({ initCodeHash: prepared.initCodeHash, code });
    expect(result.expectedRuntimeCodeHash).toBe(keccak256(code));
    expect(result.provenance.runtime).toBe("evaluated");
    expect(() => prepared.compile({ initCodeHash: keccak256("0x00"), code })).toThrowError(
      expect.objectContaining({ code: "artifact_runtime_mismatch" }),
    );
    expect(() =>
      prepared.compile({ initCodeHash: prepared.initCodeHash, code: `0xff${code.slice(4)}` }),
    ).toThrowError(expect.objectContaining({ code: "artifact_runtime_mismatch" }));
    const first = (
      Object.values(artifacts.Immutable.evm.deployedBytecode.immutableReferences)[0] as {
        start: number;
      }[]
    )[0]!;
    const inconsistent =
      `${code.slice(0, 2 + first.start * 2)}${"22".repeat(32)}${code.slice(2 + (first.start + 32) * 2)}` as const;
    expect(() =>
      prepared.compile({ initCodeHash: prepared.initCodeHash, code: inconsistent as Hex }),
    ).toThrowError(expect.objectContaining({ code: "artifact_runtime_mismatch" }));
  });

  it("links exact compiler slots in both creation and runtime and rejects unknown libraries", () => {
    const artifact = artifacts.Linked;
    const key = "Example.sol:Math";
    const placeholder = `__$${keccak256(stringToHex(key)).slice(2, 36)}$__`;
    const prepared = prepareSolidityArtifact({ artifact, libraries: { [key]: address } });
    expect(prepared.initCode).toBe(
      `0x${artifact.evm.bytecode.object.replaceAll(placeholder, address.slice(2))}`,
    );
    expect(prepared.runtimeTemplate).toBe(
      `0x${artifact.evm.deployedBytecode.object.replaceAll(placeholder, address.slice(2))}`,
    );
    expect(prepared.compile().provenance.libraries).toEqual({ [key]: address });
    expect(() => prepareSolidityArtifact({ artifact })).toThrowError(
      expect.objectContaining({ code: "artifact_library_missing" }),
    );
    expect(() =>
      prepareSolidityArtifact({ artifact, libraries: { [key]: address, unused: address } }),
    ).toThrowError(expect.objectContaining({ code: "artifact_library_mismatch" }));
    const malformed = structuredClone(artifact);
    malformed.evm.bytecode.object = malformed.evm.bytecode.object.replaceAll(
      placeholder,
      "00".repeat(20),
    );
    expect(() =>
      prepareSolidityArtifact({ artifact: malformed, libraries: { [key]: address } }),
    ).toThrowError(expect.objectContaining({ code: "artifact_library_mismatch" }));
  });

  it("requires evaluation of the library's own deployment address", () => {
    const prepared = prepareSolidityArtifact({ artifact: artifacts.Math });
    expect(prepared.requiresRuntimeEvaluation).toBe(true);
    expect(() => prepared.compile()).toThrowError(
      expect.objectContaining({ code: "artifact_runtime_required" }),
    );
    const code = `0x73${address.slice(2)}${prepared.runtimeTemplate.slice(44)}` as const;
    expect(
      prepared.compile({ initCodeHash: prepared.initCodeHash, code }).expectedRuntimeCodeHash,
    ).toBe(keccak256(code));
  });

  it.each([
    { constructorArgs: [] },
    { constructorArgs: [1n, 2n] },
    { constructorArgs: ["not a number"] },
  ])("rejects invalid constructor inputs $constructorArgs before RPC", ({ constructorArgs }) => {
    expect(() =>
      prepareSolidityArtifact({ artifact: artifacts.Static, constructorArgs }),
    ).toThrowError(expect.objectContaining({ code: "artifact_constructor_invalid" }));
  });

  it("requires complete runtime maps and rejects unknown artifact versions", () => {
    const artifact = structuredClone(artifacts.Static);
    delete artifact.evm.deployedBytecode.immutableReferences;
    expect(() => prepareSolidityArtifact({ artifact, constructorArgs: [1n] })).toThrowError(
      expect.objectContaining({ code: "artifact_runtime_metadata_required" }),
    );
    expect(() =>
      prepareSolidityArtifact({ artifact: { ...hardhat("Static"), _format: "other" } }),
    ).toThrowError(expect.objectContaining({ code: "artifact_format_unsupported" }));
  });

  it("normalizes Foundry's omitted empty immutable map", () => {
    const artifact = structuredClone(foundry("Static"));
    delete artifact.deployedBytecode.immutableReferences;
    const prepared = prepareSolidityArtifact({ artifact, constructorArgs: [1n] });
    expect(prepared.requiresRuntimeEvaluation).toBe(false);
    expect(prepared.compile().expectedRuntimeCodeHash).toBe(
      keccak256(`0x${artifact.deployedBytecode.object}`),
    );
  });

  it("rejects unreadable runtime evidence without retaining the thrown value", () => {
    const prepared = prepareSolidityArtifact({ artifact: artifacts.Static, constructorArgs: [1n] });
    const runtime = new Proxy(
      { initCodeHash: prepared.initCodeHash, code: prepared.runtimeTemplate },
      {
        ownKeys() {
          throw new Error("private runtime material");
        },
      },
    );
    expect(() => prepared.compile(runtime)).toThrowError(
      expect.objectContaining({ code: "artifact_invalid", path: "runtime" }),
    );
    try {
      prepared.compile(runtime);
    } catch (error) {
      expect(String(error)).not.toContain("private");
    }
  });

  it.each(["outside", "overlap", "width"])("rejects %s immutable reference maps", (variant) => {
    const artifact = structuredClone(artifacts.Immutable);
    artifact.evm.deployedBytecode.immutableReferences = {
      "1":
        variant === "outside"
          ? [{ start: 1_000_000, length: 32 }]
          : variant === "width"
            ? [{ start: 0, length: 31 }]
            : [
                { start: 0, length: 32 },
                { start: 1, length: 32 },
              ],
    };
    expect(() => prepareSolidityArtifact({ artifact, constructorArgs: [address] })).toThrow(
      MoesiArtifactError,
    );
  });

  it("captures file input once and rejects getters without running them", () => {
    const artifact = foundry("Static");
    const prepared = prepareSolidityArtifact({ artifact, constructorArgs: [1n] });
    const before = prepared.compile();
    artifact.bytecode = { ...artifact.bytecode, object: "0xff" };
    expect(prepared.compile()).toEqual(before);
    let called = false;
    Object.defineProperty(artifact, "metadata", {
      get() {
        called = true;
        throw Error("private artifact contents");
      },
    });
    expect(() => prepareSolidityArtifact({ artifact, constructorArgs: [1n] })).toThrowError(
      expect.objectContaining({ code: "artifact_invalid" }),
    );
    expect(called).toBe(false);
  });
});
