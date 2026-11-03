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

`hh delegate MANIFEST HYPOTHESIS --path PATH --owner ID --other ID [--model ALIAS]` runs the same authorization investigation through a real OMP worker instead of the CLI. The worker is spawned once per dispatch as `omp --mode rpc --no-session --no-ui --no-tools --no-extensions --trusted-extension packages/omp-adapter/index.ts` from a private scratch directory, with the engagement manifest path and data directory injected into its environment via the normal env vars. With `--no-tools` all built-in tools are disabled, so the worker's only capabilities are the `hh_*` tools in the allowlisted extension: it cannot reach the target except through the scoped gateway. Prompt completion follows omp's RPC contract — the `response` acknowledgment is acceptance, not completion; only a terminal `agent_end` (or a `prompt_result` with `agentInvoked: false`) completes a turn, and every unexpected exit becomes a failed attempt recorded on its task. Deadlines send RPC `abort` and then force exit after a grace period; worker cost is recorded from `get_session_stats` as worker.cost events when the session reports it.

`hh verify MANIFEST FINDING [--model ALIAS]` delegates independent replay to a separate OMP worker under a `worker-replay:<finding>` lease: the worker's only applicable tool is `hh_replay`, success requires a verifier task created after the dispatch, and the resulting finding state (`independently_verified`/`stale`) is returned with the session cost. Verifier routing prefers `workers.routing.verifier`, falling back to `workers.routing.investigator`.

`hh autopilot MANIFEST --path PATH --owner ID --other ID [--model ALIAS]` dispatches every `proposed` hypothesis through `hh delegate` in waves bounded by `limits.concurrency` (a wave holds `floor(concurrency / 2)` delegates since each delegate occupies its worker lease and inner investigation at peak). It returns one outcome per hypothesis — worker state, inner task, finding state, cost, or the failing error code — plus the number of hypotheses that remain `proposed`. Over-cap workers report `CONCURRENCY` instead of crashing the run; interrupted leases recover on the next command as usual.

`limits.concurrency` (default 2) caps simultaneously `running` tasks per engagement across all roles; further dispatches fail with `CONCURRENCY` until a task completes or is recovered. Each delegate counts its worker lease and the inner investigation as two of those slots while in flight.

`hh assess MANIFEST FINDING [--model ALIAS]` delegates the reviewer role — scope, impact, duplication, and report-quality assessment — to a read-only OMP worker under a `worker-review:<finding>` lease. The brief restricts it to `hh_evidence_read` and `hh_findings` (no target-facing tools); the turn is only successful if it ends with a parseable JSON verdict naming the finding, which lands as a `reviewer.assessment` event. The reviewer never mutates finding state: export still requires your explicit `hh review ... approve`. Routing prefers `workers.routing.reviewer`, then verifier, then investigator.

Manifest additions:

```json
{
  "limits": { "max_cost_usd": 5 },
  "workers": {
    "binary": "omp",
    "routing": { "investigator": "fuzzy-model-alias", "verifier": "another-alias" }
  }
}
```

`workers.binary` defaults to `omp` on PATH (override with the `HH_OMP` env var). Routing aliases are OMP fuzzy model patterns, not hard-coded vendor names. Set the model with `--model` per dispatch, `workers.routing.investigator` by default, or neither for the session default model. `limits.max_cost_usd` is passed to the worker as omp's `--max-cost` cap; when a session cannot report usage, no cost is recorded rather than a guessed one.

This is tool-surface narrowing, not an environment or OS sandbox. The worker process runs with your user, inherits the parent process environment (including the `env://` credential variables — the gateway reads them in the `hh investigate` child), and calls its configured model provider directly with your own credentials. What the boundary gives you: the worker has no built-in bash/browser/file tools, no ambient project extensions, and cannot reach the target except through the scoped, budgeted gateway. What it does not give you: secret isolation, network isolation, or filesystem isolation.

Role gating is enforced at extension load, not by prompt discipline: the adapter reads `HH_ROLE` before registration and only registers that role's tools. The reviewer dispatch runs with `HH_ROLE=reviewer`, so `hh_replay`, `hh_investigate_authorization`, and `hh_hypothesis_submit` never exist in that process regardless of what the prompt or target content says. Investigator workers run with the full `hh_*` set.

