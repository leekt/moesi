import {
  type CompiledSolidityArtifact,
  MoesiArtifactError,
  parseManifestText,
  prepareSolidityArtifact,
} from "moesi";
import { encodeAbiParameters, type Hex, keccak256 } from "viem";
import artifacts from "./artifact.json" with { type: "json" };

const library = `0x${"11".repeat(20)}` as const;
const prepared = prepareSolidityArtifact({
  artifact: artifacts.ArtifactExample,
  constructorArgs: [42n],
  libraries: { "ArtifactExample.sol:ArtifactMath": library },
});
if (!prepared.requiresRuntimeEvaluation || !Object.isFrozen(prepared))
  throw new Error("artifact_preparation_failed");
try {
  prepared.compile();
  throw new Error("missing_runtime_accepted");
} catch (error) {
  if (!(error instanceof MoesiArtifactError) || error.code !== "artifact_runtime_required")
    throw error;
}
let code = prepared.runtimeTemplate;
for (const ranges of Object.values(
  artifacts.ArtifactExample.evm.deployedBytecode.immutableReferences,
)) {
  for (const { start, length } of ranges) {
    code =
      `${code.slice(0, 2 + start * 2)}${encodeAbiParameters([{ type: "uint256" }], [42n]).slice(2)}${code.slice(2 + (start + length) * 2)}` as Hex;
  }
}
const material: CompiledSolidityArtifact = prepared.compile({
  initCodeHash: prepared.initCodeHash,
  code,
});
if (
  material.expectedRuntimeCodeHash !== keccak256(code) ||
  material.provenance.libraries["ArtifactExample.sol:ArtifactMath"] !== library
)
  throw new Error("artifact_material_mismatch");
const manifest = parseManifestText(
  JSON.stringify({
    version: "moesi.manifest/v6",
    contracts: [
      {
        kind: "managed",
        id: "artifact",
        deployment: {
          kind: "create2-factory-v1",
          salt: `0x${"22".repeat(32)}`,
          initCode: material.initCode,
          value: "0",
          requiresRuntime: [],
        },
        expectedRuntimeCodeHash: material.expectedRuntimeCodeHash,
        checks: [],
        storageChecks: [],
        configuration: [],
      },
    ],
  }),
);
if (
  manifest.contracts.length !== 1 ||
  material.version !== "moesi.compiled-artifact/v1" ||
  material.provenance.runtime !== "evaluated"
)
  throw new Error("artifact_export_failed");
