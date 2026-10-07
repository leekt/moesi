import {
  MoesiObservationError,
  type ObservationFailureCategory,
  withObservationAbort,
} from "../observation/failure.js";

/** Internal transport failures carry no URL, response body, or underlying error. */
export class ObservationHttpError extends Error {
  constructor(
    readonly category: ObservationFailureCategory,
    readonly status: number | null = null,
  ) {
    super(category);
    this.name = "ObservationHttpError";
  }
}

/** Bound the whole HTTP exchange, including a stalled body, and match response IDs. */
export function observationFetch(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), timeoutMs);
    const callerSignal = init?.signal ?? undefined;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    try {
      return await withObservationAbort(signal, async () => {
        const response = await fetcher(input, { ...init, signal, redirect: "error" });
        if (!response.ok) {
          await response.body?.cancel();
          throw new ObservationHttpError(
            response.status === 429
              ? "rate-limited"
              : response.status >= 500
                ? "http-5xx"
                : "http-error",
            response.status,
          );
        }
        const maxBytes = 10_485_760;
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await response.body?.cancel();
          throw new ObservationHttpError("invalid-response");
        }
        let body = "";
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > maxBytes) {
                await reader.cancel();
                throw new ObservationHttpError("invalid-response");
              }
              body += decoder.decode(value, { stream: true });
            }
            body += decoder.decode();
          } finally {
            reader.releaseLock();
          }
        } else {
          body = await response.text();
          if (new TextEncoder().encode(body).length > maxBytes)
            throw new ObservationHttpError("invalid-response");
        }
        if (response.ok) {
          let decoded: unknown;
          try {
            decoded = JSON.parse(body);
          } catch {
            throw new ObservationHttpError("non-json");
          }
          // This is the request Cetane just constructed, retained only while matching IDs.
          const sent = JSON.parse(String(init?.body)) as { id: unknown } | { id: unknown }[];
          const wanted = Array.isArray(sent) ? sent : [sent];
          const returned = Array.isArray(decoded) ? decoded : [decoded];
          if (Array.isArray(sent) !== Array.isArray(decoded) || wanted.length !== returned.length)
            throw new ObservationHttpError("invalid-response");
          const ids = new Set(wanted.map(({ id }) => id));
          for (const item of returned) {
            if (typeof item !== "object" || item === null)
              throw new ObservationHttpError("invalid-response");
            const entry = item as Record<string, unknown>;
            if (
              entry.jsonrpc !== "2.0" ||
              !ids.delete(entry.id) ||
              Object.hasOwn(entry, "result") === Object.hasOwn(entry, "error")
            )
              throw new ObservationHttpError("invalid-response");
          }
        }
        return new Response(body, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
        });
      });
    } catch (error) {
      if (callerSignal?.aborted) throw new MoesiObservationError("observation_aborted");
      if (deadline.signal.aborted) throw new ObservationHttpError("timeout");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
}
