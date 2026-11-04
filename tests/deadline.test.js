import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../src/gateway.js";
import { Store } from "../src/store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.HH_TOKEN_A="gateway-test-token";

test("gateway rejects tasks past their wall-clock deadline before touching the network",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-gw-"))); t.after(()=>store.close());
  const manifest={engagement:"gw-test",targets:[],identities:[{id:"tenant-a-user",secret_ref:"env://HH_TOKEN_A",tenant:"a",role:"user"}],limits:{}};
  const gateway=new Gateway(store,manifest);
  gateway.deadline=Date.now()-1;
  assert.rejects(()=>gateway.request({taskId:"T-x",identityId:"tenant-a-user",url:"http://127.0.0.1:1/api/"}),{code:"BUDGET"});
});

test("gateway fences leases that are no longer running before touching the network",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-fence-"))); t.after(()=>store.close());
  const manifest={engagement:"fence-test",targets:[],identities:[{id:"tenant-a-user",secret_ref:"env://HH_TOKEN_A",tenant:"a",role:"user"}],limits:{}};
  const taskId=store.task("fence-test",null,"investigator",{actionKey:"fenced"});
  store.finishTask(taskId,"completed");
  const gateway=new Gateway(store,manifest);
  assert.rejects(()=>gateway.request({taskId,identityId:"tenant-a-user",url:"http://127.0.0.1:1/api/"}),{code:"BUDGET",message:/fenced/});
  assert.equal(store.requestsUsed("fence-test"),0,"no budget charged for a fenced lease");
});
