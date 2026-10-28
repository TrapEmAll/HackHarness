"""Cost-aware model routing and escalation policy."""
from dataclasses import dataclass

@dataclass(frozen=True)
class ModelTier:
    name: str
    model: str
    max_confidence: float

class ModelRouter:
    def __init__(self, cheap_model: str, strong_model: str) -> None:
        self.cheap = ModelTier("cheap", cheap_model, .74)
        self.strong = ModelTier("strong", strong_model, 1.0)

    def initial(self) -> ModelTier:
        return self.cheap

    def route_for_review(self, confidence: float, deterministic_signal: bool) -> ModelTier:
        # Spend expensive inference on high-signal or uncertain candidates, not routine noise.
        if deterministic_signal or confidence >= .55:
            return self.strong
        return self.cheap
