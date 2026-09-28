import { keccak256 } from "viem";

// Ten runtime bytes return the ABI word 42. The twelve-byte constructor copies them.
export const manifest = {
  version: "moesi.manifest/v5",
  contracts: [
    {
      kind: "managed",
      id: "answer",
      deployment: {
        kind: "create2-factory-v1",
        salt: `0x${"ab".repeat(32)}`,
        initCode: "0x600a600c600039600a6000f3602a60005260206000f3",
        value: "0",
        requiresRuntime: [],
      },
      expectedRuntimeCodeHash: keccak256("0x602a60005260206000f3"),
      configuration: [],
      checks: [],
      storageChecks: [],
    },
  ],
};
