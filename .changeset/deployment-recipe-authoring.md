---
"moesi": minor
---

Add `compileDeploymentRecipe` for offline registration and authoring previews.
It captures the current closed deployment/sender shape and shares the manifest
parser, address predictor and calldata compiler with reviewed planning. Protected
CreateX recipes require an exact owner or smart-account sender. The result is
immutable authoring data; it does not fabricate a runtime expectation, observe
chain state or authorize execution.
