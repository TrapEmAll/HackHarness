import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, ensureDir, id, json, now, sha256 } from "./util.js";

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    ensureDir(this.root); ensureDir(path.join(this.root, "artifacts")); ensureDir(path.join(this.root, "reports"));
    this.db = new DatabaseSync(path.join(this.root, "hackharness.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engagement (id TEXT PRIMARY KEY, manifest_path TEXT NOT NULL, manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0, requests_used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS hypothesis (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, claim TEXT NOT NULL, control TEXT NOT NULL, proposed_check TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, hypothesis_id TEXT, role TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, completed_at TEXT, action_key TEXT, deadline_at TEXT);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, digest TEXT NOT NULL, artifact_path TEXT NOT NULL, metadata_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS target_usage (engagement_id TEXT NOT NULL, target_id TEXT NOT NULL, requests_used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(engagement_id, target_id));
      CREATE TABLE IF NOT EXISTS finding (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, hypothesis_id TEXT, title TEXT NOT NULL, state TEXT NOT NULL, evidence_json TEXT NOT NULL, replay_json TEXT NOT NULL, impact TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS event (seq INTEGER PRIMARY KEY AUTOINCREMENT, engagement_id TEXT NOT NULL, type TEXT NOT NULL, object_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observation (id TEXT PRIMARY KEY, engagement_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, evidence_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    for (const [table, column, ddl] of [
      ["task","action_key","ALTER TABLE task ADD COLUMN action_key TEXT"],
      ["task","deadline_at","ALTER TABLE task ADD COLUMN deadline_at TEXT"],
      ["task","cost_reserved","ALTER TABLE task ADD COLUMN cost_reserved REAL NOT NULL DEFAULT 0"],
      ["task","heartbeat_at","ALTER TABLE task ADD COLUMN heartbeat_at TEXT"],
      ["engagement","cost_used","ALTER TABLE engagement ADD COLUMN cost_used REAL NOT NULL DEFAULT 0"],
      ["engagement","cost_unknown","ALTER TABLE engagement ADD COLUMN cost_unknown INTEGER NOT NULL DEFAULT 0"],
      ["engagement","reserved","ALTER TABLE engagement ADD COLUMN reserved REAL NOT NULL DEFAULT 0"],
    ]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) this.db.exec(ddl);
    }
  }
  close() { this.db.close(); }
  event(engagement, type, objectId, payload = {}) { this.db.prepare("INSERT INTO event(engagement_id,type,object_id,payload_json,created_at) VALUES(?,?,?,?,?)").run(engagement,type,objectId,json(payload),now()); }
  createEngagement(manifestPath, manifest) {
    const current = this.db.prepare("SELECT * FROM engagement WHERE id=?").get(manifest.engagement);
    if (current) this.db.prepare("UPDATE engagement SET manifest_path=?,manifest_json=?,paused=0 WHERE id=?").run(manifestPath,json(manifest),manifest.engagement);
    else this.db.prepare("INSERT INTO engagement(id,manifest_path,manifest_json,created_at) VALUES(?,?,?,?)").run(manifest.engagement,manifestPath,json(manifest),now());
    this.event(manifest.engagement,"engagement.opened",manifest.engagement,{manifest_path:manifestPath});
  }
  engagement(idValue) { return this.db.prepare("SELECT * FROM engagement WHERE id=?").get(idValue); }
  incrementRequests(engagement, targetId, targetLimit) {
    const row = this.engagement(engagement);
    if (!row) throw Object.assign(new Error("Unknown engagement"), { code:"BUDGET" });
    if (row.paused) throw Object.assign(new Error("Engagement is paused"), { code:"BUDGET" });
    const result = this.db.prepare("INSERT INTO target_usage(engagement_id,target_id,requests_used) VALUES(?,?,1) ON CONFLICT(engagement_id,target_id) DO UPDATE SET requests_used=requests_used+1 WHERE requests_used < ?").run(engagement,targetId,targetLimit);
    if (!result.changes) throw Object.assign(new Error("Request budget exhausted for target"), { code:"BUDGET" });
  }
  requestsUsed(engagement) { return this.db.prepare("SELECT COALESCE(SUM(requests_used),0) AS total FROM target_usage WHERE engagement_id=?").get(engagement).total; }
  // Cross-worker cost enforcement: each dispatch reserves a slice of the
  // engagement cap atomically and binds the reservation to its task row in the
  // same transaction, so crashes and reconnects cannot orphan balances.
  // Reported usage replaces the reservation; unknown usage retains it and is
  // flagged. Recovery retains reservations as unknown cost.
  reserveWorkerBudget(engagement, cap, desired, taskId) {
    if (!Number.isFinite(cap)) {
      if (taskId) this.db.prepare("UPDATE task SET cost_reserved=0 WHERE id=?").run(taskId);
      return null;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.engagement(engagement);
      const remaining = cap - (row.cost_used || 0) - (row.reserved || 0);
      if (remaining <= 0) throw Object.assign(new Error(`Worker cost budget exhausted (${row.cost_used} used + ${row.reserved} reserved of ${cap})`), { code: "BUDGET" });
      const allocation = Math.min(remaining, Number.isFinite(desired) ? desired : remaining);
      this.db.prepare("UPDATE engagement SET reserved=? WHERE id=?").run((row.reserved || 0) + allocation, engagement);
      if (taskId) this.db.prepare("UPDATE task SET cost_reserved=? WHERE id=?").run(allocation, taskId);
      return allocation;
    } finally { this.db.exec("COMMIT"); }
  }
  settleTaskCost(taskId, cost, { released = false } = {}) {
    const known = this.db.prepare("SELECT engagement_id FROM task WHERE id=?").get(taskId);
    if (!known) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // reservation read inside the transaction: two connections can never
      // both observe the same positive balance and charge it twice
      const row = this.db.prepare("SELECT cost_reserved FROM task WHERE id=?").get(taskId);
      if (!row || !(row.cost_reserved > 0)) return;
      const reserved = row.cost_reserved;
      if (released) {
        this.db.prepare("UPDATE engagement SET reserved=MAX(reserved-?,0) WHERE id=?").run(reserved, known.engagement_id);
      } else {
        const reported = Number.isFinite(cost);
        this.db.prepare("UPDATE engagement SET reserved=MAX(reserved-?,0), cost_used=cost_used+?, cost_unknown=cost_unknown+? WHERE id=?").run(reserved, reported ? cost : reserved, reported ? 0 : 1, known.engagement_id);
      }
      this.db.prepare("UPDATE task SET cost_reserved=0 WHERE id=?").run(taskId);
    } finally { this.db.exec("COMMIT"); }
  }
  // Leases are invalidated only after their heartbeat (or creation) goes stale:
  // a live worker process must not be orphaned by another process's reopen.
  heartbeat(taskId) { this.db.prepare("UPDATE task SET heartbeat_at=? WHERE id=?").run(now(),taskId); }
  recover(engagement, { staleSeconds = 120 } = {}) {
    const cutoff = new Date(Date.now() - staleSeconds * 1000).toISOString();
    const running = this.db.prepare("SELECT id, cost_reserved FROM task WHERE engagement_id=? AND state='running' AND COALESCE(heartbeat_at,created_at) <= ?").all(engagement,cutoff);
    for (const row of running) this.settleTaskCost(row.id, null);
    for (const row of running) this.db.prepare("UPDATE task SET state='interrupted',completed_at=? WHERE id=?").run(now(),row.id);
    if (running.length) this.event(engagement,"task.recovered",engagement,{interrupted:running.map(row=>row.id)});
    return running.length;
  }
  taskState(taskId) { const row=this.db.prepare("SELECT state FROM task WHERE id=?").get(taskId); return row?.state ?? null; }
  hypothesis(engagement, claim, control, proposedCheck) {
    const value = id("H");
    this.db.prepare("INSERT INTO hypothesis VALUES(?,?,?,?,?,?,?)").run(value,engagement,claim,control,proposedCheck,"proposed",now());
    this.event(engagement,"hypothesis.proposed",value,{claim}); return value;
  }
  setHypothesis(value, state) { this.db.prepare("UPDATE hypothesis SET state=? WHERE id=?").run(state,value); }
  task(engagement, hypothesis, role, { actionKey, deadlineAt, maxRunning } = {}) {
    const key = actionKey || `${hypothesis}:${role}`;
    const active = this.db.prepare("SELECT id FROM task WHERE engagement_id=? AND action_key=? AND state='running'").get(engagement,key);
    if (active) throw Object.assign(new Error(`Task ${active.id} already owns this action; cancel it before redispatching`), { code:"DEDUP", task_id: active.id });
    if (maxRunning) {
      const running = this.db.prepare("SELECT COUNT(*) AS n FROM task WHERE engagement_id=? AND state='running'").get(engagement).n;
      if (running >= maxRunning) throw Object.assign(new Error(`Engagement is at its concurrency limit of ${maxRunning} running tasks`), { code:"CONCURRENCY" });
    }
    const prior = this.db.prepare("SELECT COALESCE(MAX(attempt),0) AS attempt FROM task WHERE engagement_id=? AND action_key=?").get(engagement,key);
    const attempt = prior.attempt + 1;
    const value = id("T");
    this.db.prepare("INSERT INTO task(id,engagement_id,hypothesis_id,role,state,attempt,created_at,action_key,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)").run(value,engagement,hypothesis,role,"running",attempt,now(),key,deadlineAt||null);
    this.event(engagement,"task.started",value,{role,hypothesis,attempt,action_key:key,deadline_at:deadlineAt||null});
    return value;
  }
  finishTask(value,state) {
    // a lease revoked by another process must not be resurrected on completion
    const result=this.db.prepare("UPDATE task SET state=?,completed_at=? WHERE id=? AND state='running'").run(state,now(),value);
    return result.changes>0;
  }
  evidence(engagement, task, kind, content, metadata) {
    const value=id("E"), digest=sha256(content), relative=`artifacts/${value}.json`;
    atomicWrite(path.join(this.root,relative),content);
    this.db.prepare("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?)").run(value,engagement,task,kind,digest,relative,json(metadata),now());
    this.event(engagement,"evidence.captured",value,{kind,digest}); return value;
  }
  evidenceById(value) { return this.db.prepare("SELECT * FROM evidence WHERE id=?").get(value); }
  readEvidence(value) { const row=this.evidenceById(value); if (!row) return null; return {...row, content:JSON.parse(fs.readFileSync(path.join(this.root,row.artifact_path),"utf8")),metadata:JSON.parse(row.metadata_json)}; }
  finding(engagement,hypothesis,title,evidence,replay,impact,state="candidate") { const value=id("F"),time=now(); this.db.prepare("INSERT INTO finding VALUES(?,?,?,?,?,?,?,?,?,?)").run(value,engagement,hypothesis,title,state,json(evidence),json(replay),impact,time,time); this.event(engagement,"finding.created",value,{title,state}); return value; }
  findingById(value) { const row=this.db.prepare("SELECT * FROM finding WHERE id=?").get(value); return row && {...row,evidence:JSON.parse(row.evidence_json),replay:JSON.parse(row.replay_json)}; }
  setFinding(value,state) { const finding=this.findingById(value); this.db.prepare("UPDATE finding SET state=?,updated_at=? WHERE id=?").run(state,now(),value); this.event(finding.engagement_id,`finding.${state}`,value,{}); }
  list(table,engagement) { if (!new Set(["hypothesis","finding","task","evidence","event","observation"]).has(table)) throw new Error("Invalid table"); return this.db.prepare(`SELECT * FROM ${table} WHERE engagement_id=? ORDER BY ${table === "event" ? "seq" : "created_at"} DESC`).all(engagement); }
  pause(engagement,paused=true) { this.db.prepare("UPDATE engagement SET paused=? WHERE id=?").run(paused?1:0,engagement); this.event(engagement,paused?"engagement.paused":"engagement.resumed",engagement,{}); }
  observation(engagement,kind,subject,evidenceId,payload) {
    const value=id("O");
    this.db.prepare("INSERT INTO observation(id,engagement_id,kind,subject,evidence_id,payload_json,created_at) VALUES(?,?,?,?,?,?,?)").run(value,engagement,kind,subject,evidenceId||null,json(payload||{}),now());
    this.event(engagement,"observation.recorded",value,{kind,subject});
    return value;
  }
  observationById(value) { const row=this.db.prepare("SELECT * FROM observation WHERE id=?").get(value); return row && {...row,payload:JSON.parse(row.payload_json)}; }
}
