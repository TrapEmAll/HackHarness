import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { benchmark } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");
async function fixture(mode,port) {
  const child=spawn(process.execPath,["tests/fixture/server.js",mode],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([once(child.stdout,"data"), once(child,"exit").then(([code])=>{ throw new Error(`Fixture exited ${code}`); })]);
  return child;
}
let counter=200;

async function bench(mode, trials) {
  const port=`44${++counter}`, child=await fixture(mode,port); 
  const manifest=loadManifest(manifestPath).manifest;
  manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=`bench-${mode}`;
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-bench-"))); store.createEngagement(manifestPath,manifest);
  const summary=await benchmark(store,manifest,{path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user",trials});
  store.close(); child.kill("SIGTERM");
  return summary;
}

test("bench on the vulnerable fixture reproduces and independently verifies every trial",async t=>{
  const summary=await bench("vulnerable",2);
  assert.equal(summary.trials,2); assert.equal(summary.incomplete,0);
  assert.ok(summary.reproduced===2,"both trials must reproduce the seeded defect");
  assert.ok(summary.independently_verified===2,"every reproduction must replay independently");
  assert.equal(summary.scope_violations,0);
  assert.equal(summary.requests_per_trial,4,"2 investigate probes + 2 independent replay probes per trial");
  assert.ok(summary.elapsed_ms>=0);
});

test("bench on the fixed fixture reports zero supported findings (negative control)",async t=>{
  const summary=await bench("fixed",2);
  assert.equal(summary.reproduced,0);
  assert.equal(summary.independently_verified,0);
  assert.ok(summary.rows.every(row=>row.state==="rejected"));
  assert.equal(summary.requests_per_trial,2);
});

test("bench labels a read-only fixture honestly",async t=>{
  const summary=await bench("vulnerable",1);
  assert.equal(summary.fixture_is_read_only,true);
});
