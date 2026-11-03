import test from "node:test";
import assert from "node:assert/strict";

// Opts in to a real model call through the configured omp installation.
// Run with: HH_OMP_TEST=1 HH_MANIFEST=examples/local-fixture.json npm test
if (process.env.HH_OMP_TEST !== "1") test("live omp RPC (set HH_OMP_TEST=1)", { skip: true }, () => {});
else {
  // set HH_OMP_TEST=1 for real model-backed runs
  test("live omp RPC answers a prompt with terminal completion", async t => {
    const { RpcWorker } = await import("../src/worker.js");
    assert.ok(process.env.HH_MANIFEST, "HH_MANIFEST must point at a manifest for the live run");
    const worker = new RpcWorker({ extension: "packages/omp-adapter/index.ts" });
    t.after(() => worker.close());
    await worker.start();
    const result = await worker.prompt("Reply with only the word ok", { timeoutMs: 120_000 });
    assert.equal(result.aborted, false);
    assert.equal(result.failure, undefined);
    assert.match(result.text, /ok/i);
  }, { timeout: 30_000 });

  test("live adapter registers only the reviewer-role tools under HH_ROLE=reviewer", async t => {
    const { RpcWorker } = await import("../src/worker.js");
    const worker = new RpcWorker({ extension: "packages/omp-adapter/index.ts", env: { ...process.env, HH_ROLE: "reviewer" } });
    t.after(() => worker.close());
    await worker.start();
    const state = await worker.command({ type: "get_state" });
    const names = (state.dumpTools || []).map(row => row.name).filter(name => name.startsWith("hh")).sort();
    assert.deepEqual(names, ["hh_context", "hh_evidence_read", "hh_findings"]);
  }, { timeout: 30_000 });
}
