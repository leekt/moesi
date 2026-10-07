import { MoesiObservationError, withObservationAbort } from "./failure.js";
import type { MoesiObservationAdapter } from "./types.js";

/** Per-request binding; concurrent plans never overwrite one another's cancellation. */
export function bindObservationSignal(
  observer: MoesiObservationAdapter,
  signal: AbortSignal | undefined,
): MoesiObservationAdapter {
  if (signal === undefined) return observer;
  if (!(signal instanceof AbortSignal))
    throw new MoesiObservationError("invalid_observer_configuration");
  return {
    captureSnapshot: (chainId) =>
      withObservationAbort(signal, () => observer.captureSnapshot(chainId, { signal })),
    readCode: (request) =>
      withObservationAbort(signal, () => observer.readCode({ ...request, signal })),
    readCall: (request) =>
      withObservationAbort(signal, () => observer.readCall({ ...request, signal })),
    ...(observer.readStorage
      ? {
          readStorage: (
            request: Parameters<NonNullable<MoesiObservationAdapter["readStorage"]>>[0],
          ) => withObservationAbort(signal, () => observer.readStorage!({ ...request, signal })),
        }
      : {}),
    ...(observer.readAccountModules
      ? {
          readAccountModules: (
            request: Parameters<NonNullable<MoesiObservationAdapter["readAccountModules"]>>[0],
          ) =>
            withObservationAbort(signal, () =>
              observer.readAccountModules!({ ...request, signal }),
            ),
        }
      : {}),
    checkBlockAncestry: (request) =>
      withObservationAbort(signal, () => observer.checkBlockAncestry({ ...request, signal })),
  };
}
