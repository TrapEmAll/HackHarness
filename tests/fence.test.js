import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { investigateAuthorization } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

async function fixture(port) {
  const child=spawn(process.execPath,["tests/fixture/server.js","vulnerable"],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([once(child.stdout,"data"),once(child,"exit").then(([code])=>{throw new Error(`Fixture exited ${code}`);})]);
  return child;
}

test("claimCompletion fences finishing leases exactly once",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-claim-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"claim-test"});
  const taskId=store.task("claim-test",null,"investigator",{actionKey:"c1"});
  assert.equal(store.claimCompletion(taskId,"completed"),true);
  assert.equal(store.claimCompletion(taskId,"completed"),false,"second claim must be refused");
  assert.equal(store.claimCompletion("T-missing","completed"),false,"unknown tasks claim nothing");
});

test("a lease revoked while responses are in flight cannot publish outcomes",async t=>{
  const port=`44${(globalThis.__fenceCounter=(globalThis.__fenceCounter||300)+1)}`, child=await fixture(port); t.after(()=>child.kill("SIGTERM"));
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=`fence-mid-${port}`;
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-mid-"))); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read tenant A object","denied","compare");
  // owner + negative control are each delayed 400ms by the fixture
  const pending=investigateAuthorization(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1?delay=400",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user"});
  await new Promise(r=>setTimeout(r,100));
  assert.equal(store.recover(manifest.engagement,{staleSeconds:0}),1,"lease interrupted while its first response is still in flight");
  await assert.rejects(()=>pending,{code:"BUDGET"},"the revoked lease's next hop must be fenced");
  assert.equal(store.list("finding",manifest.engagement).length,0,"no finding may be published by a revoked lease");
  assert.ok(!["supported","rejected"].includes(store.list("hypothesis",manifest.engagement).find(row=>row.id===hypothesis).state),"hypothesis state must not be flipped by a revoked lease");
});
