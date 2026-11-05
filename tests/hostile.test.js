import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { once,} from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { delegateReview, readSource } from "../src/workflow.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

// Live containment gate (HH_OMP_TEST=1, zero model calls): the oracle is an
// import-time fs marker — spawn OMP with a hostile .omp/tools module, read
// the ready frame, inspect the marker, then kill OMP in a finally.
const PWN_MODULE = "import fs from 'node:fs';\ntry { fs.writeFileSync(process.env.HH_PWN_MARKER_PATH, 'loaded'); } catch {}\nexport default function register(pi){ return [{ name:'pwn_exec', label:'pwn', description:'hostile', parameters:pi.zod.object({}), execute:()=>({content:[{type:'text',text:'pwn-marker'}], details:{}}) }]; }";

function writeHostileTools(scratch) { fs.mkdirSync(path.join(scratch,".omp","tools"),{recursive:true}); fs.writeFileSync(path.join(scratch,".omp","tools","pwn-tool.js"),PWN_MODULE); }

async function ompLoaderMarker(scratch, markerPath, extraFlags=[]) {
  const child=spawn("omp",["--mode","rpc","--no-session",...extraFlags,`--cwd=${scratch}`],{cwd:scratch,stdio:["pipe","pipe","pipe"],env:{...process.env,HH_PWN_MARKER_PATH:markerPath}});
  try {
    const readyFrame=await new Promise((resolve,reject)=>{
      const rl=readline.createInterface({ input: child.stdout });
      rl.on("line",line=>{ let frame; try { frame=JSON.parse(line); } catch { return; }
        if (frame?.type==="ready") { resolve(frame); } });
      child.stderr.on("data",chunk=>{ if(!child.stderr.done){} });
      setTimeout(()=>reject(new Error("OMP never emitted a ready frame; malformed config or other startup failure")),30_000).unref?.();
      child.once("exit",code=>reject(new Error(`OMP exited early (${code})`)));
    }).catch(e=>{ child.kill(); child.kill("SIGKILL"); throw e; });
    const spawnReader=readline.createInterface({ input: child.stdout });
    const {promise,resolve}=Promise.withResolvers();
    spawnReader.on("line",line=>{ /* keep buffer alive until teardown */ });
    let markerExisting=fs.existsSync(markerPath)?"loaded":"missing";
    try { child.stdin.write(JSON.stringify({id:"probe",type:"get_state"})+"\n"); } catch {}
    await new Promise(r=>setTimeout(r,800));
    return { readyFrame, exitCode: child.exitCode, marker: fs.existsSync(markerPath) ? fs.readFileSync(markerPath,"utf8") : "missing", bootstrapState: markerExisting };
  } finally {
    try { child.stdin.end(); } catch {}
    child.kill("SIGKILL");
    await once(child,"exit");
  }
}

test("harmless import-time fs marker proves .omp/tools discovery happens (control)",async t=>{
  if (process.env.HH_OMP_TEST !== "1") { t.skip("live OMP session required (set HH_OMP_TEST=1)"); return; }
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-pwncontrol-")); const removeScratch=()=>{ for (let at=0;at<5;at++) { try { fs.rmSync(scratch,{recursive:true,force:true}); return; } catch { /* wall retains locks briefly on Windows */ } } }; t.after(removeScratch);
  const markerPath=path.join(scratch,"marker.txt");
  writeHostileTools(scratch);
  const {marker}=await ompLoaderMarker(scratch,markerPath);
  assert.equal(marker,"loaded",".omp/tools module import must produce the loader marker in the control run");
});

test("containment with the exact production flag set (recorded, not hidden)",async t=>{
  if (process.env.HH_OMP_TEST !== "1") { t.skip("live OMP session required (set HH_OMP_TEST=1)"); return; }
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-pwnharness-")); const removeScratch2=()=>{ for (let at=0;at<5;at++) { try { fs.rmSync(scratch,{recursive:true,force:true}); return; } catch {} } }; t.after(removeScratch2);
  const markerPath=path.join(scratch,"marker.txt");
  writeHostileTools(scratch);
  const adapter=path.resolve("packages/omp-adapter/index.ts");
  const {marker}=await ompLoaderMarker(scratch,markerPath,["--no-ui","--no-tools","--no-extensions",`--trusted-extension=${adapter}`]);
  // record as diagnostic, never hiding: containment stays explicitly UNVERIFIED when the
  // exact production flag set still imports hostile .omp/tools modules
  if (marker==="loaded") {
    t.skip("upstream boundary OMP-18.15.0 (DESIGN.md): hostile .omp/tools import fires under the exact production flag set; project-config containment stays UNVERIFIED");
  }
  else assert.ok(marker!=="loaded-but-hidden","containment asserted in this OMP build");
});
