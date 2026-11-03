import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { delegateInvestigation, delegateReplay } from "../src/workflow.js";

process.env.HH_TOKEN_A = "fixture-token-a";
process.env.HH_TOKEN_B = "fixture-token-b";

test("delegate fails with WORKER and records worker.failed when the turn ends without an investigation",async t=>{
  process.env.HH_FAKE_MODE="dud";
  const manifestPath=path.resolve("examples/local-fixture.json");
  const manifest=loadManifest(manifestPath).manifest; manifest.engagement="dud-test";
  manifest.workers={binary:"node",args:[path.resolve("tests/fake-omp.js")]};
  manifest.limits={requests_per_second:100,wall_clock_minutes:1,max_response_bytes:1000};
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-dud-"))); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read","denied","compare");
  await assert.rejects(()=>delegateInvestigation(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user"}),{code:"WORKER",message:/without creating an investigation task/});
  const tasks=store.list("task",manifest.engagement);
  const workerTask=tasks.find(row=>row.role==="worker");
  assert.equal(workerTask.state,"failed");
  const events=store.list("event",manifest.engagement).map(row=>JSON.parse(row.payload_json));
  assert.ok(events.some(e=>e.error && e.code==="WORKER"),"worker.failed event with WORKER code");
  assert.ok(store.list("finding",manifest.engagement).length===0,"no findings on dud run");
});

test("delegated verification fails with WORKER when the turn ends without a replay task",async t=>{
  process.env.HH_FAKE_MODE="dud";
  const manifestPath=path.resolve("examples/local-fixture.json");
  const manifest=loadManifest(manifestPath).manifest; manifest.engagement="dud-verify";
  manifest.workers={binary:"node",args:[path.resolve("tests/fake-omp.js")]};
  manifest.limits={requests_per_second:100,wall_clock_minutes:1,max_response_bytes:1000};
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-dudv-"))); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read","denied","compare");
  const finding=store.finding(manifest.engagement,hypothesis,"Cross-identity object read",[["E-x"]],{type:"authorization_read",path:"/api/objects/a1",owner_identity:"tenant-a-user",other_identity:"tenant-b-user",expected_owner:"user-a",protected_fields:["secret"]},"x");
  await assert.rejects(()=>delegateReplay(store,manifest,{findingId:finding}),{code:"WORKER",message:/without creating a replay task/});
  const workerTask=store.list("task",manifest.engagement).find(row=>row.role==="worker");
  assert.equal(workerTask.state,"failed");
});
