import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("per-target request budgets are enforced atomically",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-store-"))); t.after(()=>store.close());
  const manifest={engagement:"budget-test"}; store.createEngagement("fixture.json",manifest);
  store.incrementRequests("budget-test","t1",1);
  assert.throws(()=>store.incrementRequests("budget-test","t1",1),{code:"BUDGET"});
  store.incrementRequests("budget-test","t2",10);
  assert.equal(store.requestsUsed("budget-test"),2);
  store.pause("budget-test",true);
  assert.throws(()=>store.incrementRequests("budget-test","t3",10),{code:"BUDGET"});
  store.pause("budget-test",false);
  store.incrementRequests("budget-test","t3",10);
  assert.equal(store.requestsUsed("budget-test"),3);
});

test("revocation (pause fence + recovery) refuses the gateway and settles reservations",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-pause-"))); t.after(()=>store.close());
  store.createEngagement("fixture.json",{engagement:"pause-test"});
  const taskId=store.task("pause-test",null,"worker",{actionKey:"live",deadlineAt:null});
  store.reserveWorkerBudget("pause-test",0.05,0.01,taskId);
  store.pause("pause-test",true);
  assert.throws(()=>store.incrementRequests("pause-test","t1",10),{code:"BUDGET"});
  assert.equal(store.recover("pause-test",{staleSeconds:0}),1);
  const row=store.engagement("pause-test");
  assert.ok(Math.abs(row.cost_used-0.01)<1e-9,"open reservation charged as unknown spend on revocation");
  assert.equal(row.cost_unknown,1);
  assert.ok(Math.abs(row.reserved)<1e-9);
  const events=store.list("event","pause-test").map(e=>e.type);
  assert.ok(events.includes("task.recovered"));
});

test("interrupted tasks are recovered with incremented attempts and dedup is enforced",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-task-"))); t.after(()=>store.close());
  const manifest={engagement:"task-test"}; store.createEngagement("fixture.json",manifest);
  const key="authorization:/api/objects/a1:tenant-a-user:tenant-b-user";
  const first=store.task("task-test",null,"investigator",{actionKey:key});
  const unrelated=store.task("task-test",null,"investigator",{actionKey:"other-action"});
  const taskRow=value=>store.list("task","task-test").find(row=>row.id===value);
  assert.equal(taskRow(unrelated).attempt,1);
  assert.throws(()=>store.task("task-test",null,"investigator",{actionKey:key}),{code:"DEDUP",task_id:first});
  store.finishTask(first,"completed");
  const retried=store.task("task-test",null,"investigator",{actionKey:key});
  assert.equal(taskRow(retried).attempt,2);
  assert.equal(store.recover("task-test",{staleSeconds:0}),2);
  const recovered=taskRow(retried);
  assert.equal(recovered.state,"interrupted");
  const resumed=store.task("task-test",null,"investigator",{actionKey:key});
  assert.equal(taskRow(resumed).attempt,3);
  const events=store.list("event","task-test");
  assert.ok(events.some(row=>row.type==="task.recovered"));
});

test("concurrency limits dispatch when running tasks reach the cap",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-conc-"))); t.after(()=>store.close());
  const manifest={engagement:"conc-test"}; store.createEngagement("fixture.json",manifest);
  const first=store.task("conc-test",null,"investigator",{actionKey:"a",maxRunning:1});
  assert.throws(()=>store.task("conc-test",null,"investigator",{actionKey:"b",maxRunning:1}),{code:"CONCURRENCY"});
  store.finishTask(first,"completed");
  const second=store.task("conc-test",null,"investigator",{actionKey:"b",maxRunning:1});
  assert.throws(()=>store.task("conc-test",null,"verifier",{actionKey:"c",maxRunning:1}),{code:"CONCURRENCY"});
});
