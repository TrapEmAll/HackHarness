"""Continuous concurrent scheduler for durable harness jobs."""
from __future__ import annotations
import asyncio
from collections.abc import Awaitable, Callable
from .models import Job
from .store import Store

Handler = Callable[[Job, str], Awaitable[bool]]

class WorkerPool:
    def __init__(self, store: Store, handler: Handler, workers: int = 4, poll_seconds: float = .5) -> None:
        self.store, self.handler = store, handler
        self.workers, self.poll_seconds = workers, poll_seconds
        self._stop = asyncio.Event()

    async def worker(self, index: int) -> None:
        owner = f"worker-{index}"
        while not self._stop.is_set():
            job = self.store.lease_next(owner)
            if job is None:
                await asyncio.sleep(self.poll_seconds)
                continue
            ok = False
            try:
                ok = await self.handler(job, owner)
            finally:
                self.store.finish(job, owner, ok)

    async def run(self) -> None:
        await asyncio.gather(*(self.worker(i) for i in range(self.workers)))

    def stop(self) -> None:
        self._stop.set()
