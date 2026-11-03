import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { RpcWorker, ABORT_GRACE_MS } from "../src/worker.js";

const extension = path.resolve("packages/omp-adapter/index.ts");
const fake = (mode) => ({ binary: "node", args: [path.resolve("tests/fake-omp.js")], extension: extension, envMode: mode });
const spawnWorker = async ({ mode = "ok", ...options } = {}) => {
  const worker = new RpcWorker({ ...fake(mode), ...options });
  process.env.HH_FAKE_MODE = mode;
  await worker.start();
  return worker;
};

test("rpc worker treats only the terminal agent_end as completion",async t=>{
  const worker=await spawnWorker(); t.after(()=>worker.close());
  const result=await worker.prompt("do the thing");
  assert.equal(result.aborted,false);
  assert.match(result.text,/worker said hi/);
  const stats=await worker.stats();
  assert.equal(stats.cost,0.01);
});

test("deadline abort resolves the prompt as an aborted attempt",async t=>{
  assert.ok(ABORT_GRACE_MS>0);
  const worker=await spawnWorker({mode:"stuck"}); t.after(()=>worker.close());
  const result=await worker.prompt("never finishes",{timeoutMs:250});
  assert.equal(result.aborted,true);
});

test("unexpected worker exit is a failed attempt with unknown outcome",async t=>{
  const worker=new RpcWorker({binary:"node",args:["-e","process.exit(3)"],extension});
  await assert.rejects(()=>worker.start(),{code:"WORKER"});
});

test("abi default",t=>{
  const worker=new RpcWorker({});
  assert.equal(worker.binary,"omp");
});
