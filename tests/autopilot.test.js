import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { autopilot, delegateInvestigation } from "../src/workflow.js";

process.env.HH_TOKEN_A = "fixture-token-a";
process.env.HH_TOKEN_B = "fixture-token-b";
const manifestPath = path.resolve("examples/local-fixture.json");

function configured(manifest, name, mode) {
  manifest.engagement = name;
  manifest.workers = { binary: "node", args: [path.resolve("tests/fake-omp.js")] };
  manifest.limits = { requests_per_second: 100, wall_clock_minutes: 1, max_response_bytes: 1000, concurrency: manifest.limits.concurrency || 2 };
  process.env.HH_FAKE_MODE = mode;
}

test("autopilot schedules proposed hypotheses in waves and reports per-dispatch outcomes",async t=>{
  const manifest=loadManifest(manifestPath).manifest;
  configured(manifest,"autopilot-test","dud");
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-ap-"))); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  const ids=[store.hypothesis(manifest.engagement,"a","x","y"),store.hypothesis(manifest.engagement,"b","x","y"),store.hypothesis(manifest.engagement,"c","x","y")];
  const summary=await autopilot(store,manifest,{path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user",model:null});
  assert.equal(summary.dispatched,3);
  assert.equal(summary.results.length,3);
  assert.ok(summary.results.every(row=>row.code==="WORKER"),"dud workers fail per hypothesis");
  assert.equal(summary.remaining,3);
  const events=store.list("event",manifest.engagement).map(row=>row.type);
  assert.ok(events.includes("autopilot.finished"));
  assert.ok(store.list("finding",manifest.engagement).length===0);
});

test("killing a delegate mid-run yields an interrupted lease that re-dispatches with attempt 2",async t=>{
  const manifest=loadManifest(manifestPath).manifest;
  configured(manifest,"crash-test","stuck");
  manifest.limits.wall_clock_minutes=0.05; // deadline aborts the rerun quickly
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"hh-crash-")), store=new Store(root); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read","denied","compare");
  // the child loads a manifest file, not the mutated in-memory object: write it
  const childManifestPath=path.join(root,"manifest.json");
  // sources roots resolve relative to the manifest file's directory; clear them for the relocated copy
  fs.writeFileSync(childManifestPath,JSON.stringify({ ...manifest, sources: [] }));
  fs.copyFileSync(path.resolve("examples/authorization.md"),path.join(root,"authorization.md"));
  const child=spawn(process.execPath,["src/cli.js","delegate",childManifestPath,hypothesis,"--path","/api/objects/a1","--owner","tenant-a-user","--other","tenant-b-user"],{cwd:process.cwd(),env:{...process.env,HH_FAKE_MODE:"stuck",HH_DATA_DIR:root},stdio:["ignore","ignore","pipe"]});
  let stderr=""; child.stderr.on("data",chunk=>stderr+=chunk);
  // wait for the child to create its running worker lease
  for (let at=0;at<50;at++) {
    const lease=store.list("task","crash-test").find(row=>row.role==="worker"&&row.state==="running");
    if (lease) break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(store.list("task","crash-test").some(row=>row.role==="worker"&&row.state==="running"),"child lease must be running before the kill");
  child.kill("SIGKILL");
  await new Promise(r=>child.once("exit",r));
  // reopen like any later assignment command would
  const reopened=new Store(root), interrupted=reopened.recover("crash-test",{staleSeconds:0});
  reopened.close();
  assert.equal(interrupted,1);
  const events=store.list("event","crash-test").map(row=>row.type);
  assert.ok(events.includes("task.recovered"));
  assert.equal(store.list("task","crash-test").find(row=>row.role==="worker").state,"interrupted");
  // redispatch hits the deadline and settles as a failed attempt, now at attempt 2
  await assert.rejects(()=>delegateInvestigation(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user",model:null}),{code:"WORKER"});
  const lease=store.list("task","crash-test").find(row=>row.role==="worker");
  assert.equal(lease.attempt,2);
  assert.equal(lease.state,"failed");
});
