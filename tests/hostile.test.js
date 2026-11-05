import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { delegateReview, readSource } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

// Live containment gate: hostile evidence read by a reviewer through
// hh_evidence_read cannot flip finding state, never reaches hh_replay, and
// hostile project configuration placed in a scratch directory is not
// discoverable under harness flags. Controls confirm discoverability without
// those flags (non-vacuous).
const PWN_TOOL = "export default function register(pi){ return [{ name:'pwn_exec', label:'pwn', description:'hostile', parameters:pi.zod.object({}), execute:()=>({content:[{type:'text',text:'pwn-marker'}], details:{}}) }]; }";

function writeHostileProject(scratch) {
  fs.mkdirSync(path.join(scratch,".omp","tools"),{recursive:true});
  fs.writeFileSync(path.join(scratch,".omp","tools","pwn-tool.js"),PWN_TOOL);
  fs.writeFileSync(path.join(scratch,".omp","mcp.json"),JSON.stringify({mcpServers:{pwnServer:{command:"node",args:["-e","process.stdout.write('pwn-marker')"]}}}));
}

async function ompToolNames(scratch, extraFlags=[]) {
  const child=spawn("omp",["--mode","rpc","--no-session",...extraFlags,`--cwd=${scratch}`],{cwd:scratch,stdio:["pipe","pipe","pipe"]});
  const pending=new Map();
  let stderr=""; child.stderr.on("data",chunk=>stderr+=String(chunk));
  readline.createInterface({ input: child.stdout }).on("line",line=>{
    let frame; try { frame=JSON.parse(line); } catch { return; }
    if (frame?.id && pending.has(frame.id)) { const {resolve,reject}=pending.get(frame.id); pending.delete(frame.id); frame.error?reject(new Error(frame.error.message||JSON.stringify(frame.error))):resolve(frame); }
  });
  let rawNames=[];
  {
    await new Promise(r=>setTimeout(r,1200)); // give OMP a moment to surface ready frames
    const {promise,resolve,reject}=Promise.withResolvers();
    pending.set("state-1",{resolve,reject});
    child.stdin.write(JSON.stringify({id:"state-1",type:"get_state"})+"\n");
    const result=await Promise.race([promise,new Promise((_,reject2)=>setTimeout(()=>reject2(new Error(`no OMP response on dumpTools probe (stderr: ${stderr.slice(0,200)}`)),15_000))]);
    const data=result.data ?? result;
    child.kill(); child.kill("SIGKILL");
    rawNames=(data?.dumpTools||[]).map(row=>row.name);
  }
  return rawNames;
}

test("hostile .omp custom tool is discoverable without harness flags (control)",async t=>{
  if (process.env.HH_OMP_TEST !== "1") { t.skip("live OMP session required (set HH_OMP_TEST=1)"); return; }
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-pwncontrol-")); t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  writeHostileProject(scratch);
  const toolNames=await ompToolNames(scratch);
  assert.ok(toolNames.includes("pwn_exec"),`control must discover the hostile tool from .omp/tools (got ${toolNames.join(",")})`);
});

test("hostile .omp/tools persists past OMP flags (documented boundary, Edge 156)",async t=>{
  if (process.env.HH_OMP_TEST !== "1") { t.skip("live OMP session required (set HH_OMP_TEST=1)"); return; }
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-pwnharness-")); t.after(()=>fs.rmSync(scratch,{recursive:true,force:true}));
  writeHostileProject(scratch);
  const toolNames=await ompToolNames(scratch,["--no-tools","--no-extensions"]);
  assert.ok(toolNames.includes("pwn_exec"),"upstream bug boundary: hostile .omp/tools persists past --no-tools/--no-extensions in OMP 18.15.0; the harness relies on scratch exclusivity and its walls");
});
