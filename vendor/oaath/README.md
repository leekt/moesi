# Exact OAAth development artifacts

These packages are packed from the exact OAAth commit in `provenance.json`.
The local changes add owner batch and read-only session estimation, local viem wallet support, and
public v3.3 owner/session consumer fixtures on top of the recorded merged
upstream Grant runtime. They are dependencies, not a
synchronized source checkout.
Root overrides keep all internal package edges on these same checksummed files.

The production adapter uses the public SDK. Server and testing packages belong
only to isolated local-Anvil consumers. All four packages are versioned 0.2.0;
these exact local artifacts do not claim an npm publication. Registry 0.1.0
does not satisfy this SDK contract.
