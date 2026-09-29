import {
  MoesiObservationError,
  MoesiPlanningError,
  type ObservationCause,
  parseObservationCause,
} from "moesi";

export function errorObservationCause(error: unknown): ObservationCause | null {
  if (!(error instanceof MoesiPlanningError) && !(error instanceof MoesiObservationError))
    return null;
  try {
    return parseObservationCause(Object.getOwnPropertyDescriptor(error, "cause")?.value);
  } catch {
    return null;
  }
}

export function formatObservationCause(cause: ObservationCause | undefined | null): string {
  if (!cause) return "";
  return ` rpc-attempts=${cause.attempts.map(({ endpoint, category, rpcCode, httpStatus }) => `${endpoint}:${category}${httpStatus === null ? "" : `:http-${httpStatus}`}${rpcCode === null ? "" : `:rpc-${rpcCode}`}`).join(",")}`;
}
