---
"moesi": minor
---

Add `createMoesi({ observer }).discover()` for explicit contract addresses across selected chains. The immutable `moesi.discovery/v1` result reports runtime code and optional ERC-1967 slot, Ownable owner, and AccessControl role evidence at pinned blocks, with a final ancestry check. Missing, malformed, unavailable, and contradictory evidence remain distinct. Discovery has no execution provider or permission side effects and does not infer proxy authenticity, enforcement, or repair actions.
