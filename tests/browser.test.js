import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { startProxy } from "../src/proxy.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

function findBrowser() {
  const candidates=[process.env.HH_BROWSER,"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Microsoft/Edge/Application/msedge.exe","C:/Program Files/Google/Chrome/Application/chrome.exe"];
  return candidates.find(candidate=>candidate && fs.existsSync(candidate));
}

// Tiny CDP client over the built-in WebSocket: enough for navigate/evaluate.
class Cdp {
  constructor(ws) { this.ws=ws; this.nextId=1; this.pending=new Map(); this.events=[]; }
  static async connect(wsUrl) {
    const ws=new WebSocket(wsUrl);
    const client=new Cdp(ws);
    await new Promise((resolve,reject)=>{ ws.onopen=resolve; ws.onerror=reject; setTimeout(()=>reject(new Error("CDP websocket connect timeout")),10_000); });
    ws.onmessage=ev=>{
      if (client.closed) return;
      const frame=JSON.parse(typeof ev.data==="string"?ev.data:String(ev.data));
      if (frame.id && client.pending.has(frame.id)) { const {resolve:pendingResolve,reject:pendingReject}=client.pending.get(frame.id); client.pending.delete(frame.id); frame.error?pendingReject(new Error(frame.error.message||JSON.stringify(frame.error))):pendingResolve(frame.result); }
      else if (frame.method && !frame.sessionId) client.events.push(frame);
      else if (frame.method) client.events.push(frame);
    };
    ws.onclose=()=>{ if (!client.closed) { client.closed=true; for (const pending of client.pending.values()) pending.reject(new Error("CDP socket closed while a command was outstanding")); client.pending.clear(); } };
    ws.onerror=error=>{ if (!client.closed) { client.closed=true; for (const pending of client.pending.values()) pending.reject(new Error("CDP socket error")); client.pending.clear(); } };
    return { send:(method,params={},sessionId)=>client.send(method,params,sessionId), events:client.events, close:async()=>{ try { await client.send("Browser.close"); } catch {} client.closed=true; ws.close(); } };
  }
  send(method,params={},sessionId) {
    const id=this.nextId++;
    const {promise,resolve,reject}=Promise.withResolvers();
    this.pending.set(id,{resolve,reject});
    setTimeout(()=>{ if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP command timed out: ${method}`)); } },20_000).unref?.();
    this.ws.send(JSON.stringify(sessionId?{id,method,params,sessionId}:{id,method,params}));
    return promise;
  }
  async waitForEvent(method,matchFn,timeoutMs=10_000) {
    for (let at=0;at<timeoutMs/50;at++) {
      const found=this.events.filter(frame=>frame.method===method).find(matchFn);
      if (found) return found;
      await new Promise(r=>setTimeout(r,50));
    }
    throw Object.assign(new Error(`CDP event ${method} not seen in time`),{code:"TIMEOUT"});
  }
}

async function cdpPage(browser,port) {
  const meta=await fetch(`http://127.0.0.1:${port}/json/version`).then(r=>r.json());
  const browserWs=await Cdp.connect(meta.webSocketDebuggerUrl);
  const {targetId}=await browserWs.send("Target.createTarget",{url:"about:blank"});
  const {sessionId}=await browserWs.send("Target.attachToTarget",{targetId,flatten:true});
  // flattened sessions require sessionId at the top level of every frame,
  // next to id/method/params — never inside params
  return { browserWs, sessionId, send:(method,params={})=>browserWs.send(method,params,sessionId) };
}

test("real Chromium through the fail-closed proxy: declared page loads, other origins and WebSockets are refused",{timeout:120_000},async t=>{
  const browserBinary=findBrowser();
  if (!browserBinary) return test("browser boundary battery (no Chromium found)",{skip:true},()=>{});
  let proxyPort, sentinelPort;
  const scratch=fs.mkdtempSync(path.join(os.tmpdir(),"hh-edge-"));
  let page, browser;
  const teardown=async()=>{
    try { if (page) { await page.browserWs.close(); } } catch {}
    if (browser && browser.exitCode===null && browser.signalCode===null) { await new Promise(r=>{ browser.once("exit",r); browser.kill("SIGKILL"); }); } else { try { browser?.kill("SIGKILL"); } catch {} }
    try { await close(); } catch {}
    try { sentinel.close(); } catch {}
    if (child.exitCode===null && child.signalCode===null) { child.kill("SIGTERM"); await childExited; } else { try { child.kill("SIGTERM"); } catch {} }
    try { store.close(); } catch {}
    try { fs.rmSync(scratch,{recursive:true,force:true}); } catch {}
  };
  t.after(teardown);
  const child=spawn(process.execPath,["tests/fixture/server.js","vulnerable"],{env:{...process.env,HH_FIXTURE_PORT:"0"},stdio:["ignore","pipe","inherit"]});
  const childExited=once(child,"exit");
  const readyChunk=await Promise.race([once(child.stdout,"data"),once(child,"exit").then(([code])=>{throw new Error(`Fixture died ${code}`);})]);
  const {port:fixturePort}=JSON.parse(String(readyChunk));
  if (!Number.isInteger(fixturePort)) throw new Error("Fixture did not report its port");
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${fixturePort}`; manifest.engagement="browser-test";
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-brws-"))); store.createEngagement(manifestPath,manifest);
  const {server,lease,close,port:resolvedProxyPort}=await startProxy(store,manifest,{port:0,identityId:"tenant-a-user"});
  proxyPort=resolvedProxyPort;
  if (!Number.isInteger(proxyPort)||proxyPort<=0) throw new Error("Proxy port missing");
  let browserError=null;
  browser=spawn(browserBinary,["--headless=new","--disable-gpu","--no-first-run",`--user-data-dir=${scratch}`,`--proxy-server=http://hh-proxy-local:${proxyPort}`,`--proxy-bypass-list=<-loopback>`,`--host-resolver-rules=MAP hh-proxy-local 127.0.0.1, MAP hh-target-local 127.0.0.1, MAP hh-sentinel-local 127.0.0.1`,`--remote-debugging-port=0`,"about:blank"],{stdio:["ignore","ignore","pipe"]});
  browser.stderr.on("data",chunk=>{ browserError=String(chunk).slice(0,300); });
  let debugPort=null;
  await (async()=>{ for (let at=0;at<80;at++) { try { debugPort=Number(fs.readFileSync(path.join(scratch,"DevToolsActivePort"),"utf8").split(/\r?\n/)[0]); await fetch(`http://127.0.0.1:${debugPort}/json/version`); return; } catch { if (browser.exitCode!==null) throw new Error(`Browser exited early ${browser.exitCode}: ${browserError||"no stderr"}`); await new Promise(r=>setTimeout(r,100)); } } throw new Error(`Browser debug port never answered (exit ${browser.exitCode}, stderr ${browserError||"none"})`); })();

  // sentinel undeclared origin: a live server that must never receive a hit
  let sentinelHits=0;
  const sentinel=http.createServer((_request,response)=>{ sentinelHits++; response.statusCode=500; response.end("SENTINEL REACHED"); });
  sentinel.listen(0,"127.0.0.1",()=>{ sentinelPort=sentinel.address().port; });

  page=await cdpPage(browser,debugPort);
  const {send}=page;
  const load=log=>log && log.params && typeof log.params==="object";
  await send("Page.enable");
  const cookiePageUrl=`http://127.0.0.1:${fixturePort}/api/cookies`;
  await send("Page.navigate",{url:cookiePageUrl});
  await new Promise(r=>setTimeout(r,1200));
  // page loaded through the proxy (also asserts the boundary allowed it)
  const loadResult=await send("Runtime.evaluate",{expression:"document.body.innerText",returnByValue:true});
  assert.ok(!loadResult.exceptionDetails,"declared-origin render must not raise: "+JSON.stringify(loadResult.exceptionDetails||""));
  assert.match(String(loadResult.result?.value||""),/"cookies"/,"declared origin must render through the proxy");

  // other origins: the boundary refuses them at the proxy; the sentinel shows zero hits
  const sentinelUrl=`http://127.0.0.1:${sentinelPort}/nothing`;
  const refusalResult=await send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(sentinelUrl)}).then(r=>'status:'+r.status).catch(e=>'blocked')`,returnByValue:true,awaitPromise:true});
  assert.ok(!refusalResult.exceptionDetails,"refusal probe must be observable page-side: "+JSON.stringify(refusalResult.exceptionDetails||""));
  assert.ok(refusalResult.result?.value!==undefined,`refusal result must be an observable page-side value; got ${JSON.stringify({result:refusalResult.result, details:refusalResult.exceptionDetails})}`);
  assert.equal(sentinelHits,0,"undeclared-origin hits must never leave the proxy");

  // jar isolation: the page's cookies flow through the identity jar, not the browser's own cookie header
  const secondGet=await send("Runtime.evaluate",{expression:`fetch(${JSON.stringify(cookiePageUrl)}).then(r=>r.json().then(j=>j.cookies))`,returnByValue:true,awaitPromise:true});
  assert.ok(!secondGet.exceptionDetails,"jar probe must be observable page-side: "+JSON.stringify(secondGet.exceptionDetails||""));
  assert.match(String(secondGet.result?.value),/hh_session=abc123/,"jar-injected cookie reaches the page across requests");
  void load; void lease;

  // WebSockets: the proxy refuses CONNECT (no TLS interception) so ws:// attempts fail closed
  const wsProbeUrl=`ws://127.0.0.1:${fixturePort}/`;
  const wsResult=await send("Runtime.evaluate",{expression:`new Promise(r=>{const w=new WebSocket(${JSON.stringify(wsProbeUrl)}); w.onerror=()=>r('ws-error'); w.onopen=()=>r('ws-open'); setTimeout(()=>r('ws-timeout'),8000);})`,returnByValue:true,awaitPromise:true});
  assert.ok(!wsResult.exceptionDetails,"ws probe must be observable page-side: "+JSON.stringify(wsResult.exceptionDetails||""));
  assert.notEqual(wsResult.result?.value,"ws-open","WebSockets must fail closed without CONNECT/interception");
  // the sentinel live server must show zero hits: refusals were produced by the proxy, not by absence
  assert.equal(sentinelHits,0,"undeclared-origin hits must never leave the proxy");
  // proxy traversal proof: at least one evidence capture came through the hh proxy
  const evidences=store.list("evidence","browser-test");
  assert.ok(evidences.length>=1,"proxied 200 traffic must persist browser evidence");
  const proxyCapturesText=evidences.map(row=>fs.readFileSync(path.join(store.root,row.artifact_path),"utf8")).join("\n");
  assert.match(proxyCapturesText,/"purpose"\s*:\s*"browser egress"/);
  assert.doesNotMatch(proxyCapturesText,/fixture-token-/);
  await page.browserWs.close();
  await close();
});
