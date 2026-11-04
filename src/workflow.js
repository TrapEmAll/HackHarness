import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { atomicWrite, json, now, redactText, sha256 } from "./util.js";
import { Gateway } from "./gateway.js";
import { identitySecret } from "./manifest.js";
import { resolveSourcePath } from "./policy.js";
import { RpcWorker } from "./worker.js";

export const HH_ADAPTER = fileURLToPath(new URL("../packages/omp-adapter/index.ts", import.meta.url));

// Source-assisted planning: read files from manifest-declared read-only roots.
// Content is identity-redacted before persistence; the artifact and observation
// carry the digest for replay.
export function readSource(store, manifest, { sourceId, path: relative } = {}) {
  const source = (manifest.sources || []).find(entry => entry.id === sourceId);
  if (!source) throw Object.assign(new Error(`No declared source ${sourceId}`), { code: "NOT_FOUND" });
  const resolved = resolveSourcePath(source, relative || ".");
  const secrets = manifest.identities.map(identity => { try { return identitySecret(identity); } catch (e) { return null; } });
  const redacted = redactText(fs.readFileSync(resolved.absolute, "utf8"), secrets);
  const digest = sha256(redacted);
  const artifact = json({ schema_version: 1, source: sourceId, path: relative, bytes: resolved.bytes, content: redacted });
  const evidenceId = store.evidence(manifest.engagement, null, "source.snapshot", artifact, { source: sourceId, path: relative, bytes: resolved.bytes, digest });
  const observationId = store.observation(manifest.engagement, "source.read", `${sourceId}:${relative}`, evidenceId, { bytes: resolved.bytes, digest });
  store.event(manifest.engagement, "source.read", evidenceId, { source: sourceId, path: relative });
  return { evidenceId, observationId, bytes: resolved.bytes, digest, content: redacted };
}

function compareOwnership(owner, other, ownerIdentity) {
  if (owner.status < 200 || owner.status >= 300) return {supported:false,reason:"Owner baseline did not succeed"};
  if (other.status === 401 || other.status === 403 || other.status === 404) return {supported:false,reason:"Negative control was denied"};
  if (other.status < 200 || other.status >= 300) return {supported:false,reason:`Negative control returned ${other.status}`};
  if (!owner.json || !other.json) return {supported:false,reason:"Responses were not JSON"};
  const ownerMarker=owner.json.owner ?? owner.json.owner_id ?? owner.json.user_id ?? null;
  const otherMarker=other.json.owner ?? other.json.owner_id ?? other.json.user_id ?? null;
  if (!ownerMarker || ownerMarker !== otherMarker) return {supported:false,reason:"No stable owner marker was exposed to both identities"};
  const sensitiveKeys=["secret","email","token","balance","ssn","content","private"];
  const exposed=sensitiveKeys.filter(key=>Object.hasOwn(other.json,key));
  if (!exposed.length) return {supported:false,reason:"No configured protected field was exposed"};
  return {supported:true,reason:`Different identity read ${exposed.join(", ")} belonging to ${ownerMarker}`,ownerMarker,exposed};
}

export async function investigateAuthorization(store,manifest,{hypothesisId,path:resourcePath,ownerIdentity,otherIdentity}) {
  const hypothesis=store.db.prepare("SELECT * FROM hypothesis WHERE id=? AND engagement_id=?").get(hypothesisId,manifest.engagement);
  if (!hypothesis) throw Object.assign(new Error("Hypothesis not found in engagement"),{code:"NOT_FOUND"});
  const target=manifest.targets[0], url=new URL(resourcePath,target.origin).href;
  const deadline=Date.now()+manifest.limits.wall_clock_minutes*60_000;
  const actionKey=`authorization:${resourcePath}:${ownerIdentity}:${otherIdentity}`;
  const taskId=store.task(manifest.engagement,hypothesisId,"investigator",{actionKey,deadlineAt:new Date(deadline).toISOString(),maxRunning:manifest.limits.concurrency}); store.setHypothesis(hypothesisId,"investigating");
  try {
    const gateway=new Gateway(store,manifest); gateway.deadline=deadline;
    const owner=await gateway.request({taskId,identityId:ownerIdentity,url,purpose:"owner baseline"});
    const other=await gateway.request({taskId,identityId:otherIdentity,url,purpose:"negative authorization control"});
    const result=compareOwnership(owner,other,ownerIdentity);
    store.finishTask(taskId,"completed"); store.setHypothesis(hypothesisId,result.supported?"supported":"rejected");
    if (!result.supported) return {taskId,state:"rejected",reason:result.reason,evidence:[owner.evidenceId,other.evidenceId]};
    const replay={type:"authorization_read",path:resourcePath,owner_identity:ownerIdentity,other_identity:otherIdentity,expected_owner:result.ownerMarker,protected_fields:result.exposed};
    const findingId=store.finding(manifest.engagement,hypothesisId,"Cross-identity object read",[owner.evidenceId,other.evidenceId],replay,result.reason,"reproduced");
    return {taskId,findingId,state:"reproduced",reason:result.reason,evidence:[owner.evidenceId,other.evidenceId]};
  } catch(error) { store.finishTask(taskId,"failed"); store.setHypothesis(hypothesisId,"inconclusive"); throw error; }
}

