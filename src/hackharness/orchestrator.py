"""Worker orchestration for durable specialist jobs."""

from __future__ import annotations

from .providers import ModelProvider
from .specialists import SPECIALISTS
from .store import Store


class Orchestrator:
    def __init__(self, store: Store, provider: ModelProvider) -> None:
        self.store = store
        self.provider = provider

    async def run_once(self, worker_id: str) -> bool:
        """Lease and process one job. Returns False when the queue is empty."""
        job = self.store.lease_next(worker_id)
        if job is None:
            return False

        specialist_type = SPECIALISTS.get(job.specialist)
        if specialist_type is None:
            self.store.finish(job, worker_id, success=False)
            raise ValueError(f"Unknown specialist: {job.specialist}")

        try:
            evidence = await specialist_type(self.provider).analyze(job)
            self.store.append_evidence(evidence)
            self.store.finish(job, worker_id, success=True)
            return True
        except Exception:
            self.store.finish(job, worker_id, success=False)
            raise
