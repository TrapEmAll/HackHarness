"""Independent review layer for candidate findings."""
from __future__ import annotations
from dataclasses import dataclass
from .models import Finding, Verdict

@dataclass
class ReviewVote:
    reviewer: str
    accept: bool
    confidence: float
    reason: str

class ReviewCouncil:
    """Combines independent votes; reviewers never mutate underlying evidence."""
    def decide(self, finding: Finding, votes: list[ReviewVote], deterministic_verified: bool) -> Finding:
        if deterministic_verified and votes and sum(v.accept for v in votes) >= (len(votes) // 2 + 1):
            finding.verdict = Verdict.VERIFIED
        elif votes and all(not v.accept for v in votes):
            finding.verdict = Verdict.REJECTED
        else:
            finding.verdict = Verdict.NEEDS_REVIEW
        return finding
