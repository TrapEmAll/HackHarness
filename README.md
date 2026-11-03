# HackHarness

An authorization-first research harness for reproducible testing of systems you own or are explicitly permitted to assess. It gives Oh My Pi (OMP) durable hypotheses, scoped identity-aware requests, immutable redacted evidence, independent replay, and report drafts.

The implemented workflow is deliberately narrow and complete: compare access to one object across two controlled identities. This is the foundation for adding more playbooks without giving agents generic network access.

## Requirements

- Node.js 22.5 or newer (tested with Node 24)
- OMP only for the interactive extension; the CLI works without it

No package installation is required.

## Run the local demonstration

Terminal one:

```sh
npm run fixture:vulnerable
```

Terminal two:

```sh
export HH_TOKEN_A='fixture-token-a'
export HH_TOKEN_B='fixture-token-b'

node src/cli.js open examples/local-fixture.json
node src/cli.js hypothesis examples/local-fixture.json \
  --claim 'Tenant B can read tenant A object' \
  --control 'Tenant B is denied' \
  --check 'Compare /api/objects/a1 across identities'
```

Use the returned hypothesis ID:

```sh
node src/cli.js investigate examples/local-fixture.json HYPOTHESIS_ID \
  --path /api/objects/a1 --owner tenant-a-user --other tenant-b-user
node src/cli.js replay examples/local-fixture.json FINDING_ID
node src/cli.js review examples/local-fixture.json FINDING_ID --decision approve
node src/cli.js report examples/local-fixture.json FINDING_ID
```

Run `npm run fixture:fixed` instead to confirm the same hypothesis is rejected.

## Use from OMP

```sh
export HH_MANIFEST="$PWD/examples/local-fixture.json"
export HH_DATA_DIR="$PWD/.hackharness-data"
export HH_TOKEN_A='fixture-token-a'
export HH_TOKEN_B='fixture-token-b'
omp --trusted-extension "$PWD/packages/omp-adapter/index.ts"
```

Inside OMP, use `/hh context`, `/hh hypotheses`, `/hh findings`, `/hh pause`, `/hh resume`, `/hh review FINDING_ID approve`, or `/hh report FINDING_ID`. OMP can call the typed `hh_*` tools to submit hypotheses, investigate, read evidence, and replay findings. See [the adapter guide](packages/omp-adapter/README.md).

`hh tasks MANIFEST` lists every task with role, state, attempt number, action key, and wall-clock deadline. Tasks deduplicate on their hypothesis plus normalized action: a second dispatch of a running action fails with `DEDUP` and names the owning task. Opening an engagement after a crash marks tasks that were left `running` as `interrupted` (logged as `task.recovered` events) so they can be redispatched with an incremented attempt number. Each task also gets a wall-clock deadline from `limits.wall_clock_minutes`; gateway work past the deadline fails with `BUDGET` before touching the network.

## Manifest and policy

Manifests are JSON. They require an authorization document with a future expiry, exact target origins, path prefixes, HTTP methods, per-target request budgets, and identities backed by `env://VARIABLE` references. Credential values are injected only in the gateway and redacted before evidence is persisted.

The gateway rejects undeclared origins, methods and paths, credential-bearing URLs, ambiguous encoded paths, and private destinations unless `allow_private` is explicitly set for a local lab. It revalidates redirects, strips credentials across origins, limits response size and redirects, rate-limits requests, and supports an engagement-wide pause.

The data directory is private local state and is ignored by Git. It contains SQLite state, append-only event rows, immutable redacted captures, and report drafts. Do not place live credentials in a manifest or commit an engagement data directory.

## Verification

```sh
npm test
```

The suite checks scope escapes, per-target request budgets, task leases with dedup, restart recovery, the vulnerable fixture, the fixed negative control, independent replay, report generation, and that persisted artifacts do not contain fixture tokens.

## Status against DESIGN.md

Implemented from the release sequence: milestone 1 (one complete local workflow) and the first part of milestone 2 (per-target budgets, task leases with attempt IDs and wall-clock deadlines, action deduplication, restart recovery of interrupted tasks). Not yet implemented: bounded OMP-worker processes, model routing, full concurrency enforcement, browser work, and benchmarks.

## Current boundary

HackHarness currently supports read-only HTTP authorization comparisons. Browser automation, state-changing playbooks, encrypted raw capture retention, autonomous OMP worker pools, and external report submission are intentionally unavailable. The broader architecture and release sequence are documented in [DESIGN.md](DESIGN.md); those items should not be treated as implemented security guarantees.
