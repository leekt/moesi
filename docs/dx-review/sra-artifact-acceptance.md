# SRA compiler artifact acceptance

The artifact helper preserves all seven SRA recipes across 144 managed cells and
39 constructor evaluation contexts. Exact creation bytes match the original
0.9 authoring output. Runtime hashes match fresh local constructor evaluation,
including `SRAFactory`'s newly created child at its actual CREATE2 parent address.
There were no external RPC requests or live transactions.

[The evidence](sra-artifact-evidence.json) records the application commit,
packed core package hash, artifact-helper source hash, fixture hash, original
compiler artifact hashes, and each cell's compiled provenance. The package is
an unpublished exact local 0.14.0 tarball. Compiler files come from the actual
SRA contracts build; their creation bytecode matches the application's stripped
artifacts for all seven names. The full artifacts retain the runtime templates,
library references, immutable ranges, and compiler metadata needed by the helper.

The local phase reuses the constructor procedure from
[the original SRA comparison](sra-comparison-fixture.md). It reads the saved
observation cache and pins from the earlier [live parity run](sra-live-parity.md)
for SenderCreator and Across constructor dependencies, skips live prefetching,
and blocks fetches except HTTP to `127.0.0.1`. A cache miss fails; it does not
refresh a pin or call a public provider. Only local Anvil performs deployments.

For every included chain/recipe, the fixture:

1. Loads the original ABI/creation artifact and full Foundry compiler artifact.
2. Reuses the application's original constructor arguments and predicted
   resource addresses.
3. Prepares the full artifact through the packed public `prepareSolidityArtifact`
   export and checks its creation bytes against the original `encodeDeployData`.
4. Evaluates the constructor locally, using the original factory and address
   whenever creation context affects runtime.
5. Supplies init-code-bound runtime evidence when required, checks all compiler
   template ranges, and compares the resulting runtime hash with local execution.

Foundry omits the empty immutable-reference maps for `ManagedAddressBook` and
`MultiPairChainlinkResolver`; those normalize to static runtime. The other five
recipes require explicit evaluated runtime. No live code was adopted as a new
desired runtime hash.

To repeat this acceptance, install the exact current core tarball as
`moesi-current` beside the original 0.9 application dependencies in an isolated
application checkout. Run the comparison fixture's local constructor phase with
the saved cache, external fetches disabled, and full Foundry artifacts. Insert
these checks around its existing `init` and `runtime` values:

```ts
const prepared = prepareSolidityArtifact({
  artifact: completeArtifacts[name],
  constructorArgs: constructorArgs(name, chain, (id) => oldAddresses[id], DEPLOYER),
});
assert.equal(prepared.initCode, init.toLowerCase());
const material = prepared.compile(prepared.requiresRuntimeEvaluation
  ? { initCodeHash: prepared.initCodeHash, code: runtime }
  : undefined);
assert.equal(material.expectedRuntimeCodeHash, keccak256(runtime));
```

This proves the compiler-to-manifest material for the real SRA recipes. It does
not migrate application storage or execution, and it does not prove Orchestra's
catalog/export adapter. Those remain separate application work.
