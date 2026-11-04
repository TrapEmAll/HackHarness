import http from "node:http";
import { matchTarget, resolveTarget } from "./policy.js";
import { pinnedRequest } from "./gateway.js";
import { identitySecret } from "./manifest.js";
import { redactHeaders, redactText, json, now } from "./util.js";

// Minimal cookie isolation for scoped browser egress: bag matching on
// (domain, path). This is deliberately smaller than a real browser cookie
// store and never crosses identities.
export class CookieJar {
  constructor() { this.entries = new Map(); } // "domain|path|name" -> {value, domain, path, hostOnly}
  absorb(domain, headers) {
    const raw = headers["set-cookie"];
    const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
    for (const item of list) {
      // only the leading name=value pair is the cookie; attributes follow
      const first = item.indexOf("=");
      if (first < 0) continue;
      const name = item.slice(0, first).trim();
      const valuePart = item.slice(first + 1);
      const valueEnd = valuePart.indexOf(";");
      const pairValue = valueEnd >= 0 ? valuePart.slice(0, valueEnd) : valuePart;
      if (!name || !pairValue) continue;
      let domainKey = domain, pathKey = "/", hostOnly = true;
      for (const attr of valuePart.slice(valueEnd < 0 ? valuePart.length : valueEnd + 1).split(";").filter(a=>a.trim())) {
        const eq = attr.indexOf("=");
        const attrName = (eq < 0 ? attr : attr.slice(0, eq)).trim().toLowerCase();
        const attrValue = eq < 0 ? "" : attr.slice(eq + 1).trim();
        if (attrName === "domain" && attrValue) {
          const candidate = attrValue.replace(/^\./, "").toLowerCase();
          // a Domain attribute may only widen to that same host or its parent
          if (domain === candidate || domain.endsWith("."+candidate)) { domainKey = candidate; hostOnly = false; }
        }
        if (attrName === "path" && attrValue) pathKey = attrValue;
      }
      this.entries.set(`${domainKey}|${pathKey}|${name}`, { value: `${name}=${pairValue}`, domain: domainKey, path: pathKey, hostOnly });
    }
  }
  headerFor(domain, path) {
    const relevant = [...this.entries.values()].filter(entry =>
      (domain === entry.domain || (!entry.hostOnly && domain.endsWith("."+entry.domain))) &&
      (path === entry.path || path.startsWith(entry.path)));
    if (!relevant.length) return null;
    return relevant.map(entry=>entry.value).join("; ");
  }
}

const reject = (response, code, message) => { response.writeHead(code, { "content-type": "application/json" }); response.end(json({ error: "POLICY", message })); };

// Fail-closed HTTP egress for scoped browser work:
// - one lease per identity for the proxy lifetime (heartbeats + fenced hops)
// - only absolute-form requests to declared origins pass; CONNECT unsupported
//   until TLS interception exists (everything else refuses 403/502)
// - browser Cookie headers are dropped and replaced by the identity's jar;
//   Set-Cookie responses are absorbed per identity
// - the browser gets raw target bytes; the evidence copy is identity-redacted
export function startProxy(store, manifest, { port, identityId } = {}) {
  const identity = manifest.identities.find(item=>item.id===identityId);
  if (!identity) throw Object.assign(new Error("Unknown identity for proxy"), { code: "IDENTITY" });
  const deadline = Date.now() + manifest.limits.wall_clock_minutes * 60_000;
  const lease = store.task(manifest.engagement, null, "browser", { actionKey: `proxy:${identityId}`, deadlineAt: new Date(deadline).toISOString(), maxRunning: manifest.limits.concurrency });
  const jar = new CookieJar();
  const secrets = manifest.identities.map(entry=>{ try { return identitySecret(entry); } catch { return null; } });
  const server = http.createServer(async (request, response) => {
    try {
      store.assertLeaseActive(lease);
      const requestUrl = request.url.startsWith("http") ? new URL(request.url) : new URL(request.url, `http://${request.headers.host || "unset"}`);
      const method = (request.method || "GET").toUpperCase();
      let match, resolved;
      try {
        match = matchTarget(manifest, requestUrl.href, method);
        resolved = await resolveTarget(match.target, match.url);
      } catch (scopeError) { reject(response, 403, scopeError.message); return; }
      store.incrementRequests(manifest.engagement, match.target.id, match.target.request_limit);
      store.heartbeat(lease);
      const chunks = []; let size = 0;
      request.on("data", chunk => { size += chunk.length; if (size > manifest.limits.max_response_bytes) request.destroy(); else chunks.push(chunk); });
      request.on("end", async () => { try {
        if (["GET","HEAD","OPTIONS"].includes(method) && chunks.length) throw Object.assign(new Error("Read methods carry no body"), { code: "SCOPE" });
        const body = ["GET","HEAD","OPTIONS"].includes(method) ? null : Buffer.concat(chunks);
        const cookies = jar.headerFor(requestUrl.hostname, requestUrl.pathname);
        const upstream = await pinnedRequest(match.url, {
          method, addresses: resolved, maxBytes: manifest.limits.max_response_bytes, body,
          headers: { "user-agent":"HackHarness/0.1 proxy", ...(cookies ? { cookie: cookies } : {}) },
        });
        jar.absorb(requestUrl.hostname, upstream.headers);
        const jarValues = [...jar.entries.values()].map(entry=>entry.value.split("=")[1]).filter(Boolean);
        const rawBody = upstream.body.toString("utf8");
        const evidence = json({
          schema_version:1, captured_at: now(), task_id: lease, identity_id: identity.id, purpose:"browser egress",
          request:{ method, url: match.url.href, headers: redactHeaders({ "user-agent":"HackHarness/0.1 proxy", ...(cookies ? { cookie: cookies } : {}) }), body: body ? "[PRESENT]" : null },
          response:{ status: upstream.status, headers: redactHeaders(upstream.headers), body: redactText(rawBody, [...secrets, ...jarValues]) },
        });
        store.evidence(manifest.engagement, lease, "http.capture", evidence, { identity_id: identity.id, status: upstream.status, url: match.url.href });
        const clientHeaders = { ...upstream.headers };
        delete clientHeaders.connection;
        delete clientHeaders["transfer-encoding"];
        response.writeHead(upstream.status, clientHeaders);
        response.end(upstream.body);
      } catch (error) {
        reject(response, error.code === "SCOPE" || error.code === "BUDGET" ? 403 : 502, error.message);
      } });
    } catch (error) {
      reject(response, 403, error.message);
    }
  });
  return new Promise(resolve => server.listen(port, "127.0.0.1", () => resolve({ server, lease, close: async () => { store.claimCompletion(lease, "completed"); await new Promise(done=>server.close(done)); } })));
}
