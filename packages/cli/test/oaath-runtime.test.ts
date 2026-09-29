import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCliOAAthRuntime } from "../src/oaath-runtime.js";

describe("caller-owned SDK module lifecycle", () => {
  it("passes owner/account options and explains that an owner client needs no permission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moesi-owner-client-"));
    try {
      const marker = join(directory, "opened");
      const module = join(directory, "client.mjs");
      await writeFile(
        module,
        `import { writeFile } from "node:fs/promises";
export function openOAAth() {
  const address = "0x4444444444444444444444444444444444444444";
  return {
    oaath: {
      account(value) { if (value !== address) throw new Error("account changed"); return { address, owner(wallet) { if (wallet.account.address !== address) throw new Error("wallet changed"); return {}; } }; },
      close: () => writeFile(${JSON.stringify(marker)}, "closed"),
    },
    account: { address }, owner: { account: { address } }, signer: "owner", sender: "bundler",
  };
}`,
      );
      const runtime = await createCliOAAthRuntime(module);
      expect(runtime.provider.id).toBe("oaath");
      await expect(runtime.authorize({} as never, "per-chain")).rejects.toMatchObject({
        code: "oaath_permission_unavailable",
      });
      await runtime.close();
      expect(await readFile(marker, "utf8")).toBe("closed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("loads the explicit factory and closes its SDK without revoking", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moesi-client-"));
    try {
      const marker = join(directory, "closed");
      const module = join(directory, "client.mjs");
      await writeFile(
        module,
        `import { writeFile } from "node:fs/promises";
export async function openOAAth() { return { oaath: Object.freeze({
  connect: async () => { throw new Error("unexpected_connection"); },
  close: async () => writeFile(${JSON.stringify(marker)}, "closed"),
  disconnect: async () => { throw new Error("unexpected_revocation"); },
}) }; }`,
      );
      const runtime = await createCliOAAthRuntime(module);
      expect(runtime.provider.id).toBe("oaath");
      await runtime.close();
      expect(await readFile(marker, "utf8")).toBe("closed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes a client rejected by the adapter and hides module failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moesi-client-"));
    try {
      const marker = join(directory, "closed");
      const module = join(directory, "invalid.mjs");
      await writeFile(
        module,
        `import { writeFile } from "node:fs/promises";
export async function openOAAth() { return { oaath: { close: async () => writeFile(${JSON.stringify(marker)}, "closed") } }; }`,
      );
      await expect(createCliOAAthRuntime(module)).rejects.toMatchObject({
        code: "oaath_client_invalid",
      });
      expect(await readFile(marker, "utf8")).toBe("closed");
      const broken = join(directory, "broken.mjs");
      await writeFile(broken, 'throw new Error("private module diagnostic");');
      await expect(createCliOAAthRuntime(broken)).rejects.toMatchObject({
        code: "oaath_client_invalid",
        message: "OAAth client module could not be opened",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("sanitizes SDK cleanup errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "moesi-client-"));
    try {
      const module = join(directory, "client.mjs");
      await writeFile(
        module,
        'export function openOAAth() { return { oaath: { connect: async () => {}, close: async () => { throw new Error("private cleanup diagnostic"); } } }; }',
      );
      const runtime = await createCliOAAthRuntime(module);
      await expect(runtime.close()).rejects.toMatchObject({
        code: "oaath_cleanup_failed",
        message: "OAAth client close failed",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
