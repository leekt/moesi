import { readFileSync, writeFileSync } from "node:fs";
import solc from "solc";

// Test setup only; the packed consumer receives ordinary fixture bytecode.
const source = readFileSync(new URL("../test/fixtures/BeaconVault.sol", import.meta.url), "utf8");
const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources: { "BeaconVault.sol": { content: source } },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: "shanghai",
        outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
      },
    }),
  ),
);
if (output.errors?.some(({ severity }) => severity === "error"))
  throw new Error("proxy_fixture_compilation_failed");
const fixtures = ["BeaconVaultV1", "BeaconVaultV2"].map((name) => ({
  initCode: `0x${output.contracts["BeaconVault.sol"][name].evm.bytecode.object}`,
  runtimeCode: `0x${output.contracts["BeaconVault.sol"][name].evm.deployedBytecode.object}`,
}));
writeFileSync(process.argv[2], JSON.stringify(fixtures));
