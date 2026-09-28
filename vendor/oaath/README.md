# Exact OAAth development artifacts

These are unmodified packages packed by OAAth from the independently reviewed,
merged commit in `provenance.json`. They are dependencies, not a synchronized
source checkout. The root overrides keep their internal package edges on these
same artifacts. Production adapter code consumes only the public SDK; server and
testing packages are used only by the isolated local-Anvil consumer proof.

The source packages still have version 0.1.0. Registry 0.1.0 lacks the required
APIs. Replace the exact artifacts and peer version together when OAAth publishes
the next reviewed 0.x release; do not substitute registry packages by version alone.
