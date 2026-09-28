import { type Address, concatHex, encodeAbiParameters, type Hex, keccak256, padHex } from "viem";
import { MoesiManifestError } from "../errors.js";
import { deepFreeze } from "../internal.js";
import { type ParsedManifest, parseManifest } from "../manifest/parse.js";
import { deriveResourceAddress } from "../manifest/target.js";
import { type ManifestContractResource, MOESI_MANIFEST_VERSION } from "../manifest/types.js";
import {
  CHECKED_BEACON_INIT_CODE,
  CHECKED_BEACON_RUNTIME,
  CHECKED_PROXY_BEACON_OFFSETS,
  CHECKED_PROXY_INIT_CODE,
  CHECKED_PROXY_RUNTIME,
} from "./proxy-artifacts.js";

export interface CheckedBeaconProxyInput {
  /** Creates resources named `<id>.beacon` and `<id>.proxy`. */
  readonly id: string;
  readonly beaconSalt: Hex;
  readonly proxySalt: Hex;
  /** Explicit EOA owner. The selected provider must review this exact sender. */
  readonly owner: Address;
  /** Exact managed or external implementation resources, including dependencies. */
  readonly implementations: readonly ManifestContractResource[];
  /** Fixed constructor identity. Changing it changes the deterministic addresses. */
  readonly initialImplementationId: string;
  /** Changes only desired checks and guarded upgrade calldata, not constructor identity. */
  readonly desiredImplementationId: string;
  /** Nonempty initializer with an explicit selector. Its semantics require caller review. */
  readonly initializationData: Hex;
}

export interface CompiledCheckedBeaconProxy {
  readonly manifest: ParsedManifest;
  readonly beaconAddress: Address;
  readonly proxyAddress: Address;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,118}[a-zA-Z0-9])?$/;
const KEYS = [
  "id",
  "beaconSalt",
  "proxySalt",
  "owner",
  "implementations",
  "initialImplementationId",
  "desiredImplementationId",
  "initializationData",
];

/**
 * Closed CREATE2 strategy for the shipped checked beacon contracts. Produces
 * ordinary current manifests, exact calls and semantic assertions. No RPC,
 * signing, initializer interpretation or storage-layout validation occurs here.
 */
