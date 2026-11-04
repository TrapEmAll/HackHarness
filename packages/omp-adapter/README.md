# OMP adapter

Launch OMP from the HackHarness checkout with the extension explicitly trusted:

```sh
export HH_MANIFEST="$PWD/examples/local-fixture.json"
export HH_DATA_DIR="$PWD/.hackharness-data"
export HH_TOKEN_A='fixture-token-a'
export HH_TOKEN_B='fixture-token-b'
omp --trusted-extension "$PWD/packages/omp-adapter/index.ts"
```

The extension registers `/hh` plus seven typed tools (`hh_context`, `hh_hypothesis_submit`, `hh_investigate_authorization`, `hh_findings`, `hh_map_query`, `hh_replay`, `hh_evidence_read`, `hh_source_read`). Workers are role-gated: the adapter reads `HH_ROLE` before registration and only registers that role's tools (`all` = set above; `reviewer` = context/findings/evidence/source read only; `mapper` = context/source read/map query/hypothesis submit); the reviewer process therefore has no target-facing tools at all. It invokes the local coordinator CLI using argument arrays, never a shell. All target requests still pass through the gateway; the extension does not receive credential values.

For untrusted repositories, start OMP outside their checkout and use an explicit trusted-extension allowlist. Do not copy this adapter into a target repository.
