import type { Address } from "cetane";
import type { AbiFunction, FunctionResult } from "cetane/utils";
import { MoesiManifestError } from "../errors.js";
import { compareAscii, deepFreeze, hashCanonical, snapshotArray } from "../internal.js";
import { parseManifest } from "../manifest/parse.js";
import { deriveResourceAddress } from "../manifest/target.js";
import {
  type ConfigurationRule,
  type ManifestContractResource,
  type ManifestSender,
  MOESI_MANIFEST_VERSION,
  type ResolvedMoesiManifest,
} from "../manifest/types.js";
import {
  observationCause,
  throwIfObservationStopped,
  withObservationAbort,
} from "../observation/failure.js";
import { captureChainSnapshot, observeCall } from "../observation/observe.js";
import { bindObservationSignal } from "../observation/signal.js";
import type { ChainSnapshot } from "../observation/types.js";
import { MAX_PLAN_CHAINS } from "../planning/types.js";
import { compileFleetRule, decodeFleetRead, encodeFleetCall } from "./calls.js";
import { MoesiFleetError } from "./errors.js";
import type {
  CompiledFleetGroup,
  FleetAccounts,
  FleetBuilder,
  FleetCompileOptions,
  FleetContext,
  FleetContracts,
  FleetDefinition,
  FleetReadEvidence,
} from "./types.js";

const ID = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,126}[a-zA-Z0-9])?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Author callbacks run only during compilation. Returned groups contain JSON-safe literals. */
export function defineFleet<
  const C extends FleetContracts,
  const A extends FleetAccounts = Record<never, never>,
>(definition: FleetDefinition<C, A>): FleetBuilder {
  return Object.freeze({
    async compile(options: FleetCompileOptions = {}) {
      try {
        return await withObservationAbort(options.signal, () => compile(definition, options));
      } catch (error) {
        throwIfObservationStopped(error);
        if (error instanceof MoesiFleetError || error instanceof MoesiManifestError) throw error;
        throw new MoesiFleetError("authoring_failed");
      }
    },
  });
}

