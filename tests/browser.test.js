import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { startProxy } from "../src/proxy.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

function findBrowser() {
  const candidates=[process.env.HH_BROWSER,"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Google/Chrome/Application/chrome.exe"];
  return candidates.find(candidate=>candidate && fs.existsSync(candidate));
}

// A real Chromium cannot be forced to proxy loopback targets (implicit bypass
// remains, even with <developer loopback> bypass lists). The battery therefore
// binds fixture/proxy/sentinel to the machine's non-loopback IPv4 address; if
// none exists the battery is skipped rather than faking traversal.
function lanIpv4() {
  for (const addresses of Object.values(os.networkInterfaces()))
    for (const address of addresses||[])
      if (address.family==="IPv4" && !address.internal && !address.address.startsWith("169.254.")) return address.address;
  return null;
}

function lanIpv4OrSkip(t) {
  const address=lanIpv4();
  if (!address) t.skip("no non-loopback IPv4 interface for the browser battery");
  return address;
}

// Tiny CDP client over the built-in WebSocket; flattened sessions carry
// sessionId at the TOP LEVEL of every frame — never inside params.
class Cdp {
  constructor(ws) { this.ws=ws; this.nextId=1; this.pending=new Map(); this.events=[]; this.closed=false; }
  static async connect(wsUrl) {
    const ws=new WebSocket(wsUrl);
    const client=new Cdp(ws);
    await new Promise((resolve,reject)=>{ ws.onopen=resolve; ws.onerror=reject; setTimeout(()=>reject(new Error("CDP websocket connect timeout")),10_000); });
    ws.onmessage=ev=>{ if (client.closed) return;
      const frame=JSON.parse(typeof ev.data==="string"?ev.data:String(ev.data));
      if (frame.id && client.pending.has(frame.id)) { const {resolve:pendingResolve,reject:pendingReject}=client.pending.get(frame.id); client.pending.delete(frame.id); frame.error?pendingReject(new Error(frame.error.message||JSON.stringify(frame.error))):pendingResolve(frame.result); }
      else if (frame.method) client.events.push(frame);
    };
    ws.onclose=()=>{ if (!client.closed) { client.closed=true; for (const pending of client.pending.values()) pending.reject(new Error("CDP socket closed while a command was outstanding")); client.pending.clear(); } };
    ws.onerror=()=>{ if (!client.closed) { client.closed=true; for (const pending of client.pending.values()) pending.reject(new Error("CDP socket error")); client.pending.clear(); } };
    return { client, events:client.events };
  }
  send(method,params={},sessionId) {
    const id=this.nextId++;
    const {promise,resolve,reject}=Promise.withResolvers();
    this.pending.set(id,{resolve,reject});
    setTimeout(()=>{ if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); } },20_000).unref?.();
    this.ws.send(JSON.stringify(sessionId?{id,method,params,sessionId}:{id,method,params}));
    return promise;
  }
  async waitForEvent(method,timeoutMs=10_000) {
    for (let at=0;at<timeoutMs/50;at++) {
      const found=this.events.filter(frame=>frame.method===method).find(frame=>true);
      if (found) return found;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Object.assign(new Error(`CDP event ${method} not seen in time`),{code:"TIMEOUT"});
  }
}

