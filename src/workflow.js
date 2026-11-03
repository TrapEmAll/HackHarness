import path from "node:path";
import { atomicWrite, json, now } from "./util.js";
import { Gateway } from "./gateway.js";

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
  const taskId=store.task(manifest.engagement,hypothesisId,"investigator"); store.setHypothesis(hypothesisId,"investigating");
  try {
    const gateway=new Gateway(store,manifest);
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

export async function replayFinding(store,manifest,findingId) {
  const finding=store.findingById(findingId);
  if (!finding || finding.engagement_id!==manifest.engagement) throw Object.assign(new Error("Finding not found in engagement"),{code:"NOT_FOUND"});
  if (finding.replay.type!=="authorization_read") throw Object.assign(new Error("Unsupported replay type"),{code:"REPLAY"});
  const taskId=store.task(manifest.engagement,finding.hypothesis_id,"verifier"), gateway=new Gateway(store,manifest), url=new URL(finding.replay.path,manifest.targets[0].origin).href;
  try {
    const owner=await gateway.request({taskId,identityId:finding.replay.owner_identity,url,purpose:"independent owner replay"});
    const other=await gateway.request({taskId,identityId:finding.replay.other_identity,url,purpose:"independent negative control replay"});
    const result=compareOwnership(owner,other,finding.replay.owner_identity);
    const exact=result.supported && result.ownerMarker===finding.replay.expected_owner && finding.replay.protected_fields.every(key=>result.exposed.includes(key));
    store.finishTask(taskId,"completed"); store.setFinding(findingId,exact?"independently_verified":"stale");
    return {taskId,findingId,state:exact?"independently_verified":"stale",reason:result.reason,evidence:[owner.evidenceId,other.evidenceId]};
  } catch(error) { store.finishTask(taskId,"failed"); throw error; }
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
