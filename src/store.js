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
  recover(engagement) {
    const running = this.db.prepare("SELECT id FROM task WHERE engagement_id=? AND state='running'").all(engagement);
    for (const row of running) this.db.prepare("UPDATE task SET state='interrupted',completed_at=? WHERE id=?").run(now(),row.id);
    if (running.length) this.event(engagement,"task.recovered",engagement,{interrupted:running.map(row=>row.id)});
    return running.length;
  }
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
  finishTask(value,state) { this.db.prepare("UPDATE task SET state=?,completed_at=? WHERE id=?").run(state,now(),value); }
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
