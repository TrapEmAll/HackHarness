import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";

test("pause and request budgets are enforced atomically",t=>{
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-store-"))); t.after(()=>store.close());
  const manifest={engagement:"budget-test"}; store.createEngagement("fixture.json",manifest);
  store.incrementRequests("budget-test",1);
  assert.throws(()=>store.incrementRequests("budget-test",1),{code:"BUDGET"});
  store.pause("budget-test",true);
  assert.throws(()=>store.incrementRequests("budget-test",10),{code:"BUDGET"});
  store.pause("budget-test",false);
  store.incrementRequests("budget-test",10);
  assert.equal(store.engagement("budget-test").requests_used,2);
});
