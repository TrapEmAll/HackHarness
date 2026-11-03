import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const now = () => new Date().toISOString();
export const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
export const id = prefix => `${prefix}-${crypto.randomUUID()}`;
export function json(value) { return JSON.stringify(value, null, 2); }
export function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); }
export function atomicWrite(file, value, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, { mode });
  fs.renameSync(tmp, file);
}
export function fail(message, code = "INVALID") {
  const error = new Error(message); error.code = code; throw error;
}
export function parseJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Cannot read JSON manifest ${file}: ${error.message}`, "MANIFEST"); }
}
export function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = /authorization|cookie|token|secret|api[-_]?key/i.test(key) ? "[REDACTED]" : value;
  }
  return out;
}
export function redactText(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets.filter(Boolean).sort((a,b) => b.length-a.length)) out = out.split(secret).join("[REDACTED]");
  return out;
}
