import { createPublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";
import { MoesiRpcEndpointError } from "../src/index.js";
import {
  createHttpTransport,
  createViemObserver,
  MoesiRpcTransportError,
  redactRpcUrl,
  rpcEndpoint,
} from "../src/viem/index.js";

// Exact outputs of moesi@0.12.0 `parseRpcUrl` / `redactRpcUrl` for these URLs.
const PARITY = [
  {
    input: "https://user:pass@rpc.example.com/path?x=1",
    url: "https://rpc.example.com/path?x=1",
    authorization: "Basic dXNlcjpwYXNz",
    redacted: "https://rpc.example.com/path?x=1",
  },
  {
    input: "https://us%40er:p%3Ass%20w@rpc.example.com/",
    url: "https://rpc.example.com/",
    authorization: "Basic dXNAZXI6cDpzcyB3",
    redacted: "https://rpc.example.com/",
  },
  {
    input: "https://ユーザー:秘密@rpc.example.com/",
    url: "https://rpc.example.com/",
    authorization: "Basic 44Om44O844K244O8OuenmOWvhg==",
    redacted: "https://rpc.example.com/",
  },
  {
    input: "https://user@rpc.example.com/",
    url: "https://rpc.example.com/",
    authorization: "Basic dXNlcjo=",
    redacted: "https://rpc.example.com/",
  },
  {
    input: "https://rpc.example.com/v2/abc",
    url: "https://rpc.example.com/v2/abc",
    authorization: null,
    redacted: "https://rpc.example.com/v2/abc",
  },
  {
    input: "https://mainnet.infura.io/v3/0123456789abcdef",
    url: "https://mainnet.infura.io/v3/0123456789abcdef",
    authorization: null,
    redacted: "https://mainnet.infura.io/v3/[REDACTED]",
  },
  {
    input: "https://rpc.example.com/?apikey=secret&chain=1&API_KEY=s2&token=t&project-id=p",
    url: "https://rpc.example.com/?apikey=secret&chain=1&API_KEY=s2&token=t&project-id=p",
    authorization: null,
    redacted:
      "https://rpc.example.com/?apikey=%5BREDACTED%5D&chain=1&API_KEY=%5BREDACTED%5D&token=%5BREDACTED%5D&project-id=%5BREDACTED%5D",
  },
  {
    input: "https://u:p@node.example.com:8545/V3/key/extra?key=k#frag",
    url: "https://node.example.com:8545/V3/key/extra?key=k#frag",
    authorization: "Basic dTpw",
    redacted: "https://node.example.com:8545/V3/[REDACTED]/extra?key=%5BREDACTED%5D#frag",
  },
] as const;

function rpcResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rpcEndpoint and redactRpcUrl", () => {
  it.each(PARITY)("matches 0.12 for $input", ({ input, url, authorization, redacted }) => {
    const endpoint = rpcEndpoint(input);
    expect(endpoint).toEqual({
      url,
      headers: authorization === null ? {} : { Authorization: authorization },
    });
    expect(Object.isFrozen(endpoint) && Object.isFrozen(endpoint.headers)).toBe(true);
    expect(redactRpcUrl(input)).toBe(redacted);
  });

  it("rejects invalid, non-HTTP and malformed credential URLs without echoing them", () => {
    for (const url of [
      "not a url secret-token",
      "wss://user:secret@rpc.example.com",
      "file:///secret",
      "https://%E0%A4%A:secret@rpc.example.com/",
      42,
    ]) {
      try {
        rpcEndpoint(url as never);
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(MoesiRpcEndpointError);
        expect(error).toMatchObject({ code: "invalid_rpc_url" });
        expect((error as Error).message).not.toContain("secret");
      }
    }
  });

  it("redacts unparseable input wholesale", () => {
    expect(redactRpcUrl("user:secret@not a url")).toBe("[REDACTED]");
    expect(redactRpcUrl(7 as never)).toBe("[REDACTED]");
    expect(redactRpcUrl("mailto:secret@example.com")).toBe("[REDACTED]");
    expect(redactRpcUrl("wss://u:p@rpc.example.com/v3/k")).toBe(
      "wss://rpc.example.com/v3/[REDACTED]",
    );
  });
});

describe("createHttpTransport", () => {
  it("sends userinfo as an Authorization header over a credential-free URL", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      rpcResponse({ jsonrpc: "2.0", id: 0, result: "0x1" }),
    );
    const client = createPublicClient({
      transport: createHttpTransport("https://alice:s3cret@rpc.example.com/rpc", {
        fetchFn,
        fetchOptions: { headers: { "x-trace": "1", authorization: "Bearer caller" } },
        retryCount: 0,
      }),
    });
    await expect(client.getChainId()).resolves.toBe(1);
    const [input, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://rpc.example.com/rpc");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa("alice:s3cret")}`);
    expect(headers.get("x-trace")).toBe("1");
  });

  it("scrubs HTTP failures of URLs, bodies and causes", async () => {
    const client = createPublicClient({
      transport: createHttpTransport("https://alice:s3cret@rpc.example.com/v3/key123", {
        fetchFn: async () => new Response("upstream leaked s3cret key123", { status: 502 }),
        retryCount: 0,
      }),
    });
    const error = await client.getChainId().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MoesiRpcTransportError);
    expect(error).toMatchObject({ category: "http", status: 502, rpcCode: null, rpcData: null });
    const serialized = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
    for (const secret of ["s3cret", "key123", "alice", "rpc.example.com", "upstream"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(Object.hasOwn(error as object, "cause")).toBe(false);
  });

  it("keeps JSON-RPC codes and revert data but drops provider prose", async () => {
    const data = "0x08c379a0" as const;
    const client = createPublicClient({
      transport: createHttpTransport("https://rpc.example.com/", {
        fetchFn: async () =>
          rpcResponse({
            jsonrpc: "2.0",
            id: 0,
            error: { code: 3, message: "execution reverted: s3cret", data },
          }),
        retryCount: 0,
      }),
    });
    const error = await client
      .request({ method: "eth_call", params: [{ to: `0x${"11".repeat(20)}` }, "latest"] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "rpc", status: null, rpcCode: 3, rpcData: data });
    expect(String(error)).not.toContain("s3cret");
  });
});

describe("createViemObserver with credentialed endpoints", () => {
  it("reads through the stripped URL with an Authorization header", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const observer = createViemObserver({
      chains: { 1: { rpcUrls: ["https://bob:pw@rpc.example.com/"] } },
      fetchFn: async (input, init) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        const request = JSON.parse(String(init?.body)) as { id: number; method: string };
        const result =
          request.method === "eth_chainId"
            ? "0x1"
            : { number: "0x5", hash: `0x${"ab".repeat(32)}`, parentHash: `0x${"cd".repeat(32)}` };
        return rpcResponse({ jsonrpc: "2.0", id: request.id, result });
      },
    });
    await expect(observer.captureSnapshot(1)).resolves.toMatchObject({ blockNumber: "5" });
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request).toEqual({
        url: "https://rpc.example.com/",
        authorization: `Basic ${btoa("bob:pw")}`,
      });
    }
  });

  it("rejects malformed endpoints as invalid observer configuration", () => {
    expect(() =>
      createViemObserver({ chains: { 1: { rpcUrls: ["wss://rpc.example.com"] } } }),
    ).toThrow(expect.objectContaining({ code: "invalid_observer_configuration" }));
  });
});
