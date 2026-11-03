import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { mapEngagement } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");
async function fixture(mode,port) {
  const child=spawn(process.execPath,["tests/fixture/server.js",mode],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([once(child.stdout,"data"), once(child,"exit").then(([code])=>{ throw new Error(`Fixture exited ${code}`); })]);
  return child;
}
let counter=100;

test("mapper records observations for vulnerable fixture with per-identity pools",async t=>{
  const port=`44${++counter}`, child=await fixture("vulnerable",port); t.after(()=>child.kill());
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=`map-vuln-${counter}`;
  const store=new Store(os.tmpdir()&&fs.mkdtempSync(path.join(os.tmpdir(),"hh-map-"))); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  const result=await mapEngagement(store,manifest,{});
  assert.ok(result.discovered.includes(`http://127.0.0.1:${port}/api/objects/a1`));
  const kinds=store.list("observation",manifest.engagement).map(row=>row.kind);
  assert.ok(kinds.includes("cross_identity.pool"),"vulnerable fixture exposes the same owner marker to every identity");
  const tasks=store.list("task",manifest.engagement);
  assert.equal(tasks.find(r=>r.role==="mapper").state,"completed");
});

test("mapper aborts discovery once the engagement wall-clock deadline passes",async t=>{
  const port=`44${++counter}`, child=await fixture("vulnerable",port); t.after(()=>child.kill());
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=`map-deadline-${counter}`;
  manifest.limits.wall_clock_minutes=0.0002; // ~12ms: expires between setup and the first hop
  await new Promise(r=>setTimeout(r,30));
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-mapd-"))); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  await assert.rejects(()=>mapEngagement(store,manifest,{}),{code:"BUDGET"});
  assert.equal(store.list("task",manifest.engagement).find(row=>row.role==="mapper").state,"failed");
});

test("mapper records authorization.denied observations on the fixed fixture",async t=>{
  const port=`44${++counter}`, child=await fixture("fixed",port); t.after(()=>child.kill());
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${port}`; manifest.engagement=`map-fixed-${counter}`;
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-mapf-"))); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  await mapEngagement(store,manifest,{});
  const observations=store.list("observation",manifest.engagement);
  const denied=observations.find(row=>row.kind==="authorization.denied"&&row.subject.endsWith("/api/objects/a1"));
  assert.ok(denied,"fixed fixture denies identity B on the object");
  assert.ok(!observations.some(row=>row.kind==="cross_identity.pool"&&row.subject.endsWith("/api/objects/a1")));
});
