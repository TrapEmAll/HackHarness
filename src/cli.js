#!/usr/bin/env node
import { loadManifest } from "./manifest.js";
import { Store } from "./store.js";
import { runtime } from "./runtime.js";
import path from "node:path";
import fs from "node:fs";
import { exportReport, investigateAuthorization, replayFinding, reviewFinding, delegateInvestigation, delegateReplay, autopilot, mapEngagement, benchmark, delegateReview, readSource, rawRequest } from "./workflow.js";
import { startProxy } from "./proxy.js";
import { json } from "./util.js";

function usage() {
  console.log(`HackHarness\n\n  hh open MANIFEST [--data DIR]\n  hh context MANIFEST [--data DIR]\n  hh map MANIFEST [--identity ID] [--data DIR]\n  hh bench MANIFEST --mode MODE [--trials N] [--path PATH] [--owner ID] [--other ID] [--data DIR]\n  hh observations MANIFEST [--data DIR]\n  hh sources MANIFEST [--data DIR]\n  hh source-read MANIFEST --source ID --file RELATIVE [--data DIR]\n  hh request MANIFEST --identity ID --path PATH [--method GET] [--purpose TEXT] [--body TEXT] [--data DIR]\n  hh proxy MANIFEST --identity ID [--port PORT] [--data DIR]\n  hh hypothesis MANIFEST --claim TEXT --control TEXT --check TEXT [--data DIR]\n  hh hypotheses MANIFEST [--data DIR]\n  hh findings MANIFEST [--data DIR]\n  hh tasks MANIFEST [--data DIR]\n  hh investigate MANIFEST HYPOTHESIS --path PATH --owner ID --other ID [--data DIR]\n  hh autopilot MANIFEST --path PATH --owner ID --other ID [--model ALIAS] [--data DIR]\n  hh delegate MANIFEST HYPOTHESIS --path PATH --owner ID --other ID [--model ALIAS] [--data DIR]\n  hh replay MANIFEST FINDING [--data DIR]\n  hh verify MANIFEST FINDING [--model ALIAS] [--data DIR]\n  hh review MANIFEST FINDING --decision approve|reject [--notes TEXT] [--data DIR]\n  hh assess MANIFEST FINDING [--model ALIAS] [--data DIR]\n  hh evidence MANIFEST EVIDENCE [--data DIR]\n  hh report MANIFEST FINDING [--data DIR]\n  hh pause MANIFEST [--data DIR]\n  hh resume MANIFEST [--data DIR]`);
}
function option(args,name,required=true) { const at=args.indexOf(name); if(at<0){if(required)throw new Error(`Missing ${name}`);return null;} return args[at+1]; }

function benchManifest(manifest, mode) {
  if (mode !== "vulnerable" && mode !== "fixed") throw Object.assign(new Error("bench --mode must be vulnerable or fixed"), { code: "INVALID" });
  // derived manifest for a labeled benchmark run; the underlying fixture must match --mode
  return { ...manifest, engagement: `${manifest.engagement}-bench-${mode}`, authorization: { ...manifest.authorization } };
}

// OMP workers receive HH_MANIFEST paths; a derived engagement only works when
// its manifest file exists (and relative references still resolve), so we
// materialize it beside the original manifest.
function materializeBenchManifest(manifestPath, manifest, mode) {
  const derivedPath = path.join(path.dirname(path.resolve(manifestPath)), `${path.basename(manifestPath, ".json")}-bench-${mode}.json`);
  fs.writeFileSync(derivedPath, JSON.stringify(manifest, null, 2));
  return derivedPath;
}
function cleanArgs(args) { const data=option(args,"--data",false); return {data,args:args.filter((x,i)=>x!=="--data"&&args[i-1]!=="--data")}; }

