import { describe, expect, it } from "vitest";
import {
  buildNicksTx,
  MoesiManifestError,
  NICKS_DEFAULT_R,
  NICKS_DEFAULT_S,
  NICKS_DEFAULT_V,
  type NicksTxParams,
  predictNicksAddress,
  recoverNicksDeployer,
  validateNicksAddress,
} from "../src/index.js";

// The real presigned deployment of the Arachnid deterministic deployment
// proxy — the same factory create2-factory-v1 is closed over. Expected
// values are the exact moesi@0.12.0 outputs (issue #28).
const ARACHNID_PARAMS: NicksTxParams = {
  initCode:
    "0x604580600e600039806000f350fe7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3",
  gasPrice: 100_000_000_000n,
  gasLimit: 100_000n,
  value: 0n,
  v: 27n,
  r: "0x2222222222222222222222222222222222222222222222222222222222222222",
  s: "0x2222222222222222222222222222222222222222222222222222222222222222",
};
const ARACHNID_DEPLOYER = "0x3fAB184622Dc19b6109349B94811493BF2a45362";
const ARACHNID_FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";

describe("Nick's-method deployment primitives", () => {
  it("recovers the Arachnid keyless deployer from the presigned fields", async () => {
    await expect(recoverNicksDeployer(ARACHNID_PARAMS)).resolves.toBe(ARACHNID_DEPLOYER);
  });

  it("predicts the deployer's nonce-0 CREATE address", () => {
    expect(predictNicksAddress(ARACHNID_DEPLOYER)).toBe(ARACHNID_FACTORY);
    expect(predictNicksAddress(ARACHNID_DEPLOYER.toLowerCase() as `0x${string}`)).toBe(
      ARACHNID_FACTORY,
    );
  });

  it("builds the exact presigned raw transaction bytes", () => {
    const raw = buildNicksTx(ARACHNID_PARAMS);
    expect(raw.startsWith("0xf8a58085174876e800830186a08080b853604580600e")).toBe(true);
    expect(raw.endsWith(`1ba0${NICKS_DEFAULT_R.slice(2)}a0${NICKS_DEFAULT_S.slice(2)}`)).toBe(true);
  });

  it("validates a claimed address against the recovered deployer", async () => {
    await expect(validateNicksAddress(ARACHNID_FACTORY, ARACHNID_PARAMS)).resolves.toEqual({
      isValid: true,
      expectedAddress: ARACHNID_FACTORY,
      deployer: ARACHNID_DEPLOYER,
    });
    const mismatch = await validateNicksAddress(
      "0x1111111111111111111111111111111111111111",
      ARACHNID_PARAMS,
    );
    expect(mismatch.isValid).toBe(false);
    expect(mismatch.expectedAddress).toBe(ARACHNID_FACTORY);
  });

  it("applies the canonical default signature and gas fields", async () => {
    const defaults = { initCode: ARACHNID_PARAMS.initCode };
    const explicit = {
      ...defaults,
      gasPrice: 100_000_000_000n,
      gasLimit: 250_000n,
      value: 0n,
      v: NICKS_DEFAULT_V,
      r: NICKS_DEFAULT_R,
      s: NICKS_DEFAULT_S,
    };
    expect(buildNicksTx(defaults)).toBe(buildNicksTx(explicit));
    await expect(recoverNicksDeployer(defaults)).resolves.toBe(
      await recoverNicksDeployer(explicit),
    );
  });

  it("rejects malformed fields once at the boundary", async () => {
    const failures: NicksTxParams[] = [
      { initCode: "0x" },
      { initCode: "0x123" as `0x${string}` },
      { initCode: "zz" as `0x${string}` },
      { ...ARACHNID_PARAMS, gasPrice: -1n },
      { ...ARACHNID_PARAMS, v: (1n << 256n) as bigint },
      { ...ARACHNID_PARAMS, r: `0x${"0".repeat(64)}` as `0x${string}` },
      { ...ARACHNID_PARAMS, s: "0x22" as `0x${string}` },
    ];
    for (const params of failures) {
      expect(() => buildNicksTx(params)).toThrow(MoesiManifestError);
    }
    expect(() => predictNicksAddress("0x123" as `0x${string}`)).toThrow(MoesiManifestError);
    await expect(
      validateNicksAddress("not-an-address" as `0x${string}`, ARACHNID_PARAMS),
    ).rejects.toThrow(MoesiManifestError);
  });
});
