import dns from "node:dns/promises";
import net from "node:net";
import { fail } from "./util.js";

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const n = ip.toLowerCase();
  return n === "::1" || n === "::" || n.startsWith("fe80:") || n.startsWith("fc") || n.startsWith("fd");
}

export function matchTarget(manifest, rawUrl, method) {
  let url;
  try { url = new URL(rawUrl); } catch { fail("Invalid request URL", "SCOPE"); }
  if (url.username || url.password || url.hash) fail("Credentials and fragments are forbidden in request URLs", "SCOPE");
  if (/%2f|%5c|%2e|\\/i.test(url.pathname)) fail("Ambiguous encoded path is forbidden", "SCOPE");
  const normalizedMethod = method.toUpperCase();
  const target = manifest.targets.find(item => item.origin === url.origin && item.methods.includes(normalizedMethod) && item.paths.some(prefix => url.pathname.startsWith(prefix)));
  if (!target) fail(`Request is outside declared scope: ${normalizedMethod} ${url.origin}${url.pathname}`, "SCOPE");
  return { target, url, method: normalizedMethod };
}

export async function resolveTarget(target, url) {
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length) fail("Target hostname did not resolve", "NETWORK");
  if (!target.allow_private && records.some(record => privateIp(record.address))) fail("Private, loopback, and link-local targets require allow_private", "SCOPE");
  return records.map(record => record.address);
}
