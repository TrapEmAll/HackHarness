import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { exportReport, investigateAuthorization, replayFinding, reviewFinding } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");
async function fixture(mode,port) {
  const child=spawn(process.execPath,["tests/fixture/server.js",mode],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([
    once(child.stdout,"data"),
    once(child,"exit").then(([code])=>{ throw new Error(`Fixture exited before readiness with code ${code}`); })
  ]);
  return child;
}
function configuredManifest(port) { const loaded=loadManifest(manifestPath).manifest; loaded.engagement=`test-${modeCounter++}`; loaded.targets[0].origin=`http://127.0.0.1:${port}`; return loaded; }
let modeCounter=1;

test("vulnerable fixture produces and independently verifies a finding",async t=>{
  const port=44171,child=await fixture("vulnerable",port); t.after(()=>child.kill("SIGTERM"));
  const manifest=configuredManifest(port),root=fs.mkdtempSync(path.join(os.tmpdir(),"hh-test-")),store=new Store(root); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read tenant A object","Tenant B is denied","Compare the same object across identities");
  const result=await investigateAuthorization(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user"});
  assert.equal(result.state,"reproduced");
  const replay=await replayFinding(store,manifest,result.findingId); assert.equal(replay.state,"independently_verified");
  assert.throws(()=>exportReport(store,manifest,result.findingId),{code:"STATE"});
  assert.equal(reviewFinding(store,manifest,result.findingId,"approve","fixture review").state,"reviewed");
  const report=exportReport(store,manifest,result.findingId); assert.match(fs.readFileSync(report,"utf8"),/Cross-identity object read/);
  const artifacts=fs.readdirSync(path.join(root,"artifacts")).map(file=>fs.readFileSync(path.join(root,"artifacts",file),"utf8")).join("\n");
  assert.doesNotMatch(artifacts,/fixture-token-[ab]/);
});

test("fixed fixture rejects the hypothesis and creates no finding",async t=>{
  const port=44172,child=await fixture("fixed",port); t.after(()=>child.kill("SIGTERM"));
  const manifest=configuredManifest(port),root=fs.mkdtempSync(path.join(os.tmpdir(),"hh-test-")),store=new Store(root); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  const hypothesis=store.hypothesis(manifest.engagement,"Tenant B can read tenant A object","Tenant B is denied","Compare identities");
  const result=await investigateAuthorization(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user"});
  assert.equal(result.state,"rejected"); assert.equal(store.list("finding",manifest.engagement).length,0);
});