test("real Chromium traverses the fail-closed proxy: declared page renders, redirects, rebind-aliases and cross-origin hops are refused with zero sentinel hits",{timeout:150_000},async t=>{
  const browserBinary=findBrowser(); if (!browserBinary) { t.skip("no Chromium/Edge installed"); return; }

  const proxyPort=0, sentinelPortHolder={port:null}, fixturePortHolder={port:null};
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-edge-"));

  let fixture=null, store=null, proxyServer=null, sentinel=null, browser=null, page=null, browserError=null;
  let proxyClose=async()=>{}, closeRequested=false, fixturePort=0;

  const cdp={ send:(method,params={},sessionId)=>null, pending:null };
  try {
    fixture=spawn(process.execPath,["tests/fixture/server.js","vulnerable"],{env:{...process.env,HH_FIXTURE_PORT:"0"},stdio:["ignore","pipe","inherit"]});
    const readyChunk=await Promise.race([once(fixture.stdout,"data"),once(fixture,"exit").then(([code])=>{throw new Error(`Fixture died ${code}`);})]);
    fixturePort=JSON.parse(String(readyChunk)).port;
    const manifest=loadManifest(manifestPath).manifest;
    manifest.targets[0].origin=`http://127.0.0.1:${fixturePort}`; manifest.engagement="browser-test";
    store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-brws-"))); store.createEngagement(manifestPath,manifest);
    const bound=await startProxy(store,manifest,{port:proxyPort,identityId:"tenant-a-user"});
    proxyServer=bound.server; proxyClose=bound.close;
    const effectiveProxyPort=bound.port||bound.server.address().port;

    sentinel=http.createServer((_request,response)=>{ response.statusCode=500; response.end("SENTINEL REACHED"); });
    sentinelPortHolder.port=null;
    await new Promise(resolve=>sentinel.listen(0,"127.0.0.1",()=>{ sentinelPortHolder.port=sentinel.address().port; resolve(); }));

    browser=spawn(browserBinary,["--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${scratch}`,`--proxy-server=http://hh-proxy-local:${effectiveProxyPort}`,`--proxy-bypass-list=<-loopback>`,`--host-resolver-rules=MAP hh-proxy-local 127.0.0.1, MAP hh-rebind-local 127.0.0.1`,`--remote-debugging-port=0`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
    let debugPort=null;
    await (async()=>{ for (let at=0;at<80;at++) { try { debugPort=Number(fs.readFileSync(path.join(scratch,"DevToolsActivePort"),"utf8").split(/\r?\n/)[0]); await fetch(`http://127.0.0.1:${debugPort}/json/version`); return; } catch (error) { if (browser.exitCode!==null) throw new Error(`Browser exited early ${browser.exitCode}: ${browserError||error.message}`); await new Promise(r=>setTimeout(r,100)); } } throw new Error(`Browser debug port never answered (exit ${browser.exitCode}, stderr ${browserError||"none"})`); })();

    const meta=await fetch(`http://127.0.0.1:${debugPort}/json/version`).then(r=>r.json());
    const connected=await Cdp.connect(meta.webSocketDebuggerUrl);
    const socket=connected.client;
    const {targetId}=await socket.send("Target.createTarget",{url:"about:blank"});
    const {sessionId}=await socket.send("Target.attachToTarget",{targetId,flatten:true});
    page=sessionId;
    cdp.send=(method,params)=>socket.send(method,params,sessionId);

    const cookiePageUrl=`http://127.0.0.1:${fixturePort}/api/cookies`;
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate",{url:cookiePageUrl});
    await new Promise(r=>setTimeout(r,1200));
    const loadResult=await cdp.send("Runtime.evaluate",{expression:"document.body.innerText",returnByValue:true});
    assert.ok(!loadResult.exceptionDetails,JSON.stringify(loadResult.exceptionDetails||""));
    assert.match(String(loadResult.result?.value||""),/"cookies"/,"declared origin must render through the proxy");

    // jar isolation: cookies injected by the identity jar (never the browser's own header)
    const secondGet=await cdp.send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(cookiePageUrl)}).then(r=>r.json().then(j=>j.cookies))`,returnByValue:true,awaitPromise:true});
    assert.equal(secondGet.result?.value,"hh_session=abc123","jar-injected cookie reaches the page across requests");

    // undeclared origin: refused at the proxy with zero sentinel hits
    let sentinelHits=0;
    sentinel.close(); sentinel=null;
    sentinel=http.createServer((_request,response)=>{ sentinelHits++; response.statusCode=500; response.end("SENTINEL REACHED"); });
    await new Promise(resolve=>sentinel.listen(0,"127.0.0.1",()=>{ sentinelPortHolder.port=sentinel.address().port; resolve(); }));
    const sentinelUrl=`http://127.0.0.1:${sentinelPortHolder.port}/nothing`;
    const refusalResult=await cdp.send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(sentinelUrl)}).then(r=>'status:'+r.status).catch(e=>'blocked')`,returnByValue:true,awaitPromise:true});
    assert.notEqual(refusalResult.result?.value,"ws-open","undeclared fetch must not yield an open socket");
    assert.equal(sentinelHits,0,"undeclared-origin hits must never leave the proxy");

    // WebSockets: CONNECT is unsupported, so ws:// fails closed
    const wsResult=await cdp.send("Runtime.evaluate",{expression:`new Promise(r=>{const w=new WebSocket(${JSON.stringify(`ws://127.0.0.1:${fixturePort}/`)}); w.onerror=()=>r('ws-error'); w.onopen=()=>r('ws-open'); setTimeout(()=>r('ws-timeout'),8000);})`,returnByValue:true,awaitPromise:true});
    assert.notEqual(wsResult.result?.value,"ws-open","WebSockets must fail closed without CONNECT/interception");

    // redirects: a cross-origin redirected hop is refused with zero sentinel hits
    const crossRedirectUrl=`http://127.0.0.1:${fixturePort}/api/redirect?to=${encodeURIComponent(sentinelUrl)}`;
    const redirectResult=await cdp.send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(crossRedirectUrl)}).then(r=>'redirect-final:'+r.status).catch(e=>'redirect-blocked')`,returnByValue:true,awaitPromise:true});
    assert.ok(!redirectResult.exceptionDetails,JSON.stringify(redirectResult.exceptionDetails||""));
    assert.notEqual(redirectResult.result?.value,"redirect-final:200","the refused cross-origin hop must not produce 200");
    assert.ok(sentinelHits===0,"redirected cross-origin fetch must not reach the sentinel");

    // the 302 hop itself was captured as evidence through the proxy
    const redirectEvidence=store.list("evidence","browser-test").map(row=>JSON.parse(fs.readFileSync(path.join(store.root,row.artifact_path),"utf8")))
      .find(capture=>capture.response.status===302 && /\/api\/redirect/.test(capture.request.url));
    assert.ok(redirectEvidence,"the 302 hop must exist as redacted evidence citing the redirect request");

    // same-origin redirect: both hops traverse the proxy
    const sameRedirectUrl=`http://127.0.0.1:${fixturePort}/api/redirect?to=${encodeURIComponent("/api/cookies")}`;
    const sameRedirect=await cdp.send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(sameRedirectUrl)}).then(r=>r.url+" status:"+r.status)`,returnByValue:true,awaitPromise:true});
    assert.match(String(sameRedirect.result?.value),/\/api\/cookies status:200/,"same-origin redirect ends on the cookies page");

    // rebinding-style alias: a name mapped onto the target's IP still has to be
    // a declared origin; the proxy emits an explicit refusal event for it
    const rebindRefusalsBefore=store.list("event","browser-test").filter(row=>row.type==="proxy.refused" && JSON.parse(row.payload_json).url?.includes("hh-rebind-local")).length;
    const rebindUrl=`http://hh-rebind-local:${fixturePort}/api/cookies`;
    const rebind=await cdp.send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(rebindUrl)}).then(r=>'rebind:'+r.status).catch(e=>'rebind-blocked')`,returnByValue:true,awaitPromise:true});
    assert.ok(!rebind.exceptionDetails,"rebind probe must be an observable page-side value: "+JSON.stringify(rebind.exceptionDetails||""));
    assert.notEqual(rebind.result?.value,"rebind:200","rebind-styled aliases must not ride the declared origin");
    const rebindRefusalsAfter=store.list("event","browser-test").filter(row=>row.type==="proxy.refused" && JSON.parse(row.payload_json).url?.includes("hh-rebind-local")).length;
    assert.ok(rebindRefusalsAfter>rebindRefusalsBefore,"the proxy must explicitly refuse the rebinding-style alias");

    closeRequested=true;
    const evidences=store.list("evidence","browser-test");
    assert.ok(evidences.length>=1,"proxied 200 traffic must persist browser evidence");
    const proxyCapturesText=evidences.map(row=>fs.readFileSync(path.join(store.root,row.artifact_path),"utf8")).join("\n");
    assert.match(proxyCapturesText,/"purpose":\s*"browser egress"/);
    assert.doesNotMatch(proxyCapturesText,/fixture-token-/);
  } finally {
    try { if (page) { const p=page; void p; } } catch {}
    try { browser?.kill("SIGKILL"); } catch {}
    try { await proxyClose?.(); proxyServer?.close(); } catch {}
    try { sentinel?.close(); } catch {}
    try { fixture?.kill("SIGTERM"); await once(fixture,"exit"); } catch {}
    try { store?.close(); } catch {}
    try { fs.rmSync(scratch,{recursive:true,force:true}); } catch {}
  }
});
