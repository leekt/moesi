import type { Hex } from "cetane";

/**
 * The prepared provider execution envelope. `prepare` binds the selected
 * account/sender/authorization and the exact reviewed calls; Moesi carries the
 * envelope opaquely from `prepare` to `submit` and never persists it.
 * `binding` is provider-private.
 */
export interface PreparedProviderExecution {
  readonly providerId: string;
  readonly planId: Hex;
  readonly binding: unknown;
}
