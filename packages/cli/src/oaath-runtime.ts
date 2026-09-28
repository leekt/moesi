import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MoesiExecutionProvider, ReviewedPlan } from "moesi";
import { CliError } from "./errors.js";

export interface CliOAAthPermission {
  readonly status: "requested" | "reused";
  readonly grantReference: string;
}
export interface CliOAAthRuntime {
  readonly provider: MoesiExecutionProvider;
  readonly authorize: (plan: ReviewedPlan) => Promise<CliOAAthPermission>;
  readonly close: () => Promise<void>;
}
export type CliOAAthRuntimeFactory = (clientModule: string) => Promise<CliOAAthRuntime>;

/** The explicit local module owns SDK composition and durable stores. */
export const createCliOAAthRuntime: CliOAAthRuntimeFactory = async (clientModule) => {
  const adapter = await import("@moesi/oaath").catch(() => {
    throw new CliError("oaath_adapter_unavailable", "install the optional OAAth adapter");
  });
  let client: Parameters<typeof adapter.createOAAthExecutionProvider>[0]["oaath"];
  let close: () => Promise<void>;
  try {
    const module: unknown = await import(pathToFileURL(resolve(clientModule)).href);
    const open: unknown = Reflect.get(module as object, "openOAAth");
    if (typeof open !== "function") throw new Error("invalid_factory");
    client = await open();
    const method = Object.getOwnPropertyDescriptor(client, "close")?.value;
    if (typeof method !== "function") throw new Error("invalid_client");
    close = async () => {
      await method.call(client);
    };
  } catch {
    throw new CliError("oaath_client_invalid", "OAAth client module could not be opened");
  }
  try {
    const provider = adapter.createOAAthExecutionProvider({ oaath: client });
    return Object.freeze({
      provider,
      async authorize(plan: ReviewedPlan) {
        try {
          return await adapter.requestOAAthPlanPermission({ oaath: client, plan });
        } catch {
          throw new CliError("oaath_permission_failed", "OAAth permission request failed");
        }
      },
      async close() {
        try {
          await close();
        } catch {
          throw new CliError("oaath_cleanup_failed", "OAAth client close failed");
        }
      },
    });
  } catch {
    await close().catch(() => {});
    throw new CliError("oaath_client_invalid", "OAAth client is invalid");
  }
};
