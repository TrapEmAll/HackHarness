from pathlib import Path

import pytest

from hackharness.models import Evidence, Job
from hackharness.scope import ScopeError, ScopePolicy
from hackharness.store import Store
from hackharness.verification import status_transition_verifier


def test_scope_is_deny_by_default() -> None:
    policy = ScopePolicy(domains=["*.example.test"])
    assert policy.is_allowed("https://api.example.test/path")
    with pytest.raises(ScopeError):
        policy.require_allowed("https://example.com")


def test_claim_prevents_duplicate_concurrent_work(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.db")
    first = Job(target="localhost", specialist="client-side", technique="review",
                payload={"endpoint": "/x", "parameter": "q"})
    duplicate = Job(target="localhost", specialist="client-side", technique="review",
                    payload={"endpoint": "/x", "parameter": "q"})
    store.enqueue(first)
    store.enqueue(duplicate)
    assert store.lease_next("a") is not None
    assert store.lease_next("b") is None


def test_evidence_is_append_only(tmp_path: Path) -> None:
    store = Store(tmp_path / "test.db")
    evidence = Evidence(job_id="j1", kind="test", summary="captured")
    store.append_evidence(evidence)
    with pytest.raises(Exception):
        store.append_evidence(evidence)


def test_deterministic_verifier() -> None:
    result = status_transition_verifier({
        "baseline": {"status": 403},
        "candidate": {"status": 200},
        "expected_candidate_status": 200,
    })
    assert result.passed
