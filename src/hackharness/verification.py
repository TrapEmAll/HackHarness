"""Deterministic verification primitives.

Model output is treated as hypothesis generation. Findings should be promoted only
when a verifier can establish an explicit invariant from captured evidence.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(slots=True)
class VerificationResult:
    passed: bool
    reason: str
    facts: dict[str, Any]


Verifier = Callable[[dict[str, Any]], VerificationResult]


class VerifierRegistry:
    def __init__(self) -> None:
        self._verifiers: dict[str, Verifier] = {}

    def register(self, name: str, verifier: Verifier) -> None:
        if name in self._verifiers:
            raise ValueError(f"Verifier already registered: {name}")
        self._verifiers[name] = verifier

    def verify(self, name: str, evidence: dict[str, Any]) -> VerificationResult:
        try:
            verifier = self._verifiers[name]
        except KeyError as exc:
            raise KeyError(f"Unknown verifier: {name}") from exc
        return verifier(evidence)


def status_transition_verifier(evidence: dict[str, Any]) -> VerificationResult:
    """Example invariant verifier for captured baseline/candidate HTTP metadata."""
    baseline = evidence.get("baseline", {})
    candidate = evidence.get("candidate", {})
    expected = evidence.get("expected_candidate_status")
    observed = candidate.get("status")
    passed = expected is not None and observed == expected and baseline != candidate
    return VerificationResult(
        passed=passed,
        reason=("candidate matched expected status and differed from baseline"
                if passed else "required status-transition invariant was not established"),
        facts={"baseline_status": baseline.get("status"), "candidate_status": observed,
               "expected_candidate_status": expected},
    )