## Map and observations

`hh map MANIFEST [--identity ID]` runs the mapper playbook through the scoped gateway: it probes each declared path prefix with every declared identity, discovers JSON-shaped child paths (`/api/...` strings in responses), and records `Observation` rows — `endpoint.probe` for single-identity mappings, or `authorization.denied` (identities disagreed with a denial), `authorization.diff` (different owner markers), `cross_identity.pool` (every identity saw the same owner marker), or `uniform` per discovered path. Observations cite the evidence capture backing them; `hh observations MANIFEST` lists them. Mapping is read-only, budgeted, and deductible to the same per-target request limits as investigations — planning is your job: submit hypotheses with `hh hypothesis` or the `hh_hypothesis_submit` tool using the observations as justification.

## Benchmark

`hh bench MANIFEST --mode vulnerable|fixed [--trials N]` measures the deterministic authorization playbook against a labeled fixture (start the matching fixture server first; the metrics are for the machinery, not the model planner — planner-quality benchmarks need `hh delegate` and cost money, so they are not run automatically). Output per run:

- `denominator` / `trials` / `incomplete`: what was attempted and what failed (rows keep per-trial outcomes with denominated failures, never dropped).
- `reproduced` and `independently_verified`: supported claims and their independent replay rate (`replay_success_rate`); on the labeled `vulnerable` fixture both should equal `trials`; on `fixed`, both are expected to be 0 — a supported claim there is a false positive you must investigate.
- `requests_total` / `requests_per_trial`: each trial's probes (investigation + independent replay) counted through the same budget as real work.
- `elapsed_ms`, `scope_violations` (any `SCOPE` error code), and `fixture_is_read_only` (manifest honesty check that only read methods were declared).

The summary is also logged as a `benchmark.completed` event with its hypothesis reference.

## Manifest and policy

Manifests are JSON. They require an authorization document with a future expiry, exact target origins, path prefixes, HTTP methods, per-target request budgets, and identities backed by `env://VARIABLE` references. Credential values are injected only in the gateway and redacted before evidence is persisted.

The gateway rejects undeclared origins, methods and paths, credential-bearing URLs, ambiguous encoded paths, and private destinations unless `allow_private` is explicitly set for a local lab. It revalidates redirects, strips credentials across origins, limits response size and redirects, rate-limits requests, and supports an engagement-wide pause.

The data directory is private local state and is ignored by Git. It contains SQLite state, append-only event rows, immutable redacted captures, and report drafts. Do not place live credentials in a manifest or commit an engagement data directory.

## Verification

```sh
npm test
```

The suite checks scope escapes, per-target request budgets, task leases with dedup, restart recovery, RPC worker wire contracts (against an in-repo fake omp, plus an optional live run with `HH_OMP_TEST=1` requiring a configured omp), the vulnerable fixture, the fixed negative control, independent replay, report generation, and that persisted artifacts do not contain fixture tokens.

## Status against DESIGN.md

Implemented from the release sequence: milestone 1 (one complete local workflow), milestone 2 (per-target budgets, task leases with attempt IDs and wall-clock deadlines, action deduplication, restart recovery including mid-run worker kills, engagement concurrency caps, and bounded OMP worker dispatch — investigation, independent verification, wave-scheduled autopilot, and the read-only reviewer — with model routing and cost caps), and the read-only mapper playbook with observation records. Not yet implemented: centralized cross-worker budget reservation for provider usage reporting gaps, browser work, source-assisted playbooks, and model-driven benchmark reporting (the deterministic fixture benchmark harness ships as `hh bench`; planner-quality measurements must be driven manually through `hh delegate`).

## Current boundary

HackHarness currently supports read-only HTTP authorization comparisons (direct or OMP-worker delegated), independent verification, wave-scheduled autopilot, the read-only mapper playbook, reviewer-role assessments, and the deterministic fixture benchmark harness. Browser automation, state-changing playbooks, encrypted raw capture retention, and external report submission are intentionally unavailable. The broader architecture and release sequence are documented in [DESIGN.md](DESIGN.md); those items should not be treated as implemented security guarantees.
