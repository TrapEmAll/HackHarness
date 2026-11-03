import test from "node:test";
import assert from "node:assert/strict";
import { matchTarget } from "../src/policy.js";

const manifest={targets:[{origin:"https://lab.example",methods:["GET"],paths:["/api/"],allow_private:false}]};
test("allows an exact scoped origin and path",()=>assert.equal(matchTarget(manifest,"https://lab.example/api/items/1","GET").url.pathname,"/api/items/1"));
test("rejects sibling and suffix hostnames",()=>assert.throws(()=>matchTarget(manifest,"https://lab.example.evil.test/api/items/1","GET"),{code:"SCOPE"}));
test("rejects encoded path ambiguity",()=>assert.throws(()=>matchTarget(manifest,"https://lab.example/api/%2e%2e/admin","GET"),{code:"SCOPE"}));
test("rejects undeclared methods",()=>assert.throws(()=>matchTarget(manifest,"https://lab.example/api/items/1","POST"),{code:"SCOPE"}));
