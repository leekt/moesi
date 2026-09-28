# Compiler artifacts to literal manifests

`prepareSolidityArtifact` imports a full Foundry artifact, a solc contract output,
or a Hardhat 3 artifact. It captures the input, links both creation and runtime
bytecode, validates constructor arguments, and produces immutable creation bytes.
It does not read files, contact RPCs, deploy contracts, or adopt live state.

```ts
import { prepareSolidityArtifact } from "moesi";

const prepared = prepareSolidityArtifact({
  artifact, // parsed compiler JSON; retain ABI and both bytecode objects
  constructorArgs: [owner, 42n],
  libraries: { "src/Math.sol:Math": mathAddress },
});

// For static runtime, this supplies the literal fields needed by a manifest:
const material = prepared.compile();
// deployment.initCode = material.initCode
// expectedRuntimeCodeHash = material.expectedRuntimeCodeHash
```

Library keys are fully qualified compiler names, including the source path.
Missing, unused, inconsistent or overlapping links fail before RPC. Linking
fills only the compiler's declared 20-byte references. Post-compilation linking
preserves the original metadata; it does not claim to produce the same bytes as
recompiling with libraries in compiler settings. Keep the resulting provenance
beside the exported manifest.

For an immutable or a Solidity library's embedded self address,
`requiresRuntimeEvaluation` is true and `compile()` fails with
`artifact_runtime_required`. First evaluate `prepared.initCode` in the intended
deployment context using a local chain or another explicitly trusted evaluator:

```ts
const material = prepared.compile({
  initCodeHash: prepared.initCodeHash,
  code: expectedRuntimeFromLocalEvaluation,
});
```

The input hash must match the exact linked creation bytes and encoded arguments.
Runtime length and all bytes outside immutable/self-address ranges must match
the compiler template. Every occurrence of the same immutable must agree.
These checks validate the supplied bytes; they do **not** prove the evaluator
used the right caller, creation address, value, chain state, or constructor reads.
The caller owns that evidence. In particular, a constructor that creates a child
must run at the intended parent address. A generic creation `eth_call` can yield
the wrong child address. Never copy existing live bytecode into desired state to
make a drift check pass.

`CompiledSolidityArtifact` is JSON-safe and carries the current
`moesi.compiled-artifact/v1` version. Its provenance binds the compiler artifact,
compiler metadata when available, Hardhat build ID when available, exact linked
libraries, init-code hash, and whether runtime came from the compiler or explicit
evaluation. Changing constructor inputs changes the init-code hash; changing
compiler metadata changes artifact identity even when executable bytes match.
This helper does not verify a compiler binary or authenticate an artifact file.

Use the full artifact. SRA's former `{ abi, bytecode }` export omits the runtime
information this workflow requires. Hardhat 2 artifact files omit immutable
references: pass the matching solc contract output from build-info instead.
Unknown Hardhat format versions are rejected. Foundry's omitted empty immutable
map is normalized according to its compiler-artifact format. Solc and Hardhat 3
inputs must retain their explicit immutable maps.

Errors are `MoesiArtifactError` with a structured `code` and field `path`.
Diagnostics contain no constructor values or raw compiler errors. In a fleet
builder, prepare constructor-dependent inputs after resolving the referenced
resource addresses. Only literal `initCode` and `expectedRuntimeCodeHash` enter
the manifest; serialize the complete dependency closure to JSON or YAML and
parse it again before planning.

The local Anvil fixture covers a linked library, constructor arguments,
caller-dependent immutables, and a newly created child; its JSON and YAML exports
produce the same reviewed plan, converge and replan without changes. Application
catalog storage and Orchestra's export adapter still need their own cutover.

Format references: [Solidity compiler output](https://docs.soliditylang.org/en/latest/using-the-compiler.html#compiler-input-and-output-json-description),
[Hardhat 3 artifacts](https://hardhat.org/docs/reference/artifacts), and
[Foundry library call protection](https://foundry-rs.github.io/foundry/foundry_common/contracts/index.html).
