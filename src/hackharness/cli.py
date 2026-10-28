"""HackHarness command-line interface."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import typer
import yaml

from .models import Job
from .orchestrator import Orchestrator
from .providers import OpenAICompatibleProvider
from .scope import ScopePolicy
from .store import Store

app = typer.Typer(help="Authorization-first multi-agent security research harness.")


def load_scope(path: Path) -> ScopePolicy:
    return ScopePolicy.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")) or {})


@app.command()
def init(db: Path = Path("hackharness.db")) -> None:
    """Initialize the durable local store."""
    Store(db)
    typer.echo(f"Initialized {db}")


@app.command()
def enqueue(
    target: str,
    specialist: str,
    technique: str,
    artifacts: Path,
    scope: Path = Path("scope.yaml"),
    db: Path = Path("hackharness.db"),
) -> None:
    """Queue an analysis job after enforcing the explicit authorization scope."""
    policy = load_scope(scope)
    policy.require_allowed(target)
    payload = json.loads(artifacts.read_text(encoding="utf-8"))
    job = Job(target=target, specialist=specialist, technique=technique, payload=payload)
    Store(db).enqueue(job)
    typer.echo(job.id)


@app.command()
def worker(
    base_url: str = typer.Option("http://127.0.0.1:11434/v1"),
    model: str = typer.Option("local-model"),
    api_key: str = typer.Option("local", envvar="HACKHARNESS_API_KEY"),
    worker_id: str = "worker-1",
    db: Path = Path("hackharness.db"),
) -> None:
    """Process one queued job using an OpenAI-compatible model endpoint."""
    provider = OpenAICompatibleProvider(base_url, model, api_key)
    ran = asyncio.run(Orchestrator(Store(db), provider).run_once(worker_id))
    typer.echo("processed" if ran else "queue empty")


if __name__ == "__main__":
    app()
