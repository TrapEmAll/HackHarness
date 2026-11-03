import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { loadManifest } from "../src/manifest.js";
import { delegateInvestigation } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";

test("worker cost reservations are capped atomically across concurrent dispatches",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-cost-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"cost-test"});
  const a=store.reserveWorkerBudget("cost-test",0.03,0.01), b=store.reserveWorkerBudget("cost-test",0.03,0.01);
  assert.equal(a,0.01); assert.equal(b,0.01);
  const c=store.reserveWorkerBudget("cost-test",0.03,0.01);
  assert.ok(Math.abs(c-0.01)<1e-9); // remaining 0.01 granted exactly
  assert.throws(()=>store.reserveWorkerBudget("cost-test",0.03,0.01),{code:"BUDGET"},"fourth dispatch must be refused");
  assert.ok(Math.abs(store.engagement("cost-test").reserved-0.03)<1e-9);
});

test("reported cost replaces the reservation; unknown cost retains it and is flagged",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-cost2-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"settle-test"});
  const taskId=store.task("settle-test",null,"worker",{actionKey:"t1"});
  store.reserveWorkerBudget("settle-test",1,0.02,taskId);
  store.settleTaskCost(taskId,0.015);
  let row=store.engagement("settle-test");
  assert.ok(Math.abs(row.cost_used-0.015)<1e-9);
  assert.equal(row.cost_unknown,0);
  const t2=store.task("settle-test",null,"worker",{actionKey:"t2"});
  store.reserveWorkerBudget("settle-test",1,0.01,t2);
  store.settleTaskCost(t2,null); // unreported: reservation retained as spent
  row=store.engagement("settle-test");
  assert.equal(row.cost_unknown,1);
  const t3=store.task("settle-test",null,"worker",{actionKey:"t3"});
  store.reserveWorkerBudget("settle-test",1,0.01,t3);
  store.settleTaskCost(t3,undefined,{released:true}); // never started: released
  row=store.engagement("settle-test");
  assert.ok(Math.abs(row.reserved)<1e-9);
});

test("two connections cannot double-charge a settled reservation",t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"hh-cost4-"));
  const first=new Store(root); first.createEngagement("fixture.json",{engagement:"duel"});
  const taskId=first.task("duel",null,"worker",{actionKey:"d1"});
  first.reserveWorkerBudget("duel",1,0.01,taskId);
  const second=new Store(root);
  second.settleTaskCost(taskId,0.01);
  second.settleTaskCost(taskId,0.01); // same task seen by another connection
  const row=second.engagement("duel");
  assert.ok(Math.abs(row.cost_used-0.01)<1e-9,"second settlement is a no-op");
  assert.ok(Math.abs(row.reserved)<1e-9);
  first.close(); second.close();
});

test("reserve failure leaves the task usable and charges nothing",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-cost5-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"cap-test"});
  const first=store.task("cap-test",null,"worker",{actionKey:"d1"});
  store.reserveWorkerBudget("cap-test",0.01,0.01,first); // cap fully consumed
  assert.throws(()=>store.reserveWorkerBudget("cap-test",0.01,0.01),{code:"BUDGET"});
  const row=store.engagement("cap-test");
  assert.ok(Math.abs(row.reserved-0.01)<1e-9);
});

test("refused dispatch leaves no running lease behind",async t=>{
  process.env.HH_FAKE_MODE="ok";
  const manifestPath=path.resolve("examples/local-fixture.json");
  const manifest=loadManifest(manifestPath).manifest; manifest.engagement="leak-test";
  manifest.workers={binary:"node",args:[path.resolve("tests/fake-omp.js")]};
  manifest.limits={requests_per_second:100,wall_clock_minutes:1,max_response_bytes:1000,max_cost_usd:0.01};
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-leak-"))); t.after(()=>store.close());
  store.createEngagement(manifestPath,manifest);
  // exhaust the cap deterministically at the store level (no reservation involved)
  store.db.prepare("UPDATE engagement SET cost_used=0.01 WHERE id=?").run("leak-test");
  const hypothesis=store.hypothesis(manifest.engagement,"Vendor B read again","denied","compare");
  await assert.rejects(()=>delegateInvestigation(store,manifest,{hypothesisId:hypothesis,path:"/api/objects/a1",ownerIdentity:"tenant-a-user",otherIdentity:"tenant-b-user",model:null}),{code:"BUDGET"});
  const running=store.list("task","leak-test").filter(row=>row.state==="running");
  assert.equal(running.length,0,"no leases may survive a budget refusal");
  const leaked=store.list("event","leak-test").filter(row=>row.type==="task.pre_dispatch_failed");
  assert.ok(leaked.length>=1);
  assert.ok(Math.abs(store.engagement("leak-test").reserved)<1e-9,"no residual reservations");
});

test("crash recovery charges interrupted reservations as unknown cost",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-cost3-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"crash-cost"});
  const taskId=store.task("crash-cost",null,"worker",{actionKey:"leak"});
  store.reserveWorkerBudget("crash-cost",0.05,0.02,taskId);
  assert.equal(store.recover("crash-cost"),1);
  const row=store.engagement("crash-cost");
  assert.ok(Math.abs(row.cost_used-0.02)<1e-9);
  assert.equal(row.cost_unknown,1);
  assert.equal(row.reserved,0);
  assert.equal(store.list("task","crash-cost").find(r=>r.id===taskId).cost_reserved,0);
});
