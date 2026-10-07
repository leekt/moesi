import { type Hex, type HttpOptions, http, type Transport } from "cetane";
import { MoesiRpcEndpointError } from "../errors.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_QUERY_KEY =
  /^(?:api[-_]?key|apikey|key|token|access[-_]?token|auth|authorization|project[-_]?id)$/i;
/** Path segments whose following segment is a provider credential (Infura `/v3/<key>`). */
const SENSITIVE_PATH_PREFIXES = new Set(["v3"]);
const REDACTABLE_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const HEX_PATTERN = /^0x(?:[0-9a-fA-F]{2})*$/;

/** One credential-free RPC URL and the exact headers that carry its credentials. */
export interface RpcEndpoint {
  /** The URL with any userinfo removed. */
  readonly url: string;
  /** `Authorization: Basic …` when the URL embedded userinfo, otherwise empty. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Validate one HTTP(S) RPC URL and move embedded Basic-auth userinfo into an
 * `Authorization` header, as fetch refuses URLs that include credentials.
 * URLs without userinfo are returned unchanged. Errors never include the URL.
 */
export function rpcEndpoint(url: string): RpcEndpoint {
  const parsed = parseHttpUrl(url);
  if (parsed.username === "" && parsed.password === "") {
    return Object.freeze({ url, headers: Object.freeze({}) });
  }
  let credentials: string;
  try {
    credentials = `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`;
  } catch {
    throw new MoesiRpcEndpointError("invalid_rpc_url", "RPC URL credentials are malformed");
  }
  parsed.username = "";
  parsed.password = "";
  return Object.freeze({
    url: parsed.toString(),
    headers: Object.freeze({ Authorization: `Basic ${base64(credentials)}` }),
  });
}

/**
 * Remove URL userinfo, known API-key query values and `/v3/<key>` path
 * segments while keeping the routing information that identifies an endpoint.
 * Unparseable input and non-HTTP(S)/WS(S) URLs are redacted wholesale.
 */
export function redactRpcUrl(url: string): string {
  let parsed: URL;
  try {
    if (typeof url !== "string") throw null;
    parsed = new URL(url);
  } catch {
    return REDACTED;
  }
  // Opaque schemes such as `user:secret@host` keep credentials in their path.
  if (!REDACTABLE_PROTOCOLS.has(parsed.protocol)) return REDACTED;
  parsed.username = "";
  parsed.password = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, REDACTED);
  }
  const segments = parsed.pathname.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    if (SENSITIVE_PATH_PREFIXES.has(segments[index]?.toLowerCase() ?? "")) {
      segments[index + 1] = REDACTED;
    }
  }
  parsed.pathname = segments.join("/");
  return parsed.toString();
}

export type RpcTransportErrorCategory = "http" | "rpc" | "timeout" | "transport";

/**
 * A scrubbed RPC transport failure. It never carries the URL, headers,
 * request or response bodies, or the underlying error; only the HTTP status,
 * JSON-RPC error code and hex revert data survive.
 */
export class MoesiRpcTransportError extends Error {
  readonly category: RpcTransportErrorCategory;
  readonly status: number | null;
  readonly rpcCode: number | null;
  readonly rpcData: Hex | null;

  constructor(input: {
    readonly category: RpcTransportErrorCategory;
    readonly status: number | null;
    readonly rpcCode: number | null;
    readonly rpcData: Hex | null;
  }) {
    super(`RPC request failed (${input.category})`);
    this.name = "MoesiRpcTransportError";
    this.category = input.category;
    this.status = input.status;
    this.rpcCode = input.rpcCode;
    this.rpcData = input.rpcData;
  }
}

/**
 * A Cetane HTTP transport for one possibly credentialed RPC URL. Userinfo is
 * sent as an `Authorization` header, caller headers are preserved, and every
 * request failure becomes a `MoesiRpcTransportError` so credentials, signed
 * payloads and provider prose never reach logs or errors.
 */
export function createHttpTransport(url: string, options: HttpOptions = {}): Transport {
  const endpoint = rpcEndpoint(url);
  const base = http(endpoint.url, {
    ...options,
    fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, redirect: "error" }),
    headers: mergeHeaders(options.headers, endpoint.headers),
  });
  return {
    async request(...args) {
      try {
        return await base.request(...args);
      } catch (error) {
        throw scrubTransportError(error);
      }
    },
  };
}

function parseHttpUrl(url: unknown): URL {
  let parsed: URL;
  try {
    if (typeof url !== "string") throw null;
    parsed = new URL(url);
  } catch {
    throw new MoesiRpcEndpointError("invalid_rpc_url", "RPC URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MoesiRpcEndpointError("invalid_rpc_url", "RPC URL must use http or https");
  }
  return parsed;
}

/** UTF-8 Base64 without depending on Node's Buffer. */
function base64(input: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(input)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Endpoint credentials replace any caller header of the same case-insensitive name. */
function mergeHeaders(
  callerHeaders: HeadersInit | undefined,
  endpointHeaders: Readonly<Record<string, string>>,
): Record<string, string> {
  const merged = new Headers(callerHeaders);
  for (const [key, value] of Object.entries(endpointHeaders)) merged.set(key, value);
  const record: Record<string, string> = {};
  merged.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function scrubTransportError(error: unknown): MoesiRpcTransportError {
  let status: number | null = null;
  let rpcCode: number | null = null;
  let rpcData: Hex | null = null;
  let name = "";
  try {
    if (typeof error === "object" && error !== null) {
      name = String(Reflect.get(error, "name"));
      const rawStatus = Reflect.get(error, "status");
      if (Number.isSafeInteger(rawStatus)) status = rawStatus as number;
      const rawCode = Reflect.get(error, "code");
      if (Number.isSafeInteger(rawCode)) rpcCode = rawCode as number;
      const rawData = Reflect.get(error, "data");
      if (typeof rawData === "string" && HEX_PATTERN.test(rawData)) rpcData = rawData as Hex;
    }
  } catch {
    // Unreadable errors keep only their category.
  }
  const category: RpcTransportErrorCategory =
    name === "TimeoutError"
      ? "timeout"
      : name === "RpcError"
        ? "rpc"
        : status !== null
          ? "http"
          : "transport";
  return new MoesiRpcTransportError({ category, status, rpcCode, rpcData });
}
