"""Strict contracts for model-generated research hypotheses."""
from __future__ import annotations
from typing import Any
from pydantic import BaseModel, Field

class Hypothesis(BaseModel):
    title: str
    category: str
    confidence: float = Field(ge=0, le=1)
    rationale: str
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    verifier: str | None = None
    verifier_input: dict[str, Any] = Field(default_factory=dict)

class SpecialistOutput(BaseModel):
    observations: list[dict[str, Any]] = Field(default_factory=list)
    hypotheses: list[Hypothesis] = Field(default_factory=list)
    followups: list[dict[str, Any]] = Field(default_factory=list)

    @classmethod
    def from_model_text(cls, text: str) -> "SpecialistOutput":
        """Require JSON rather than trying to infer structure from prose."""
        return cls.model_validate_json(text)
