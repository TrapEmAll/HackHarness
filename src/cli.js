#!/usr/bin/env node
import { loadManifest } from "./manifest.js";
import { Store } from "./store.js";
import { runtime } from "./runtime.js";
import { exportReport, investigateAuthorization, replayFinding, reviewFinding, delegateInvestigation, delegateReplay } from "./workflow.js";
import { json } from "./util.js";

function usage() {
  console.log(`HackHarness\n\n  hh open MANIFEST [--data DIR]\n  hh context MANIFEST [--data DIR]\n  hh hypothesis MANIFEST --claim TEXT --control TEXT --check TEXT [--data DIR]\n  hh hypotheses MANIFEST [--data DIR]\n  hh findings MANIFEST [--data DIR]\n  hh tasks MANIFEST [--data DIR]\n  hh investigate MANIFEST HYPOTHESIS --path PATH --owner ID --other ID [--data DIR]\n  hh delegate MANIFEST HYPOTHESIS --path PATH --owner ID --other ID [--model ALIAS] [--data DIR]\n  hh replay MANIFEST FINDING [--data DIR]\n  hh verify MANIFEST FINDING [--model ALIAS] [--data DIR]\n  hh review MANIFEST FINDING --decision approve|reject [--notes TEXT] [--data DIR]\n  hh evidence MANIFEST EVIDENCE [--data DIR]\n  hh report MANIFEST FINDING [--data DIR]\n  hh pause MANIFEST [--data DIR]\n  hh resume MANIFEST [--data DIR]`);
}
function option(args,name,required=true) { const at=args.indexOf(name); if(at<0){if(required)throw new Error(`Missing ${name}`);return null;} return args[at+1]; }
function cleanArgs(args) { const data=option(args,"--data",false); return {data,args:args.filter((x,i)=>x!=="--data"&&args[i-1]!=="--data")}; }

async function main() {
  const command=process.argv[2]; if(!command||command==="help"||command==="--help"){usage();return;}
  const cleaned=cleanArgs(process.argv.slice(3)), args=cleaned.args, manifestPath=args[0]; if(!manifestPath)throw new Error("Manifest path is required");
  if(command==="open") { const loaded=loadManifest(manifestPath),store=new Store(cleaned.data||process.env.HH_DATA_DIR||".hackharness-data"); store.createEngagement(loaded.absolute,loaded.manifest); console.log(json({engagement:loaded.manifest.engagement,state:"open",data:store.root})); store.close(); return; }
  const {store,manifest}=runtime(manifestPath,cleaned.data);
  try {
    if(command==="context") { const engagement=store.engagement(manifest.engagement); console.log(json({engagement:manifest.engagement,paused:Boolean(engagement.paused),requests_used:store.requestsUsed(manifest.engagement),targets:manifest.targets.map(({id,origin,paths,methods,request_limit})=>({id,origin,paths,methods,request_limit})),identities:manifest.identities.map(({id,tenant,role})=>({id,tenant,role})),limits:manifest.limits})); }
    else if(command==="hypothesis") console.log(json({id:store.hypothesis(manifest.engagement,option(args,"--claim"),option(args,"--control"),option(args,"--check")),state:"proposed"}));
    else if(command==="hypotheses") console.log(json(store.list("hypothesis",manifest.engagement)));
    else if(command==="findings") console.log(json(store.list("finding",manifest.engagement).map(row=>({id:row.id,title:row.title,state:row.state,impact:row.impact,created_at:row.created_at,updated_at:row.updated_at}))));
    else if(command==="tasks") console.log(json(store.list("task",manifest.engagement).map(row=>({id:row.id,role:row.role,state:row.state,attempt:row.attempt,action_key:row.action_key,deadline_at:row.deadline_at,created_at:row.created_at,completed_at:row.completed_at}))));
    else if(command==="investigate") console.log(json(await investigateAuthorization(store,manifest,{hypothesisId:args[1],path:option(args,"--path"),ownerIdentity:option(args,"--owner"),otherIdentity:option(args,"--other")})));
    else if(command==="delegate") console.log(json(await delegateInvestigation(store,manifest,{hypothesisId:args[1],path:option(args,"--path"),ownerIdentity:option(args,"--owner"),otherIdentity:option(args,"--other"),model:option(args,"--model",false)})));
    else if(command==="replay") console.log(json(await replayFinding(store,manifest,args[1])));
    else if(command==="verify") console.log(json(await delegateReplay(store,manifest,{findingId:args[1],model:option(args,"--model",false)})));
    else if(command==="review") console.log(json(reviewFinding(store,manifest,args[1],option(args,"--decision"),option(args,"--notes",false)||"")));
    else if(command==="evidence") { const row=store.readEvidence(args[1]); if(!row)throw Object.assign(new Error("Evidence not found"),{code:"NOT_FOUND"}); console.log(json(row)); }
    else if(command==="report") console.log(json({path:exportReport(store,manifest,args[1])}));
    else if(command==="pause"||command==="resume") { store.pause(manifest.engagement,command==="pause"); console.log(json({engagement:manifest.engagement,state:command==="pause"?"paused":"open"})); }
    else { usage(); process.exitCode=2; }
  } finally { store.close(); }
}
main().catch(error=>{ console.error(json({error:error.code||"ERROR",message:error.message})); process.exitCode=1; });
