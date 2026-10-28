"""Reproducible model x specialist benchmark scoring."""
from __future__ import annotations
from dataclasses import dataclass

@dataclass
class BenchmarkResult:
    model: str
    specialist: str
    task: str
    success: bool
    false_positive: bool
    elapsed_seconds: float
    input_tokens: int = 0
    output_tokens: int = 0

    @property
    def token_cost(self) -> int:
        return self.input_tokens + self.output_tokens

def leaderboard(results: list[BenchmarkResult]) -> list[dict]:
    buckets: dict[tuple[str, str], list[BenchmarkResult]] = {}
    for result in results:
        buckets.setdefault((result.model, result.specialist), []).append(result)
    rows = []
    for (model, specialist), items in buckets.items():
        n = len(items)
        rows.append({
            "model": model,
            "specialist": specialist,
            "tasks": n,
            "success_rate": sum(x.success for x in items) / n,
            "false_positive_rate": sum(x.false_positive for x in items) / n,
            "avg_seconds": sum(x.elapsed_seconds for x in items) / n,
            "avg_tokens": sum(x.token_cost for x in items) / n,
        })
    return sorted(rows, key=lambda r: (-r["success_rate"], r["false_positive_rate"], r["avg_tokens"]))
