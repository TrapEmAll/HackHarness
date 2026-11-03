import fs from "node:fs";
import path from "node:path";
import { fail, parseJsonFile } from "./util.js";

const METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);

export function loadManifest(file) {
  const absolute = path.resolve(file);
  const value = parseJsonFile(absolute);
  if (value.schema_version !== 1) fail("schema_version must be 1", "MANIFEST");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.engagement || "")) fail("Invalid engagement name", "MANIFEST");
  if (!value.authorization?.reference || !value.authorization?.expires_at) fail("Authorization reference and expiry are required", "MANIFEST");
  const authFile = path.resolve(path.dirname(absolute), value.authorization.reference);
  if (!fs.existsSync(authFile)) fail(`Authorization file does not exist: ${authFile}`, "MANIFEST");
  const expiry = Date.parse(value.authorization.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) fail("Authorization is expired or invalid", "AUTHORIZATION");
  if (!Array.isArray(value.targets) || value.targets.length === 0) fail("At least one target is required", "MANIFEST");
  if (!Array.isArray(value.identities) || value.identities.length < 1) fail("At least one identity is required", "MANIFEST");
  const identityIds = new Set();
  value.identities.forEach(identity => {
    if (!identity.id || identityIds.has(identity.id)) fail("Identity IDs must be nonempty and unique", "MANIFEST");
    identityIds.add(identity.id);
    if (!/^env:\/\/[A-Z_][A-Z0-9_]*$/.test(identity.secret_ref || "")) fail(`Identity ${identity.id} must use env://VARIABLE`, "MANIFEST");
  });
  value.targets = value.targets.map((target, index) => {
    let origin;
    try { origin = new URL(target.origin); } catch { fail(`Invalid target origin ${target.origin}`, "MANIFEST"); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/' || origin.search || origin.hash) fail("Target origin must be a bare HTTP(S) origin", "MANIFEST");
    const methods = (target.methods || ["GET"]).map(x => String(x).toUpperCase());
    if (methods.some(x => !METHODS.has(x))) fail(`Invalid method on target ${index}`, "MANIFEST");
    const paths = target.paths || ["/"];
    if (paths.some(x => typeof x !== "string" || !x.startsWith("/") || x.includes("..") || x.includes("%"))) fail(`Unsafe path prefix on target ${index}`, "MANIFEST");
    return { id: target.id || `target-${index + 1}`, ...target, origin: origin.origin, methods, paths, request_limit: target.request_limit || 100, allow_private: Boolean(target.allow_private) };
  });
  value.limits = { concurrency: 2, requests_per_second: 2, wall_clock_minutes: 30, max_response_bytes: 1_000_000, ...(value.limits || {}) };
  for (const key of ["requests_per_second","wall_clock_minutes","max_response_bytes","concurrency"]) {
    const limit = value.limits[key];
    if (!Number.isFinite(limit) || limit <= 0) fail(`limits.${key} must be a positive number`, "MANIFEST");
  }
  if (value.limits.max_cost_usd !== undefined && !(Number.isFinite(value.limits.max_cost_usd) && value.limits.max_cost_usd > 0)) fail("limits.max_cost_usd must be a positive number", "MANIFEST");
  if (value.limits.cost_reserve_usd !== undefined && !(Number.isFinite(value.limits.cost_reserve_usd) && value.limits.cost_reserve_usd > 0)) fail("limits.cost_reserve_usd must be a positive number", "MANIFEST");
  value.workers = { binary: process.env.HH_OMP || "omp", ...(value.workers || {}) };
  if (typeof value.workers.binary !== "string" || !value.workers.binary) fail("workers.binary must be a nonempty string", "MANIFEST");
  value.sources = (value.sources || []).map((source, index) => {
    if (!source.id || typeof source.id !== "string" || !/^[a-zA-Z0-9._-]{1,64}$/.test(source.id)) fail(`sources[${index}].id must be a short identifier`, "MANIFEST");
    const rootAbsolute = path.resolve(path.dirname(absolute), source.root || "");
    if (!fs.existsSync(rootAbsolute) || !fs.statSync(rootAbsolute).isDirectory()) fail(`sources[${source.id}].root does not point at a directory: ${rootAbsolute}`, "MANIFEST");
    return { id: source.id, root: source.root, root_absolute: rootAbsolute };
  });
  if (value.workers.args !== undefined && !(Array.isArray(value.workers.args) && value.workers.args.every(entry => typeof entry === "string"))) fail("workers.args must be an array of strings", "MANIFEST");
  for (const [role, alias] of Object.entries(value.workers.routing || {})) {
    if (typeof alias !== "string" || !alias) fail(`workers.routing.${role} must be a nonempty model alias`, "MANIFEST");
  }
  return { manifest: value, absolute, authFile };
}

export function identitySecret(identity) {
  const name = identity.secret_ref.slice("env://".length);
  const secret = process.env[name];
  if (!secret) fail(`Required identity variable ${name} is not set`, "CREDENTIAL");
  return secret;
}