async function compile<C extends FleetContracts, A extends FleetAccounts>(
  definition: FleetDefinition<C, A>,
  options: FleetCompileOptions,
): Promise<readonly CompiledFleetGroup[]> {
  const inputChains = snapshotArray(definition.chains);
  const ids = Object.keys(definition.contracts).sort(compareAscii);
  if (
    !inputChains ||
    inputChains.length === 0 ||
    inputChains.length > 1024 ||
    ids.length === 0 ||
    ids.some((id) => !ID.test(id)) ||
    inputChains.some(
      (chain) => typeof chain !== "number" || !Number.isSafeInteger(chain) || chain <= 0,
    ) ||
    new Set(inputChains).size !== inputChains.length
  )
    throw new MoesiFleetError("invalid_fleet");
  const chains = (inputChains as number[]).sort((a, b) => a - b);
  const requested = options.chains === undefined ? chains : snapshotArray(options.chains);
  if (
    !requested ||
    requested.length === 0 ||
    requested.some((chain) => typeof chain !== "number" || !chains.includes(chain)) ||
    new Set(requested).size !== requested.length
  )
    throw new MoesiFleetError("invalid_fleet");
  const selected = (requested as number[]).sort((a, b) => a - b);
  const declarations = Object.fromEntries(
    ids.map((id) => {
      const item = definition.contracts[id]!;
      return [
        id,
        {
          abi: deepFreeze(structuredClone(item.abi)),
          resource:
            typeof item.resource === "function"
              ? item.resource
              : deepFreeze(structuredClone(item.resource)),
        },
      ];
    }),
  );
  const accountDeclarations = Object.fromEntries(
    Object.entries(definition.accounts ?? {}).map(([name, item]) => [
      name,
      typeof item === "function" ? item : deepFreeze(structuredClone(item)),
    ]),
  );
  const configure = definition.configure;

  const resources = new Map<
    string,
    { resource: ManifestContractResource; address: Address } | null
  >();
  const building = new Set<string>();
  const accounts = new Map<string, ManifestSender>();
  const pins = new Map<number, Promise<ChainSnapshot>>();
  const reads = new Map<string, Promise<FleetReadEvidence>>();
  const observer = options.observer
    ? bindObservationSignal(options.observer, options.signal)
    : undefined;

  function account(chainId: number, name: string): ManifestSender {
    const key = `${chainId}:${name}`;
    const existing = accounts.get(key);
    if (existing) return existing;
    const declaration = Object.hasOwn(accountDeclarations, name)
      ? accountDeclarations[name]
      : undefined;
    const value = typeof declaration === "function" ? declaration(chainId) : declaration;
    if (
      !value ||
      !ADDRESS.test(value.address) ||
      !["owner-eoa", "smart-account"].includes(value.kind) ||
      Object.keys(value).some(
        (key) =>
          !["kind", "address", ...(value.kind === "smart-account" ? ["accountId"] : [])].includes(
            key,
          ),
      ) ||
      (value.kind === "smart-account" &&
        !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.accountId))
    )
      throw new MoesiFleetError("account_unavailable");
    const owned = deepFreeze({ ...value, address: value.address.toLowerCase() as Address });
    accounts.set(key, owned);
    return owned;
  }

  function resource(
    chainId: number,
    id: string,
  ): { resource: ManifestContractResource; address: Address } | null {
    if (!chains.includes(chainId) || !ids.includes(id))
      throw new MoesiFleetError("resource_unavailable");
    const key = `${chainId}:${id}`;
    if (resources.has(key)) return resources.get(key)!;
    if (building.has(key)) throw new MoesiFleetError("resource_dependency_cycle");
    building.add(key);
    try {
      const declaration = declarations[id]!;
      const value =
        typeof declaration.resource === "function"
          ? declaration.resource(chainId, {
              account: (name) => account(chainId, name),
              address: (name) => requiredResource(chainId, name).address,
            })
          : declaration.resource;
      if (value === null) {
        resources.set(key, null);
        return null;
      }
      const source = deepFreeze(
        structuredClone({
          checks: [],
          storageChecks: [],
          semanticChecks: [],
          ...value,
          id,
          ...(value.kind === "managed" ? { configuration: [] } : {}),
        } as ManifestContractResource),
      );
      // Validate prediction fields now. The full manifest validates runtime prerequisites and
      // cross-resource semantic references after the complete resource graph has been built.
      const prediction = parseManifest({
        version: MOESI_MANIFEST_VERSION,
        contracts: [
          {
            ...source,
            checks: [],
            storageChecks: [],
            semanticChecks: [],
            ...(source.kind === "managed"
              ? { configuration: [], deployment: { ...source.deployment, requiresRuntime: [] } }
              : {}),
          } as ManifestContractResource,
        ],
      });
      const result = { resource: source, address: deriveResourceAddress(prediction.contracts[0]!) };
      resources.set(key, result);
      return result;
    } finally {
      building.delete(key);
    }
  }
  function requiredResource(chainId: number, id: string) {
    const result = resource(chainId, id);
    if (!result) throw new MoesiFleetError("resource_unavailable");
    return result;
  }

  const groups = new Map<
    string,
    { manifest: ResolvedMoesiManifest; chains: number[]; reads: Map<string, FleetReadEvidence> }
  >();
  for (const chainId of selected) {
    const source = ids.flatMap((id) => {
      const found = resource(chainId, id);
      return found ? [found.resource] : [];
    });
    if (source.length === 0) continue;
    const readKeys = new Set<string>();
    const context: FleetContext<C, A> = {
      has: (id) => resource(chainId, id) !== null,
      address: (id) => requiredResource(chainId, id).address,
      account: (name) => account(chainId, name),
      deployedOn(peerChainId, id) {
        const peer = requiredResource(peerChainId, id);
        return {
          chainId: peerChainId,
          address: peer.address,
          expectedRuntimeCodeHash: peer.resource.expectedRuntimeCodeHash,
        };
      },
      contract(id) {
        const found = requiredResource(chainId, id);
        return {
          id,
          address: found.address,
          rule: (input) => compileFleetRule(declarations[id]!.abi as C[typeof id]["abi"], input),
        };
      },
      async read(request) {
        if (!observer) throw new MoesiFleetError("observer_required");
        if (
          !Number.isSafeInteger(request.chainId) ||
          request.chainId <= 0 ||
          !ADDRESS.test(request.address) ||
          !ADDRESS.test(request.caller)
        )
          throw new MoesiFleetError("invalid_live_read");
        const call = encodeFleetCall(request.abi, request.functionName, request.args, "read");
        const identity = {
          chainId: request.chainId,
          address: request.address.toLowerCase() as Address,
          caller: request.caller.toLowerCase() as Address,
          data: call.data,
        };
        const key = hashCanonical(identity);
        readKeys.add(key);
        let pending = reads.get(key);
        if (!pending) {
          pending = (async () => {
            try {
              let pin = pins.get(request.chainId);
              if (!pin) {
                pin = captureChainSnapshot(observer, request.chainId);
                pins.set(request.chainId, pin);
              }
              const snapshot = await pin;
              const observation = await observeCall(observer, {
                chainId: identity.chainId,
                caller: identity.caller,
                data: identity.data,
                target: identity.address,
                snapshot,
              });
              if (observation.kind === "unreadable")
                throw new MoesiFleetError("live_read_failed", observation.cause);
              return { ...identity, snapshot, result: observation.result };
            } catch (error) {
              throwIfObservationStopped(error);
              if (error instanceof MoesiFleetError) throw error;
              throw new MoesiFleetError("live_read_failed", observationCause(error) ?? undefined);
            }
          })();
          reads.set(key, pending);
        }
        const evidence = await pending;
        return decodeFleetRead(call.fn as AbiFunction, evidence.result) as FunctionResult<
          typeof request.abi,
          typeof request.functionName
        >;
      },
    };
    const configuration: Readonly<Record<string, readonly ConfigurationRule[] | undefined>> =
      (await configure?.(chainId, context)) ?? {};
    if (typeof configuration !== "object" || configuration === null || Array.isArray(configuration))
      throw new MoesiFleetError("invalid_fleet");
    for (const id of Object.keys(configuration)) {
      if (requiredResource(chainId, id).resource.kind !== "managed")
        throw new MoesiFleetError("resource_unavailable");
    }
    const parsed = parseManifest({
      version: MOESI_MANIFEST_VERSION,
      contracts: source.map((contract) =>
        contract.kind === "managed"
          ? { ...contract, configuration: configuration[contract.id] ?? [] }
          : contract,
      ),
    });
    const manifest = { version: parsed.version, contracts: parsed.contracts };
    let group = groups.get(parsed.manifestHash);
    if (!group) {
      group = { manifest, chains: [], reads: new Map() };
      groups.set(parsed.manifestHash, group);
    }
    group.chains.push(chainId);
    for (const key of readKeys) group.reads.set(key, await reads.get(key)!);
  }
  return deepFreeze(
    [...groups.values()].flatMap((group) => {
      const result: CompiledFleetGroup[] = [];
      for (let start = 0; start < group.chains.length; start += MAX_PLAN_CHAINS)
        result.push({
          manifest: group.manifest,
          chains: group.chains.slice(start, start + MAX_PLAN_CHAINS),
          reads: [...group.reads.entries()]
            .sort(([a], [b]) => compareAscii(a, b))
            .map(([, value]) => value),
        });
      return result;
    }),
  );
}
