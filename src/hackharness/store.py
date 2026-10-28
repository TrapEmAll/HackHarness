"""SQLite-backed durable queue, leases, and append-only evidence log."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

from .models import Evidence, Job, JobState


SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    specialist TEXT NOT NULL,
    technique TEXT NOT NULL,
    payload TEXT NOT NULL,
    priority INTEGER NOT NULL,
    state TEXT NOT NULL,
    claim_key TEXT NOT NULL,
    lease_owner TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_queue ON jobs(state, priority, created_at);
CREATE TABLE IF NOT EXISTS claims (
    claim_key TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    lease_until TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    job_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class Store:
    """Small transactional persistence layer suitable for local harness workers."""

    def __init__(self, path: str | Path = "hackharness.db") -> None:
        self.path = str(path)
        with self.connection() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def enqueue(self, job: Job) -> None:
        with self.connection() as db:
            db.execute(
                """INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)""",
                (job.id, job.target, job.specialist, job.technique,
                 json.dumps(job.payload), job.priority, job.state.value,
                 job.claim_key, job.created_at.isoformat()),
            )

    def lease_next(self, owner: str, lease_seconds: int = 300) -> Job | None:
        """Atomically lease the highest-priority unclaimed job."""
        now = datetime.now(timezone.utc)
        until = now + timedelta(seconds=lease_seconds)
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM claims WHERE lease_until < ?", (now.isoformat(),))
            row = db.execute(
                """SELECT * FROM jobs WHERE state = ? AND claim_key NOT IN
                   (SELECT claim_key FROM claims) ORDER BY priority, created_at LIMIT 1""",
                (JobState.QUEUED.value,),
            ).fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            db.execute("INSERT INTO claims VALUES (?, ?, ?)",
                       (row["claim_key"], owner, until.isoformat()))
            db.execute("UPDATE jobs SET state=?, lease_owner=?, lease_until=? WHERE id=?",
                       (JobState.LEASED.value, owner, until.isoformat(), row["id"]))
            db.execute("COMMIT")
            return Job(id=row["id"], target=row["target"], specialist=row["specialist"],
                       technique=row["technique"], payload=json.loads(row["payload"]),
                       priority=row["priority"], state=JobState.LEASED,
                       created_at=datetime.fromisoformat(row["created_at"]))

    def append_evidence(self, evidence: Evidence) -> None:
        """Append evidence; existing evidence rows are never updated or deleted."""
        with self.connection() as db:
            db.execute(
                "INSERT INTO evidence(id,job_id,kind,summary,data,created_at) VALUES(?,?,?,?,?,?)",
                (evidence.id, evidence.job_id, evidence.kind, evidence.summary,
                 json.dumps(evidence.data), evidence.created_at.isoformat()),
            )

    def finish(self, job: Job, owner: str, success: bool = True) -> None:
        with self.connection() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("UPDATE jobs SET state=?, lease_owner=NULL, lease_until=NULL WHERE id=?",
                       ((JobState.COMPLETE if success else JobState.FAILED).value, job.id))
            db.execute("DELETE FROM claims WHERE claim_key=? AND owner=?", (job.claim_key, owner))
            db.execute("COMMIT")
