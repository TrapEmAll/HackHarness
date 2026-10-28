"""Finding lifecycle repository built on the harness SQLite store."""
from __future__ import annotations
import json
from .models import Finding, Verdict
from .store import Store

FINDINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS findings (
 id TEXT PRIMARY KEY, job_id TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
 confidence REAL NOT NULL, verdict TEXT NOT NULL, evidence_ids TEXT NOT NULL, rationale TEXT NOT NULL
);
"""

class FindingRepository:
    def __init__(self, store: Store) -> None:
        self.store = store
        with store.connection() as db: db.executescript(FINDINGS_SCHEMA)

    def save(self, finding: Finding) -> None:
        with self.store.connection() as db:
            db.execute("""INSERT INTO findings VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
            confidence=excluded.confidence, verdict=excluded.verdict, evidence_ids=excluded.evidence_ids,
            rationale=excluded.rationale""", (finding.id, finding.job_id, finding.title, finding.category,
            finding.confidence, finding.verdict.value, json.dumps(finding.evidence_ids), finding.rationale))

    def by_verdict(self, verdict: Verdict) -> list[Finding]:
        with self.store.connection() as db:
            rows = db.execute("SELECT * FROM findings WHERE verdict=?", (verdict.value,)).fetchall()
        return [Finding(id=r['id'], job_id=r['job_id'], title=r['title'], category=r['category'],
            confidence=r['confidence'], verdict=Verdict(r['verdict']), evidence_ids=json.loads(r['evidence_ids']),
            rationale=r['rationale']) for r in rows]
