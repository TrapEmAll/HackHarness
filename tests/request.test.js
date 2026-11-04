import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { rawRequest } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

async function fixture(port) {
  const child=spawn(process.execPath,["tests/fixture/server.js","vulnerable"],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([once(child.stdout,"data"),once(child,"exit").then(([code])=>{throw new Error(`Fixture exited ${code}`);})]);
  return child;
}

async function fixtureStore(name) {
  const port=44000+Math.floor(Math.random()*900);
  const child=await fixture(port);
  const manifest=loadManifest(manifestPath).manifest;
  manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=name;
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-req-"))); store.createEngagement(manifestPath,manifest);
  return {store,manifest,child};
}

test("raw request captures evidence under its own lease",async t=>{
  const {store,manifest,child}=await fixtureStore("request-ok"); t.after(()=>child.kill("SIGTERM"));
  const result=await rawRequest(store,manifest,{identityId:"tenant-a-user",path:"/api/objects/a1",purpose:"probe"});
  assert.equal(result.state,"captured"); assert.equal(result.status,200);
  const capture=store.readEvidence(result.evidenceId);
  assert.equal(capture.kind,"http.capture");
  assert.match(capture.content.request.url,/\/api\/objects\/a1$/);
  const tasks=store.list("task","request-ok").filter(row=>row.role==="requester");
  assert.equal(tasks.length,1); assert.equal(tasks[0].state,"completed");
});

test("raw request refuses unknown identities, undeclared methods, and paused engagements",async t=>{
  const {store,manifest,child}=await fixtureStore("request-refuse"); t.after(()=>child.kill("SIGTERM"));
  await assert.rejects(()=>rawRequest(store,manifest,{identityId:"nobody",path:"/api/objects/a1"}),{code:"IDENTITY"});
  await assert.rejects(()=>rawRequest(store,manifest,{identityId:"tenant-a-user",path:"/api/objects/a1",method:"POST"}),{code:"SCOPE"});
  store.pause("request-refuse",true);
  await assert.rejects(()=>rawRequest(store,manifest,{identityId:"tenant-a-user",path:"/api/objects/a1"}),{code:"BUDGET"});
  const running=store.list("task","request-refuse").filter(row=>row.state==="running");
  assert.equal(running.length,0,"refusals must not strand leases");
});

test("hh request over the real CLI completes a GET with no body flag",async t=>{
  const {store,manifest,child}=await fixtureStore("request-cli"); t.after(()=>child.kill("SIGTERM"));
  const file=path.join(store.root,"manifest.json"); fs.writeFileSync(file,JSON.stringify({...manifest,sources:[]}));
  fs.copyFileSync(path.resolve("examples/authorization.md"),path.join(store.root,"authorization.md"));
  const out=await new Promise((resolve,reject)=>{
    const proc=spawn(process.execPath,["src/cli.js","request",file,"--identity","tenant-a-user","--path","/api/objects/a1","--purpose","cli probe","--data",store.root],{cwd:process.cwd(),env:process.env,stdio:["ignore","pipe","pipe"]});
    let stdout="",stderr=""; proc.stdout.on("data",c=>stdout+=c); proc.stderr.on("data",c=>stderr+=c);
    proc.on("exit",code=>{ if(code!==0) return reject(new Error(`exit ${code}: ${stderr}`)); try { resolve(JSON.parse(stdout)); } catch(err){ reject(new Error(`unparsable: ${stdout}`)); } });
  });
  assert.equal(out.state,"captured"); assert.equal(out.status,200);
  const tasks=store.list("task","request-cli").filter(row=>row.role==="requester");
  assert.equal(tasks[0]?.state,"completed");
  const capture=store.readEvidence(out.evidenceId);
  assert.equal(capture.content.request.body,null);
});