export function compileCheckedBeaconProxy(
  input: CheckedBeaconProxyInput,
): CompiledCheckedBeaconProxy {
  try {
    if (!input || typeof input !== "object") throw new Error();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new Error();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== KEYS.length ||
      keys.some((key) => typeof key !== "string" || !KEYS.includes(key))
    )
      throw new Error();
    const captured = Object.fromEntries(KEYS.map((key) => [key, Reflect.get(input, key)]));
    const {
      id,
      beaconSalt,
      proxySalt,
      owner,
      initialImplementationId,
      desiredImplementationId,
      initializationData,
    } = captured;
    if (
      typeof id !== "string" ||
      !ID.test(id) ||
      typeof owner !== "string" ||
      !ADDRESS.test(owner) ||
      owner.toLowerCase() === ZERO_ADDRESS ||
      typeof beaconSalt !== "string" ||
      !WORD.test(beaconSalt) ||
      typeof proxySalt !== "string" ||
      !WORD.test(proxySalt) ||
      typeof initialImplementationId !== "string" ||
      typeof desiredImplementationId !== "string" ||
      typeof initializationData !== "string" ||
      initializationData.length > 16_386 ||
      !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(initializationData)
    )
      throw new Error();
    const entries = captured.implementations;
    if (!Array.isArray(entries)) throw new Error();
    const length = Reflect.get(entries, "length");
    if (!Number.isSafeInteger(length) || length < 1 || length > 64) throw new Error();
    const implementations: ManifestContractResource[] = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.hasOwn(entries, index)) throw new Error();
      implementations.push(Reflect.get(entries, String(index)));
    }
    const source = parseManifest({ version: MOESI_MANIFEST_VERSION, contracts: implementations });
    const initial = source.contracts.find(({ id }) => id === initialImplementationId);
    const desired = source.contracts.find(({ id }) => id === desiredImplementationId);
    if (!initial || !desired) throw new Error();
    const initialAddress = deriveResourceAddress(initial);
    const desiredAddress = deriveResourceAddress(desired);
    const capturedOwner = owner.toLowerCase() as Address;
    const beaconHash = keccak256(CHECKED_BEACON_RUNTIME);
    const beacon = {
      kind: "managed",
      id: `${id}.beacon`,
      deployment: {
        kind: "create2-factory-v1",
        salt: beaconSalt as Hex,
        initCode: concatHex([
          CHECKED_BEACON_INIT_CODE,
          encodeAbiParameters(
            [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
            [initialAddress, capturedOwner, initial.expectedRuntimeCodeHash],
          ),
        ]),
        value: "0",
        requiresRuntime: [...new Set([initial.id, desired.id])],
      },
      sender: { kind: "owner-eoa", address: capturedOwner },
      expectedRuntimeCodeHash: beaconHash,
      configuration: [
        {
          id: "implementation",
          readData: "0x5c60da1b",
          expectedResult: padHex(desiredAddress, { size: 32 }),
          writeData: concatHex([
            keccak256(new TextEncoder().encode("upgradeToChecked(address,bytes32)")).slice(
              0,
              10,
            ) as Hex,
            encodeAbiParameters(
              [{ type: "address" }, { type: "bytes32" }],
              [desiredAddress, desired.expectedRuntimeCodeHash],
            ),
          ]),
          value: "0",
        },
      ],
      checks: [],
      storageChecks: [],
      semanticChecks: [
        { kind: "ownable-owner", id: "owner", caller: capturedOwner, expectedOwner: capturedOwner },
      ],
    } as const;
    const beaconAddress = deriveResourceAddress(beacon);
    let proxyRuntime: Hex = CHECKED_PROXY_RUNTIME;
    const beaconWord = padHex(beaconAddress, { size: 32 }).slice(2);
    for (const start of CHECKED_PROXY_BEACON_OFFSETS) {
      const offset = 2 + start * 2;
      proxyRuntime =
        `${proxyRuntime.slice(0, offset)}${beaconWord}${proxyRuntime.slice(offset + 64)}` as Hex;
    }
    const proxy = {
      kind: "managed",
      id: `${id}.proxy`,
      deployment: {
        kind: "create2-factory-v1",
        salt: proxySalt as Hex,
        initCode: concatHex([
          CHECKED_PROXY_INIT_CODE,
          encodeAbiParameters(
            [
              { type: "address" },
              { type: "bytes32" },
              { type: "address" },
              { type: "bytes32" },
              { type: "bytes" },
            ],
            [
              beaconAddress,
              beaconHash,
              initialAddress,
              initial.expectedRuntimeCodeHash,
              initializationData as Hex,
            ],
          ),
        ]),
        value: "0",
        requiresRuntime: [beacon.id, initial.id],
      },
      sender: { kind: "owner-eoa", address: capturedOwner },
      expectedRuntimeCodeHash: keccak256(proxyRuntime),
      configuration: [],
      checks: [],
      storageChecks: [],
      semanticChecks: [
        {
          kind: "erc1967-beacon",
          id: "beacon",
          caller: capturedOwner,
          expectedBeacon: beaconAddress,
          expectedImplementation: desiredAddress,
          expectedAdmin: ZERO_ADDRESS,
        },
      ],
    } as const;
    const manifest = parseManifest({
      version: MOESI_MANIFEST_VERSION,
      contracts: [...source.contracts, beacon, proxy],
    });
    return deepFreeze({ manifest, beaconAddress, proxyAddress: deriveResourceAddress(proxy) });
  } catch {
    throw new MoesiManifestError(
      "invalid_deployment",
      "checkedBeaconProxy",
      "checked beacon proxy input is invalid",
    );
  }
}
