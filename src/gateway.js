import { identitySecret } from "./manifest.js";
import { matchTarget, resolveTarget } from "./policy.js";
import { json, now, redactHeaders, redactText, sha256 } from "./util.js";
import http from "node:http";
import https from "node:https";

function pinnedRequest(url, { method, headers, body, addresses, maxBytes, timeout = 10_000 }) {
  return new Promise((resolve, reject) => {
    const transport=url.protocol==="https:"?https:http;
    const lookup=(_hostname,options,callback)=> {
      const records=addresses.map(address=>({address,family:address.includes(":")?6:4}));
      if (options?.all) callback(null,records); else callback(null,records[0].address,records[0].family);
    };
    const request=transport.request(url,{method,headers,lookup,servername:url.hostname,timeout},response=>{
      const chunks=[]; let size=0;
      response.on("data",chunk=>{
        size+=chunk.length;
        if(size>maxBytes){ request.destroy(Object.assign(new Error("Response exceeds byte limit"),{code:"BUDGET"})); return; }
        chunks.push(chunk);
      });
      response.on("end",()=>resolve({status:response.statusCode||0,headers:response.headers,body:Buffer.concat(chunks)}));
    });
    request.on("timeout",()=>request.destroy(Object.assign(new Error("Request timed out"),{code:"NETWORK"})));
    request.on("error",reject);
    if(body)request.write(body); request.end();
  });
}

export class Gateway {
  constructor(store, manifest) { this.store=store; this.manifest=manifest; this.lastRequestAt=0; this.deadline=Infinity; }
  async request({ taskId, identityId, url, method="GET", headers={}, body=null, purpose="investigation" }) {
    if (Date.now()>this.deadline) throw Object.assign(new Error("Task wall-clock deadline exceeded"), { code:"BUDGET" });
    const identity=this.manifest.identities.find(item=>item.id===identityId);
    if (!identity) throw Object.assign(new Error(`Unknown identity ${identityId}`),{code:"IDENTITY"});
    const secret=identitySecret(identity);
    let current=url, currentMethod=method.toUpperCase(), redirects=0, firstOrigin=new URL(url).origin;
    while (true) {
      const match=matchTarget(this.manifest,current,currentMethod);
      const resolved=await resolveTarget(match.target,match.url);
      this.store.incrementRequests(this.manifest.engagement,match.target.id,match.target.request_limit);
      const interval=1000/this.manifest.limits.requests_per_second;
      const wait=Math.max(0,this.lastRequestAt+interval-Date.now());
      if (wait) await new Promise(resolve=>setTimeout(resolve,wait));
      this.lastRequestAt=Date.now();
      const requestHeaders={...headers,"user-agent":"HackHarness/0.1"};
      if (match.url.origin===firstOrigin) requestHeaders.authorization=`Bearer ${secret}`;
      const response=await pinnedRequest(match.url,{method:currentMethod,headers:requestHeaders,body,addresses:resolved,maxBytes:this.manifest.limits.max_response_bytes});
      if ([301,302,303,307,308].includes(response.status) && response.headers.location) {
        if (++redirects>3) throw Object.assign(new Error("Redirect limit exceeded"),{code:"NETWORK"});
        current=new URL(Array.isArray(response.headers.location)?response.headers.location[0]:response.headers.location,match.url).href;
        if (response.status===303) { currentMethod="GET"; body=null; }
        continue;
      }
      const rawText=response.body.toString("utf8"), redacted=redactText(rawText,[secret]);
      const capture={
        schema_version:1,captured_at:now(),task_id:taskId,identity_id:identity.id,tenant:identity.tenant||null,role:identity.role||null,purpose,
        request:{method:currentMethod,url:current,headers:redactHeaders(requestHeaders),body:body?"[PRESENT]":null,resolved_addresses:resolved},
        response:{status:response.status,headers:redactHeaders(response.headers),body:redacted,body_sha256:sha256(rawText)}
      };
      const evidenceId=this.store.evidence(this.manifest.engagement,taskId,"http.capture",json(capture),{identity_id:identity.id,status:response.status,url:current});
      let parsed=null; try { parsed=JSON.parse(rawText); } catch {}
      return { evidenceId,status:response.status,body:redacted,json:parsed,headers:response.headers };
    }
  }
}
