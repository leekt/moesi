# Exact OAAth development artifacts

These are unmodified packages packed by OAAth from the independently reviewed,
merged commit in `provenance.json`. They are dependencies, not a synchronized
source checkout. The root overrides keep their internal package edges on these
same artifacts. Production adapter code consumes only the public SDK; server and
testing packages are used only by the isolated local-Anvil consumer proof.

All four artifacts are versioned `0.2.0`, packed from the reviewed merged
OAAth release-version commit. The adapter requires that SDK contract explicitly;
registry `0.1.0` lacks the review/evidence/recovery APIs and cannot replace it.
These files are exact dependencies, not a claim that `0.2.0` is published in npm.