async function main() {
  const command=process.argv[2]; if(!command||command==="help"||command==="--help"){usage();return;}
  const cleaned=cleanArgs(process.argv.slice(3)), args=cleaned.args, manifestPath=args[0]; if(!manifestPath)throw new Error("Manifest path is required");
  if(command==="open") { const loaded=loadManifest(manifestPath),store=new Store(cleaned.data||process.env.HH_DATA_DIR||".hackharness-data"); store.createEngagement(loaded.absolute,loaded.manifest); console.log(json({engagement:loaded.manifest.engagement,state:"open",data:store.root})); store.close(); return; }
  const {store,manifest}=runtime(manifestPath,cleaned.data);
  try {
    if(command==="context") { const engagement=store.engagement(manifest.engagement); console.log(json({engagement:manifest.engagement,paused:Boolean(engagement.paused),requests_used:store.requestsUsed(manifest.engagement),cost:{used:engagement.cost_used||0,unreported_runs:engagement.cost_unknown||0,reserved:engagement.reserved||0},targets:manifest.targets.map(({id,origin,paths,methods,request_limit})=>({id,origin,paths,methods,request_limit})),identities:manifest.identities.map(({id,tenant,role})=>({id,tenant,role})),limits:manifest.limits})); }
    else if(command==="hypothesis") console.log(json({id:store.hypothesis(manifest.engagement,option(args,"--claim"),option(args,"--control"),option(args,"--check")),state:"proposed"}));
    else if(command==="hypotheses") console.log(json(store.list("hypothesis",manifest.engagement)));
    else if(command==="findings") console.log(json(store.list("finding",manifest.engagement).map(row=>({id:row.id,title:row.title,state:row.state,impact:row.impact,created_at:row.created_at,updated_at:row.updated_at}))));
    else if(command==="bench") { const derivedManifest=benchManifest(manifest,option(args,"--mode")); const benchPath=args.includes("--workers")?materializeBenchManifest(manifestPath,derivedManifest,option(args,"--mode")):manifestPath; console.log(json(await benchmark(store,derivedManifest,{path:option(args,"--path",false)||"/api/objects/a1",ownerIdentity:option(args,"--owner",false)||manifest.identities[0]?.id,otherIdentity:option(args,"--other",false)||manifest.identities[1]?.id,trials:Number(option(args,"--trials",false)||1),manifestPath:benchPath,workers:args.includes("--workers")}))); }
    else if(command==="request") console.log(json(await rawRequest(store,manifest,{identityId:option(args,"--identity"),path:option(args,"--path"),method:option(args,"--method",false)||"GET",purpose:option(args,"--purpose",false)||"manual scoped request",body:option(args,"--body",false)})));
    else if(command==="proxy") { const proxyPort=Number(option(args,"--port",false)||18080); const handle=await startProxy(store,manifest,{port:proxyPort,identityId:option(args,"--identity")}); console.log(json({listening:`http://127.0.0.1:${proxyPort}`,identity:option(args,"--identity"),lease:handle.lease})); const stop=async()=>{ await handle.close(); console.log(json({state:"stopped"})); process.exit(0); }; process.on("SIGINT",stop); process.on("SIGTERM",stop); await new Promise(()=>{}); }
    else if(command==="tasks") console.log(json(store.list("task",manifest.engagement).map(row=>({id:row.id,role:row.role,state:row.state,attempt:row.attempt,action_key:row.action_key,deadline_at:row.deadline_at,created_at:row.created_at,completed_at:row.completed_at}))));
    else if(command==="map") console.log(json(await mapEngagement(store,manifest,{identityId:option(args,"--identity",false)})));
    else if(command==="sources") console.log(json((manifest.sources||[]).map(({id,root})=>({id,root}))));
    else if(command==="source-read") console.log(json(readSource(store,manifest,{sourceId:option(args,"--source"),path:option(args,"--file")})));
    else if(command==="observations") console.log(json(store.list("observation",manifest.engagement).map(row=>({id:row.id,kind:row.kind,subject:row.subject,evidence_id:row.evidence_id,payload:JSON.parse(row.payload_json)}))));
    else if(command==="investigate") console.log(json(await investigateAuthorization(store,manifest,{hypothesisId:args[1],path:option(args,"--path"),ownerIdentity:option(args,"--owner"),otherIdentity:option(args,"--other")})));
    else if(command==="delegate") console.log(json(await delegateInvestigation(store,manifest,{hypothesisId:args[1],path:option(args,"--path"),ownerIdentity:option(args,"--owner"),otherIdentity:option(args,"--other"),model:option(args,"--model",false)})));
    else if(command==="autopilot") console.log(json(await autopilot(store,manifest,{path:option(args,"--path"),ownerIdentity:option(args,"--owner"),otherIdentity:option(args,"--other"),model:option(args,"--model",false)})));
    else if(command==="replay") console.log(json(await replayFinding(store,manifest,args[1])));
    else if(command==="verify") console.log(json(await delegateReplay(store,manifest,{findingId:args[1],model:option(args,"--model",false)})));
    else if(command==="review") console.log(json(reviewFinding(store,manifest,args[1],option(args,"--decision"),option(args,"--notes",false)||"")));
    else if(command==="assess") console.log(json(await delegateReview(store,manifest,{findingId:args[1],model:option(args,"--model",false)})));
    else if(command==="evidence") { const row=store.readEvidence(args[1]); if(!row)throw Object.assign(new Error("Evidence not found"),{code:"NOT_FOUND"}); console.log(json(row)); }
    else if(command==="report") console.log(json({path:exportReport(store,manifest,args[1])}));
    else if(command==="pause"||command==="resume") { store.pause(manifest.engagement,command==="pause"); console.log(json({engagement:manifest.engagement,state:command==="pause"?"paused":"open",gatewayBlocked:command==="pause"})); }
    else { usage(); process.exitCode=2; }
  } finally { store.close(); }
}
main().catch(error=>{ console.error(json({error:error.code||"ERROR",message:error.message})); process.exitCode=1; });