// Reviewer playbook: scope, impact, duplication, report-quality assessment on
// replicated evidence — read-only; the reviewer never changes finding state.
export async function delegateReview(store, manifest, { findingId, model } = {}) {
  const finding = store.findingById(findingId);
  if (!finding || finding.engagement_id !== manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"), { code: "NOT_FOUND" });
  if (!["reproduced","independently_verified"].includes(finding.state)) throw Object.assign(new Error(`Finding in state ${finding.state} is not ready for assessment`), { code: "STATE" });
  const deadline = Date.now() + manifest.limits.wall_clock_minutes * 60_000;
  const dispatchKey = `worker-review:${findingId}`;
  const taskId = store.task(manifest.engagement, finding.hypothesis_id, "worker", { actionKey: dispatchKey, deadlineAt: new Date(deadline).toISOString(), maxRunning: manifest.limits.concurrency });
  let allocation;
  try { allocation = store.reserveWorkerBudget(manifest.engagement, manifest.limits.max_cost_usd, manifest.limits.cost_reserve_usd, taskId); }
  catch (error) { store.finishTask(taskId, "failed"); store.settleTaskCost(taskId, 0, { released: true }); store.event(manifest.engagement, "task.pre_dispatch_failed", taskId, { code: error.code }); throw error; }
  const modelAlias = model || manifest.workers.routing?.reviewer || manifest.workers.routing?.verifier || manifest.workers.routing?.investigator;
  const worker = new RpcWorker({ binary: manifest.workers.binary, args: manifest.workers.args || [], model: modelAlias, maxCostUsd: Number.isFinite(allocation) ? allocation : manifest.limits.max_cost_usd, extension: HH_ADAPTER, yolo: true, role: "reviewer", env: { ...process.env, HH_ROLE: "reviewer", HH_MANIFEST: store.engagement(manifest.engagement).manifest_path, HH_DATA_DIR: store.root } });
  store.event(manifest.engagement,"reviewer.started",taskId,{finding:findingId,model:modelAlias||null});
  let result, started=false;
  let beat;
  try {
    await worker.start(); started=true;
    beat=setInterval(()=>store.heartbeat(taskId),30_000);
    const timeoutMs = Math.max(0, deadline - Date.now()) || 30_000;
    const brief = [
      `You are the HackHarness reviewer for finding ${findingId} in engagement ${manifest.engagement}.`,
      `Use ONLY hh_* tools; you have no other tools. hh_evidence_read with each evidence id; hh_findings to check duplicates. Do not use target-facing tools like hh_replay (read-only assessment).`,
      `Evidence ids: ${finding.evidence.join(", ")}. Claim: ${finding.title}. Impact: ${finding.impact}.`,
      `Report exactly one final line of JSON: {"findingId":"${findingId}","scope_ok":true|false,"duplicate_of":"<finding id or null>","impact":true|false,"report_quality":"<pass|needs_work>","notes":"<short text>"}.`,
    ].join("\n");
    result = await worker.prompt(brief,{timeoutMs});
    const stats=await worker.stats();
    if (stats?.cost !== undefined) store.event(manifest.engagement,"worker.cost",taskId,{cost:stats.cost,tokens:stats.tokens?.total});
    if (result.failure || result.aborted) throw Object.assign(new Error(`Worker attempt failed: ${result.failure?.message || "run aborted at the task deadline"}`),{code:result.failure?.code||"WORKER"});
    const line=result.text.split(/\r?\n/).map(part=>part.trim()).filter(Boolean).pop();
    let assessment; try { assessment=JSON.parse(line); } catch { throw Object.assign(new Error("Reviewer turn completed without a parseable final JSON verdict"), { code: "WORKER" }); }
    if (assessment.findingId !== findingId || typeof assessment.scope_ok !== "boolean") throw Object.assign(new Error("Reviewer verdict did not reference the finding"), { code: "WORKER" });
    store.settleTaskCost(taskId, stats?.cost ?? null);
    const outcome={taskId, model: modelAlias||null, assessment, cost: stats?.cost ?? null, reservation: allocation};
    store.event(manifest.engagement,"reviewer.assessment",findingId,{taskId,assessment});
    store.finishTask(taskId,"completed");
    store.event(manifest.engagement,"worker.completed",taskId,{...outcome,text:result.text});
    return outcome;
  } catch(error) {
    store.settleTaskCost(taskId, started ? null : undefined, { released: !started });
    store.finishTask(taskId,"failed");
    store.event(manifest.engagement,"worker.failed",taskId,{error:error.message,code:error.code,text:result?.text});
    throw error;
  } finally {
    clearInterval(beat);
    await worker.close();
  }
}

export async function delegateInvestigation(store, manifest, { hypothesisId, path: resourcePath, ownerIdentity, otherIdentity, model }) {
  const hypothesis = store.db.prepare("SELECT * FROM hypothesis WHERE id=? AND engagement_id=?").get(hypothesisId, manifest.engagement);
  if (!hypothesis) throw Object.assign(new Error("Hypothesis not found in engagement"), { code: "NOT_FOUND" });
  const deadline = Date.now() + manifest.limits.wall_clock_minutes * 60_000;
  // Independent lease for the worker process; the inner hh_investigate_authorization
  // call re-deduplicates on the normalized action it shares with direct runs.
  const dispatchKey = `worker:${hypothesisId}:${resourcePath}:${ownerIdentity}:${otherIdentity}`;
  const taskId = store.task(manifest.engagement, hypothesisId, "worker", { actionKey: dispatchKey, deadlineAt: new Date(deadline).toISOString(), maxRunning: manifest.limits.concurrency });
  let allocation;
  try { allocation = store.reserveWorkerBudget(manifest.engagement, manifest.limits.max_cost_usd, manifest.limits.cost_reserve_usd, taskId); }
  catch (error) { store.finishTask(taskId, "failed"); store.settleTaskCost(taskId, 0, { released: true }); store.event(manifest.engagement, "task.pre_dispatch_failed", taskId, { code: error.code }); throw error; }
  const modelAlias = model || manifest.workers.routing?.investigator;
  const worker = new RpcWorker({ binary: manifest.workers.binary, args: manifest.workers.args || [], model: modelAlias, maxCostUsd: Number.isFinite(allocation) ? allocation : manifest.limits.max_cost_usd, extension: HH_ADAPTER, yolo: true, env: { ...process.env, HH_MANIFEST: store.engagement(manifest.engagement).manifest_path, HH_DATA_DIR: store.root } });
  store.event(manifest.engagement, "worker.started", taskId, { hypothesis: hypothesisId, model: modelAlias || null, binary: manifest.workers.binary });
  let outcome, result, started=false;
  let beat;
  try {
    await worker.start(); started=true;
    beat=setInterval(()=>store.heartbeat(taskId),30_000);
    const timeoutMs = Math.max(0, deadline - Date.now()) || 30_000;
    const priorInvestigatorTasks = new Set(store.list("task", manifest.engagement).filter(row=>row.role==="investigator").map(row=>row.id));
    const priorFindings = new Set(store.list("finding", manifest.engagement).map(row=>row.id));
    const brief = [
      `You are the HackHarness investigator for task ${taskId} in engagement ${manifest.engagement}.`,
      `Use ONLY the provided hh_* tools; you have no other tools. Use no filesystem or network access except through them.`,
      `Call hh_context. Then call hh_investigate_authorization exactly with: hypothesis_id=${hypothesisId}, path=${resourcePath}, owner_identity=${ownerIdentity}, other_identity=${otherIdentity}.`,
      `Finish with one final line of JSON: {"taskId":"<id>","state":"<state>","findingId":"<id or null>"}.`,
      `Claim: ${hypothesis.claim} Control: ${hypothesis.control}`,
    ].join("\n");
    result = await worker.prompt(brief, { timeoutMs });
    const stats = await worker.stats();
    if (stats?.cost !== undefined) store.event(manifest.engagement, "worker.cost", taskId, { cost: stats.cost, tokens: stats.tokens?.total });
    if (result.failure || result.aborted) throw Object.assign(new Error(`Worker attempt failed: ${result.failure?.message || "run aborted at the task deadline"}`), { code: result.failure?.code || "WORKER" });
    const inner = store.list("task", manifest.engagement).find(row=>row.role==="investigator" && !priorInvestigatorTasks.has(row.id));
    const finding = store.list("finding", manifest.engagement).find(row=>!priorFindings.has(row.id));
    if (!inner) throw Object.assign(new Error("Worker turn completed without creating an investigation task for its action"), { code: "WORKER" });
    store.settleTaskCost(taskId, stats?.cost ?? null);
    outcome = {
      taskId, workerState: "completed", model: modelAlias || null,
      innerTaskId: inner.id, finding: finding ? { id: finding.id, state: finding.state } : null,
      cost: stats?.cost ?? null, reservation: allocation,
    };
    store.finishTask(taskId, "completed");
    store.event(manifest.engagement, "worker.completed", taskId, { ...outcome, text: result.text });
  } catch (error) {
    store.settleTaskCost(taskId, started ? null : undefined, { released: !started });
    store.finishTask(taskId, "failed");
    store.event(manifest.engagement, "worker.failed", taskId, { error: error.message, code: error.code, text: result?.text });
    outcome = { taskId, state: "failed", error: error.message, code: error.code || "WORKER" };
    throw error;
  } finally {
    clearInterval(beat);
    await worker.close();
  }
  return outcome;
}

export async function replayFinding(store,manifest,findingId) {
  const finding=store.findingById(findingId);
  if (!finding || finding.engagement_id!==manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"),{code:"NOT_FOUND"});
  if (finding.replay.type!=="authorization_read") throw Object.assign(new Error("Unsupported replay type"),{code:"REPLAY"});
  const deadline=Date.now()+manifest.limits.wall_clock_minutes*60_000;
  const taskId=store.task(manifest.engagement,finding.hypothesis_id,"verifier",{actionKey:`replay:${findingId}`,deadlineAt:new Date(deadline).toISOString(),maxRunning:manifest.limits.concurrency}), gateway=new Gateway(store,manifest); gateway.deadline=deadline;
  const url=new URL(finding.replay.path,manifest.targets[0].origin).href;
  try {
    const owner=await gateway.request({taskId,identityId:finding.replay.owner_identity,url,purpose:"independent owner replay"});
    const other=await gateway.request({taskId,identityId:finding.replay.other_identity,url,purpose:"independent negative control replay"});
    const result=compareOwnership(owner,other,finding.replay.owner_identity);
    const exact=result.supported && result.ownerMarker===finding.replay.expected_owner && finding.replay.protected_fields.every(key=>result.exposed.includes(key));
    store.finishTask(taskId,"completed"); store.setFinding(findingId,exact?"independently_verified":"stale");
    return {taskId,findingId,state:exact?"independently_verified":"stale",reason:result.reason,evidence:[owner.evidenceId,other.evidenceId]};
  } catch(error) { store.finishTask(taskId,"failed"); throw error; }
}

const PATH_LIKE = /^\/[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

function ownerMarker(json) {
  const marker = json?.owner ?? json?.owner_id ?? json?.user_id ?? null;
  return marker === null ? null : String(marker);
}

function childPaths(json) {
  if (!json) return [];
  const values = Array.isArray(json) ? json : Object.values(json).flat();
  return values.filter(value => typeof value === "string" && PATH_LIKE.test(value)).slice(0, 25);
}

// Mapper playbook: bounded read-only navigation for the application map.
// Probes target-declared path prefixes and JSON-discovered children with each
// declared identity through the scoped gateway, then records facts as
// observations: endpoint probes per identity plus authorization diffs.
export async function mapEngagement(store, manifest, { identityId, model } = {}) {
  const identities = manifest.identities.filter(identity => !identityId || identity.id === identityId);
  if (!identities.length) throw Object.assign(new Error("No matching identity for mapping"), { code: "IDENTITY" });
  const deadline = Date.now() + manifest.limits.wall_clock_minutes * 60_000;
  const taskId = store.task(manifest.engagement, null, "mapper", { maxRunning: manifest.limits.concurrency, deadlineAt: new Date(deadline).toISOString() });
  const gateway = new Gateway(store, manifest); gateway.deadline = deadline;
  const probes = new Map(); // path -> { identityId: {evidence,status,marker} }
  const queue = [];
  for (const target of manifest.targets) for (const prefix of target.paths) queue.push(new URL(prefix, target.origin).href);
  try {
    while (queue.length) {
      const path_ = queue.shift();
      for (const identity of identities) {
        const result = await gateway.request({ taskId, identityId: identity.id, url: path_, purpose: "mapper discovery" });
        const marker = result.json ? ownerMarker(result.json) : null;
        (probes.get(path_) ?? probes.set(path_, {}).get(path_))[identity.id] = { evidence: result.evidenceId, status: result.status, marker };
        for (const child of childPaths(result.json)) { const child_ = new URL(child, path_).href; if (!probes.has(child_) && !queue.includes(child_)) queue.push(child_); }
      }
      const perIdentity = probes.get(path_);
      if (identities.length > 1) {
        const statuses = new Set(Object.values(perIdentity).map(row=>row.status));
        const markers = new Set(Object.values(perIdentity).map(row=>row.marker));
        let kind, reason;
        if (statuses.size > 1 && Object.values(perIdentity).some(row=>row.status>=400)) { kind="authorization.denied"; reason="identity outcomes differed (status) on the same object"; }
        else if (markers.size > 1) { kind="authorization.diff"; reason="identities saw different owner markers on the same object"; }
        else if (markers.size===1 && Object.values(perIdentity)[0].marker) { kind="cross_identity.pool"; reason="every declared identity was exposed the same owner marker"; }
        else { kind="uniform"; reason="identities agree with no owner marker"; }
        store.observation(manifest.engagement, kind, path_, Object.values(perIdentity)[0].evidence, { identity_probes: perIdentity, reason });
      } else {
        const probe = perIdentity[identities[0].id];
        store.observation(manifest.engagement, "endpoint.probe", path_, probe.evidence, { identity: identities[0].id, status: probe.status, marker: probe.marker });
      }
    }
    store.finishTask(taskId,"completed");
  } catch(error) { store.finishTask(taskId,"failed"); throw error; }
  return { taskId, discovered: [...probes.keys()], probes:[...probes.values()] };
}

// Deterministic benchmark of the authorization playbook against a labeled
// fixture. It does NOT exercise the model planner; it measures the machinery:
// supported findings, independent replay success, requests, time, scope burns.
export async function benchmark(store, manifest, { path: resourcePath, ownerIdentity, otherIdentity, trials = 1, manifestPath } = {}) {
  if (!resourcePath || !ownerIdentity || !otherIdentity) throw Object.assign(new Error("benchmark requires --path --owner --other"), { code: "INVALID" });
  const rounds = Math.max(1, Math.round(trials));
  const engagement = manifest.engagement;
  if (!store.engagement(engagement)) store.createEngagement(manifestPath || `${engagement}.json`, manifest);
  const startedAt = store.requestsUsed(engagement), startedMS = Date.now();
  let scopeViolations = 0, reproduced = 0, verified = 0;
  const rows = [];
  const hypothesis = store.hypothesis(engagement, `Fixture bench: ${resourcePath}`, "fixture control denies identity", `Compare ${resourcePath} across identities`);
  for (let trial = 0; trial < rounds; trial++) {
    try {
      const result = await investigateAuthorization(store, manifest, { hypothesisId: hypothesis, path: resourcePath, ownerIdentity, otherIdentity });
      const replayState = result.findingId ? (await replayFinding(store, manifest, result.findingId)).state : null;
      if (result.state === "reproduced") reproduced++;
      if (replayState === "independently_verified") verified++;
      rows.push({ trial, state: result.state, findingId: result.findingId, replayState });
    } catch (error) {
      if (error.code === "SCOPE") scopeViolations++;
      rows.push({ trial, error: error.code || "ERROR" });
    }
  }
  const requests = store.requestsUsed(engagement) - startedAt;
  const elapsed = Date.now() - startedMS;
  const summary = {
    trials: rounds, denominator: rounds, incomplete: rows.filter(row=>row.error).length,
    reproduced, independently_verified: verified,
    precision_of_supported_claims: verified / (verified + rows.filter(row=>row.state==="rejected").length || 1),
    requests_per_trial: Number((requests / rounds).toFixed(2)),
    requests_total: requests, elapsed_ms: elapsed,
    replay_success_rate: reproduced ? Number((verified / reproduced).toFixed(3)) : null,
    scope_violations: scopeViolations,
    fixture_is_read_only: manifest.targets.every(target=>target.methods.every(method=>["GET","HEAD","OPTIONS"].includes(method))),
    rows,
  };
  store.event(engagement,"benchmark.completed",null,{hypothesis,...summary});
  return summary;
}

export async function autopilot(store, manifest, { path: resourcePath, ownerIdentity, otherIdentity, model }) {
  if (!resourcePath) throw Object.assign(new Error("autopilot requires --path"), { code: "INVALID" });
  if (!ownerIdentity || !otherIdentity) throw Object.assign(new Error("autopilot requires --owner and --other identities"), { code: "INVALID" });
  const proposed = store.list("hypothesis", manifest.engagement).filter(row=>row.state==="proposed").map(row=>row.id);
  // each delegate holds the worker lease plus its inner investigation at peak
  const waveSize = Math.max(1, Math.floor((manifest.limits.concurrency || 1) / 2));
  const results = [];
  for (let at = 0; at < proposed.length; at += waveSize) {
    const settled = await Promise.allSettled(proposed.slice(at, at + waveSize).map(hypothesisId =>
      delegateInvestigation(store, manifest, { hypothesisId, path: resourcePath, ownerIdentity, otherIdentity, model })));
    settled.forEach((outcome, index) => results.push(outcome.status === "fulfilled"
      ? { hypothesis: proposed[at + index], ...outcome.value }
      : { hypothesis: proposed[at + index], error: outcome.reason.message, code: outcome.reason.code || "WORKER" }));
  }
  const remaining = store.list("hypothesis", manifest.engagement).filter(row=>row.state==="proposed").length;
  store.event(manifest.engagement, "autopilot.finished", null, { dispatched: proposed.length, results: results.length, remaining });
  return { dispatched: proposed.length, waveSize, results, remaining };
}

export async function delegateReplay(store, manifest, { findingId, model }) {
  const finding = store.findingById(findingId);
  if (!finding || finding.engagement_id !== manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"), { code: "NOT_FOUND" });
  if (finding.replay.type !== "authorization_read") throw Object.assign(new Error("Unsupported replay type"), { code: "REPLAY" });
  const deadline = Date.now() + manifest.limits.wall_clock_minutes * 60_000;
  const dispatchKey = `worker-replay:${findingId}`;
  const taskId = store.task(manifest.engagement, finding.hypothesis_id, "worker", { actionKey: dispatchKey, deadlineAt: new Date(deadline).toISOString(), maxRunning: manifest.limits.concurrency });
  let allocation;
  try { allocation = store.reserveWorkerBudget(manifest.engagement, manifest.limits.max_cost_usd, manifest.limits.cost_reserve_usd, taskId); }
  catch (error) { store.finishTask(taskId, "failed"); store.settleTaskCost(taskId, 0, { released: true }); store.event(manifest.engagement, "task.pre_dispatch_failed", taskId, { code: error.code }); throw error; }
  const modelAlias = model || manifest.workers.routing?.verifier || manifest.workers.routing?.investigator;
  const worker = new RpcWorker({ binary: manifest.workers.binary, args: manifest.workers.args || [], model: modelAlias, maxCostUsd: Number.isFinite(allocation) ? allocation : manifest.limits.max_cost_usd, extension: HH_ADAPTER, yolo: true, env: { ...process.env, HH_MANIFEST: store.engagement(manifest.engagement).manifest_path, HH_DATA_DIR: store.root } });
  store.event(manifest.engagement, "worker.started", taskId, { hypothesis: finding.hypothesis_id, replay: findingId, model: modelAlias || null, binary: manifest.workers.binary });
  let outcome, result, started=false;
  let beat;
  try {
    await worker.start(); started=true;
    beat=setInterval(()=>store.heartbeat(taskId),30_000);
    const timeoutMs = Math.max(0, deadline - Date.now()) || 30_000;
    const priorVerifierTasks = new Set(store.list("task", manifest.engagement).filter(row=>row.role==="verifier").map(row=>row.id));
    const brief = [
      `You are the HackHarness independent verifier in engagement ${manifest.engagement}.`,
      `Use ONLY the hh_* tools; you have no other tools.`,
      `Call hh_replay with finding_id=${findingId}. Report without commentary one final line of JSON: {"findingId":"${findingId}","state":"<resulting state>"}.`,
    ].join("\n");
    result = await worker.prompt(brief, { timeoutMs });
    const stats = await worker.stats();
    if (stats?.cost !== undefined) store.event(manifest.engagement, "worker.cost", taskId, { cost: stats.cost, tokens: stats.tokens?.total });
    if (result.failure || result.aborted) throw Object.assign(new Error(`Worker attempt failed: ${result.failure?.message || "run aborted at the task deadline"}`), { code: result.failure?.code || "WORKER" });
    const verifier = store.list("task", manifest.engagement).find(row=>row.role==="verifier" && !priorVerifierTasks.has(row.id));
    if (!verifier) throw Object.assign(new Error("Worker verifier turn completed without creating a replay task"), { code: "WORKER" });
    store.settleTaskCost(taskId, stats?.cost ?? null);
    const replayed = store.findingById(findingId);
    outcome = { taskId, workerState: "completed", verifierTaskId: verifier.id, replayState: replayed?.state, cost: stats?.cost ?? null, reservation: allocation };
    store.finishTask(taskId, "completed");
    store.event(manifest.engagement, "worker.completed", taskId, { ...outcome, text: result.text });
  } catch (error) {
    store.settleTaskCost(taskId, started ? null : undefined, { released: !started });
    store.finishTask(taskId, "failed");
    store.event(manifest.engagement, "worker.failed", taskId, { error: error.message, code: error.code, text: result?.text });
    outcome = { taskId, state: "failed", error: error.message, code: error.code || "WORKER" };
    throw error;
  } finally {
    clearInterval(beat);
    await worker.close();
  }
  return outcome;
}

export function reviewFinding(store,manifest,findingId,decision,notes="") {
  const finding=store.findingById(findingId);
  if (!finding || finding.engagement_id!==manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"),{code:"NOT_FOUND"});
  if (finding.state!=="independently_verified") throw Object.assign(new Error("Only independently verified findings can be reviewed"),{code:"STATE"});
  if (!['approve','reject'].includes(decision)) throw Object.assign(new Error("Review decision must be approve or reject"),{code:"INVALID"});
  store.setFinding(findingId,decision==='approve'?"reviewed":"rejected");
  store.event(manifest.engagement,"finding.review_decision",findingId,{decision,notes});
  return {findingId,state:decision==='approve'?"reviewed":"rejected",notes};
}

export function exportReport(store,manifest,findingId) {
  const finding=store.findingById(findingId);
  if (!finding || finding.engagement_id!==manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"),{code:"NOT_FOUND"});
  if (finding.state!=="reviewed") throw Object.assign(new Error("A finding must be independently verified and approved before export"),{code:"STATE"});
  const captures=finding.evidence.map(value=>store.readEvidence(value)).filter(Boolean);
  const report=`# ${finding.title}\n\nStatus: ${finding.state}\n\nEngagement: ${manifest.engagement}\n\nGenerated: ${now()}\n\n## Impact\n\n${finding.impact}\n\n## Preconditions\n\nTwo controlled identities (${finding.replay.owner_identity} and ${finding.replay.other_identity}) and the object path \`${finding.replay.path}\`.\n\n## Reproduction\n\n1. Request the object as ${finding.replay.owner_identity}; confirm the owner baseline succeeds.\n2. Request the same object as ${finding.replay.other_identity}.\n3. Confirm the second response exposes: ${finding.replay.protected_fields.join(", ")}.\n4. Compare owner markers and verify the object belongs to ${finding.replay.expected_owner}.\n\n## Evidence\n\n${captures.map(row=>`- ${row.id}: ${row.metadata.url} returned ${row.metadata.status}; SHA-256 ${row.digest}`).join("\n")}\n\n## Limitations\n\nThis report is a draft for human review. It was generated from bounded, read-only requests and has not been submitted externally.\n`;
  const output=path.join(store.root,"reports",`${findingId}.md`); atomicWrite(output,report); store.setFinding(findingId,"exported"); return output;
}
