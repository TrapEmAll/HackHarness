import { spawn } from "node:child_process";
import readline from "node:readline";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Spawns one scoped OMP worker (`omp --mode rpc`) and speaks protocol v1 NDJSON.
// Completion rules from the pinned RPC contract: the `response` ack never means
// finished; a turn ends only at agent_end (isTerminal !== false) or a
// prompt_result with agentInvoked === false. Any unexpected exit is a failed
// attempt with unknown completion state.
export const ABORT_GRACE_MS = 30_000;

export class RpcWorker {
  constructor({ binary = "omp", args = [], cwd, model, maxCostUsd, extension, env = process.env, yolo = false, logError = () => {} }) {
    if (!binary) throw Object.assign(new Error("workers.binary must be a nonempty string"), { code: "CONFIG" });
    this.binary = binary; this.args = args; this.cwd = cwd; this.model = model; this.maxCostUsd = maxCostUsd; this.extension = extension; this.env = env; this.yolo = yolo; this.logError = logError;
    this.process = null; this.promptCounter = 0;
    this.pendingResponses = new Map(); this.pendingPrompts = new Map();
  }

  async start() {
    this.scratch = await mkdtemp(path.join(tmpdir(), "hh-worker-"));
    const args = ["--mode","rpc","--no-session","--no-ui","--no-tools","--no-extensions",`--trusted-extension=${this.extension}`,`--cwd=${this.scratch}`];
    if (this.model) args.push(`--model=${this.model}`);
    if (this.maxCostUsd) args.push(`--max-cost=${String(this.maxCostUsd)}`);
    if (this.yolo) args.push(`--approval-mode=yolo`);
    this.process = spawn(this.binary, [...this.args, ...args], { stdio: ["pipe","pipe","pipe"], env: this.env });
    this.process.stderr.on("data", chunk => this.logError(String(chunk)));
    const reader = readline.createInterface({ input: this.process.stdout });
    reader.on("line", line => this.frame(line));
    reader.on("close", () => this.exit());
    this.process.stdin.on("error", () => {});
    this.process.on("error", error => this.exit(error));
    return await this.once("open");
  }

  once(name) {
    this.listeners ||= {}; this.listeners[name] ||= [];
    return new Promise((resolve, reject) => this.listeners[name].push({ resolve, reject }));
  }

  fire(name, value, error) { (this.listeners?.[name] || []).splice(0).forEach(listener => error ? listener.reject(error) : listener.resolve(value)); }

  frame(line) {
    let frame; try { frame = JSON.parse(line); } catch { return; }
    const { type, id } = frame;
    if (type === "ready" && frame.protocolVersion === 1) return this.fire("open", frame);
    if (type === "open" || (type === "ready" && frame.protocolVersion !== 1)) return this.fire("open", null, Object.assign(new Error("Unsupported RPC protocol version"), { code: "CONFIG" }));
    if (type === "response") {
      const pending = this.pendingResponses.get(id);
      if (pending) { this.pendingResponses.delete(id); frame.success ? pending.resolve(frame.data) : pending.reject(Object.assign(new Error(frame.error || "command failed"), { code: "RPC" })); }
      return;
    }
    if (type === "prompt_result" && this.pendingPrompts.has(id) && frame.agentInvoked === false) return this.settle(id, { agentInvoked: false });
    if (type === "message_update") {
      const event = frame.assistantMessageEvent;
      // assistant message events carry no prompt id; workers run one prompt at a time
      const active = [...this.pendingPrompts.keys()].pop();
      if (active && event?.type === "text_delta") this.pendingPrompts.get(active).text.push(event.delta);
      return;
    }
    if (type === "agent_end" && frame.isTerminal !== false) {
      for (const idKey of [...this.pendingPrompts.keys()]) this.settle(idKey, { agentInvoked: true });
    }
  }

  settle(idKey, value) {
    const pending = this.pendingPrompts.get(idKey);
    if (!pending) return;
    this.pendingPrompts.delete(idKey);
    clearTimeout(pending.timer); clearTimeout(pending.grace);
    pending.resolve({ text: pending.text.join(""), aborted: Boolean(pending.aborted), ...value });
  }

  async prompt(message, { timeoutMs = 0 } = {}) {
    const idKey = `hh-${++this.promptCounter}`;
    return await new Promise((resolve, reject) => {
      const pending = { text: [], timer: null, resolve, reject };
      this.pendingPrompts.set(idKey, pending);
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => { pending.aborted = true; try { this.send({ type: "abort" }); } catch { this.process.kill(); } }, timeoutMs).unref?.();
        // abort must still be followed by a terminal agent_end; force exit if the run never stops
        pending.grace = setTimeout(() => { try { this.process.kill(); } catch {} }, timeoutMs + ABORT_GRACE_MS).unref?.();
      }
      try { this.send({ id: idKey, type: "prompt", message }); }
      catch (error) { this.settleError(idKey, error); }
    });
  }

  settleError(idKey, error) {
    const pending = this.pendingPrompts.get(idKey);
    if (!pending) return;
    this.pendingPrompts.delete(idKey);
    clearTimeout(pending.timer); clearTimeout(pending.grace);
    pending.resolve({ text: "", aborted: false, failure: error });
  }

  send(frame) {
    if (!this.process?.stdin?.writable) throw Object.assign(new Error("Worker process is not running"), { code: "NETWORK" });
    this.process.stdin.write(JSON.stringify(frame) + "\n");
  }

  async stats() {
    try { return await this.command({ type: "get_session_stats" }); } catch { return null; }
  }

  command(frame) {
    const idKey = frame.type === "prompt" ? undefined : `hh-c-${++this.promptCounter}`;
    return new Promise((resolve, reject) => {
      this.pendingResponses.set(idKey, { resolve, reject });
      this.send({ ...frame, id: idKey });
    });
  }

  exit(error) {
    const failure = Object.assign(new Error(error ? `Worker failed to start: ${error.message}` : "Worker process exited before completion; outcome unknown"), { code: "WORKER" });
    this.fire("open", null, failure);
    for (const idKey of [...this.pendingPrompts.keys()]) this.settleError(idKey, failure);
    for (const pending of this.pendingResponses.values()) pending.reject(failure);
    this.pendingResponses.clear();
  }

  async close() {
    if (!this.process) return;
    try { this.process.stdin.end(); } catch {}
    const exiting = new Promise(resolve => this.process.once("exit", resolve));
    setTimeout(() => { try { this.process.kill(); } catch {} }, 5_000).unref?.();
    await exiting;
    if (this.scratch) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await rm(this.scratch, { recursive: true, force: true }); break; }
        catch (error) { if (attempt === 2) this.logError(`Scratch cleanup skipped (still locked): ${error.message}`); else await new Promise(r => setTimeout(r, 300)); }
      }
    }
  }
}
