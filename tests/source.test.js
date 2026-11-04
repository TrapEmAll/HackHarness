import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { readSource } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

function setup() {
  const manifest=loadManifest(manifestPath).manifest; manifest.engagement="source-test";
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-src-"))); store.createEngagement(manifestPath,manifest);
  return {store,manifest};
}

test("declared source roots resolve, redact, and record evidence",t=>{
  const {store,manifest}=setup(); t.after(()=>store.close());
  const result=readSource(store,manifest,{sourceId:"fixture-src",path:"authz.js"});
  assert.match(result.content,/tenant === identity/);
  assert.equal(result.evidenceId.slice(0,2),"E-");
  const events=store.list("event",manifest.engagement).map(row=>row.type);
  assert.ok(events.includes("source.read") && events.includes("observation.recorded"));
  const captured=store.readEvidence(result.evidenceId);
  assert.ok(!String(captured.content).includes("fixture-token-a"),"identity secrets never persist in source snapshots");
});

test("traversal, escapes, directories, and unknown sources are rejected",t=>{
  const {store,manifest}=setup(); t.after(()=>store.close());
  assert.throws(()=>readSource(store,manifest,{sourceId:"fixture-src",path:"../examples/local-fixture.json"}),{code:"SCOPE"},"traversal out of the root");
  assert.throws(()=>readSource(store,manifest,{sourceId:"fixture-src",path:"../../outside"}),{code:"SCOPE"});
  assert.throws(()=>readSource(store,manifest,{sourceId:"fixture-src",path:"."}),{code:"SCOPE"});
  assert.throws(()=>readSource(store,manifest,{sourceId:"nope",path:"authz.js"}),{code:"NOT_FOUND"});
});

test("absolute paths outside the root are rejected",t=>{
  const {store,manifest}=setup(); t.after(()=>store.close());
  assert.throws(()=>readSource(store,manifest,{sourceId:"fixture-src",path:path.resolve(process.cwd(),"package.json")}),{code:"SCOPE"});
});
