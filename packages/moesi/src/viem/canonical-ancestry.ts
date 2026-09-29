import type { Hex } from "viem";
import type { SnapshotReference } from "../observation/types.js";

export interface CanonicalBlock extends SnapshotReference {
  readonly parentHash: Hex;
}

/**
 * RPC-attested canonicality, under the same trust boundary as pinned state reads.
 * Read by height and compare exact hashes; arbitrary hash lookups can return
 * orphaned blocks. Rebind the descendant after checking the ancestor so a reorg
 * observed during the reads cannot make the pair pass. Work is independent of age.
 */
export async function checkCanonicalAncestry(
  ancestor: SnapshotReference,
  descendant: SnapshotReference,
  readCanonicalBlock: (height: bigint) => Promise<CanonicalBlock>,
): Promise<boolean> {
  const from = BigInt(ancestor.blockNumber);
  const to = BigInt(descendant.blockNumber);
  if (from > to) return false;
  const matches = (actual: CanonicalBlock, expected: SnapshotReference) =>
    actual.blockNumber === expected.blockNumber && actual.blockHash === expected.blockHash;
  const head = await readCanonicalBlock(to);
  if (!matches(head, descendant)) return false;
  if (from === to) return ancestor.blockHash === descendant.blockHash;
  if (to === from + 1n && head.parentHash !== ancestor.blockHash) return false;
  if (!matches(await readCanonicalBlock(from), ancestor)) return false;
  const rebound = await readCanonicalBlock(to);
  return matches(rebound, descendant) && rebound.parentHash === head.parentHash;
}
