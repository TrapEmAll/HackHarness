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
  assert.equal(store.recover("task-test"),2);
  const recovered=taskRow(retried);
  assert.equal(recovered.state,"interrupted");
  const resumed=store.task("task-test",null,"investigator",{actionKey:key});
  assert.equal(taskRow(resumed).attempt,3);
  const events=store.list("event","task-test");
  assert.ok(events.some(row=>row.type==="task.recovered"));
});
