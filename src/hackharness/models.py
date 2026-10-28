"""Core domain models shared by the scheduler, workers, and evidence store."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, Field


def utcnow() -> datetime:
    """Return a timezone-aware UTC timestamp."""
    return datetime.now(timezone.utc)


class JobState(StrEnum):
    QUEUED = "queued"
    LEASED = "leased"
    COMPLETE = "complete"
    FAILED = "failed"


class Verdict(StrEnum):
    CANDIDATE = "candidate"
    VERIFIED = "verified"
    REJECTED = "rejected"
    NEEDS_REVIEW = "needs_review"


class Job(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    target: str
    specialist: str
    technique: str
    payload: dict[str, Any] = Field(default_factory=dict)
    priority: int = 100
    state: JobState = JobState.QUEUED
    created_at: datetime = Field(default_factory=utcnow)

    @property
    def claim_key(self) -> str:
        """Stable key used to prevent duplicate concurrent research work."""
        endpoint = str(self.payload.get("endpoint", ""))
        parameter = str(self.payload.get("parameter", ""))
        return "|".join((self.target, endpoint, parameter, self.technique))


class Evidence(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    job_id: str
    kind: str
    summary: str
    data: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime = Field(default_factory=utcnow)


class Finding(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex)
    job_id: str
    title: str
    category: str
    confidence: float = Field(ge=0, le=1)
    verdict: Verdict = Verdict.CANDIDATE
    evidence_ids: list[str] = Field(default_factory=list)
    rationale: str = ""
