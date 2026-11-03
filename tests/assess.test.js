import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { delegateReview, investigateAuthorization } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";

test("assess rejects wrong-state findings and dud reviewer turns without state changes",async t=>{
  process.env.HH_FAKE_MODE="dud";
  const manifestPath=path.resolve("examples/local-fixture.json");
  const manifest=loadManifest(manifestPath).manifest; manifest.engagement="assess-test";
  manifest.workers={binary:"node",args:[path.resolve("tests/fake-omp.js")]};
  manifest.limits={requests_per_second:100,wall_clock_minutes:1,max_response_bytes:1000};
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-assess-"))); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read","denied","compare");
  const finding=store.finding(manifest.engagement,hypothesis,"Cross-identity object read",[],{type:"authorization_read",path:"/api/objects/a1",owner_identity:"tenant-a-user",other_identity:"tenant-b-user",expected_owner:"user-a",protected_fields:["secret"]},"impact");
  await assert.rejects(()=>delegateReview(store,manifest,{findingId:finding}),{code:"STATE"},"candidate findings are not ready for assessment");
  store.setFinding(finding,"independently_verified");
  await assert.rejects(()=>delegateReview(store,manifest,{findingId:finding}),{code:"WORKER",message:/parseable final JSON verdict/});
  const workerTask=store.list("task",manifest.engagement).find(row=>row.role==="worker"&&row.state==="failed");
  assert.ok(workerTask,"reviewer lease fails on dud turn");
  assert.equal(store.findingById(finding).state,"independently_verified"&&store.findingById(finding).state,"finding state untouched by the reviewer");
  const events=store.list("event",manifest.engagement).map(row=>row.type);
  assert.ok(events.includes("worker.failed"));
  assert.ok(!events.includes("reviewer.assessment"),"no assessment recorded without a verdict");
});
