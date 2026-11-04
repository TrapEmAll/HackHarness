import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { loadManifest } from "../src/manifest.js";
import { Store } from "../src/store.js";
import { startProxy, CookieJar } from "../src/proxy.js";

process.env.HH_TOKEN_A="fixture-token-a"; process.env.HH_TOKEN_B="fixture-token-b";
const manifestPath=path.resolve("examples/local-fixture.json");

async function fixture(port) {
  const child=spawn(process.execPath,["tests/fixture/server.js","vulnerable"],{env:{...process.env,HH_FIXTURE_PORT:String(port)},stdio:["ignore","pipe","inherit"]});
  await Promise.race([once(child.stdout,"data"),once(child,"exit").then(([code])=>{throw new Error(`Fixture died ${code}`);})]);
  return child;
}

const proxyGet = (proxyPort, targetUrl, headers={}) => new Promise((resolve,reject)=>{
  const request=http.request({host:"127.0.0.1",port:proxyPort,path:targetUrl.href,headers:{...headers,host:targetUrl.host},method:"GET"},resolve);
  request.on("error",reject); request.end();
});

test("scoped egress proxy enforces policy and isolates cookies per identity",async t=>{
  const fixturePort=44301, child=await fixture(fixturePort); t.after(()=>child.kill("SIGTERM"));
  const manifest=loadManifest(manifestPath).manifest; manifest.targets[0].origin=`http://127.0.0.1:${fixturePort}`; manifest.engagement="proxy-test";
  const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),"hh-proxy-"))); t.after(()=>store.close()); store.createEngagement(manifestPath,manifest);
  const {server,lease,close}=await startProxy(store,manifest,{port:44351,identityId:"tenant-a-user"}); t.after(()=>server.close());
  const target=`http://127.0.0.1:${fixturePort}`;

  // declared origin with in-scope path: passes, absorbs Set-Cookie, evidence stored
  const first=await proxyGet(44351,new URL(`/api/cookies`,new URL(target)),{"cookie":"injected_cookie=MUST_NOT_PASS"});
  assert.equal(first.statusCode,200);
  const body=JSON.parse(await new Promise(r=>{let d="";first.on("data",c=>d+=c);first.on("end",()=>r(d));}));
  assert.equal(body.cookies,null,"browser-sent cookies are never forwarded; the jar owns that header");
  assert.ok((first.headers["set-cookie"]||[]).some(cookie=>cookie.startsWith("hh_session=abc123")));

  // second request: jar injects hh_session; user's raw cookies never pass through again
  const second=await proxyGet(44351,new URL(`/api/cookies`,new URL(target)));
  const body2=JSON.parse(await new Promise(r=>{let d="";second.on("data",c=>d+=c);second.on("end",()=>r(d));}));
  assert.match(body2.cookies,/hh_session=abc123/,"jar-injected cookie reaches the fixture");

  // undeclared origin refused
  const stranger=await proxyGet(44351,new URL("/anything","http://evil.example.test"));
  assert.equal(stranger.statusCode,403);
  // undeclared path refused
  const offscope=await proxyGet(44351,new URL("/admin",new URL(target)));
  assert.equal(offscope.statusCode,403);

  // lease state: single long-lived browser lease
  const browserLeases=store.list("task","proxy-test").filter(row=>row.role==="browser");
  assert.equal(browserLeases.length,1);

  // persisted evidence contains no cookie or token values
  const artifacts=fs.readdirSync(store.root).length; // smoke check that artifacts dir exists
  process.env.HH_DATA_DIR=store.root;
  const evidences=store.list("evidence","proxy-test");
  const text=evidences.map(row=>fs.readFileSync(path.join(store.root,row.artifact_path),"utf8")).join("\n");
  assert.doesNotMatch(text,/hh_session=abc123/);
  assert.doesNotMatch(text,/fixture-token-/);
  assert.ok(evidences.length>=2,"at least two captures recorded");
  void artifacts; void lease;
  await close();
  const leased=store.list("task","proxy-test").find(row=>row.role==="browser");
  assert.equal(leased.state,"completed");
});

test("domain-widened cookies are dropped entirely and host-only jars stay host-only",t=>{
  const jar=new CookieJar();
  jar.absorb("shop.lab.example.test",{"set-cookie":['hh_member=xyz; Path=/account; Domain=.lab.example.test; HttpOnly','host_only=1; Path=/','cond=left; Path=/; Domain=evil.example.test']});
  assert.equal(jar.headerFor("shop.lab.example.test","/account"),"host_only=1");
  assert.equal(jar.headerFor("other.lab.example.test","/account"),null,"no widening at all in this slice");
  assert.equal(jar.headerFor("evil.example.test","/"),null,"a rejected Domain attribute leaves no cookie on other hosts");
});

test("cookie boundaries: RFC path match, Secure scheme gating, host-only slice",t=>{
  const jar=new CookieJar();
  jar.absorb("shop.lab.example.test",{"set-cookie":['acct=1; Path=/account', 'gate=1; Path=/; Secure', 'domainish=1; Path=/; Domain=.lab.example.test']}, "https");
  assert.equal(jar.headerFor("shop.lab.example.test","/account","https"),'acct=1; gate=1');
  assert.equal(jar.headerFor("shop.lab.example.test","/accounting","https"),'gate=1',"Path=/account must not match /accounting");
  assert.equal(jar.headerFor("shop.lab.example.test","/account/sub","https"),'acct=1; gate=1');
  assert.equal(jar.headerFor("shop.lab.example.test","/account","http"),'acct=1',"Secure cookies never replay over http");
  assert.equal(jar.headerFor("shop.lab.example.test","/","https"),"gate=1","domain-widened cookie dropped; host path=/ Secure cookie remains");
  const insecureJar=new CookieJar();
  insecureJar.absorb("shop.lab.example.test",{"set-cookie":['plain=1; Path=/']});
  assert.equal(insecureJar.headerFor("shop.lab.example.test","/","http"),'plain=1');
});

test("default-path inherits the request URI directory, never sibling leaf paths",t=>{
  const jar=new CookieJar();
  jar.absorb("shop.lab.example.test",{"set-cookie":['implicit=1','badpath=1; Path=account','explicit=1; Path=/account/login']},{scheme:"http",requestPath:"/account/login"});
  assert.equal(jar.headerFor("shop.lab.example.test","/account","http"),"implicit=1; badpath=1","implicit default-path is /account; invalid Path=account falls back to it");
  assert.equal(jar.headerFor("shop.lab.example.test","/public","http"),null,"implicit cookie must not reach sibling leaf paths");
  
  assert.match(jar.headerFor("shop.lab.example.test","/account/login","http"),/explicit=1/);
});
