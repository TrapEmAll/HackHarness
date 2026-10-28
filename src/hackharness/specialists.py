"""Specialist agents convert narrow research jobs into high-signal observations."""

from __future__ import annotations

import json
from abc import ABC, abstractmethod

from .models import Evidence, Job
from .providers import ModelProvider


BASE_SYSTEM = """You are a security research specialist operating only on explicitly
owned or authorized systems. Analyze the supplied artifacts and observations. Do not assume
that a suspected issue is real. Separate facts from hypotheses. Return concise JSON with
keys: observations, hypotheses, verification_requirements, confidence. Never invent evidence.
"""


class Specialist(ABC):
    name: str

    def __init__(self, provider: ModelProvider) -> None:
        self.provider = provider

    @abstractmethod
    def instructions(self) -> str:
        """Return specialist-specific analytical guidance."""

    async def analyze(self, job: Job) -> Evidence:
        prompt = f"""Specialty: {self.name}\nInstructions: {self.instructions()}\n
Target label: {job.target}\nTechnique: {job.technique}\nArtifacts:\n{json.dumps(job.payload, indent=2)}"""
        response = await self.provider.complete(BASE_SYSTEM, prompt)
        return Evidence(
            job_id=job.id,
            kind="model_analysis",
            summary=f"{self.name} analysis using {response.model}",
            data={"response": response.text, "model": response.model,
                  "input_tokens": response.input_tokens,
                  "output_tokens": response.output_tokens},
        )


class AccessControlSpecialist(Specialist):
    name = "access-control"

    def instructions(self) -> str:
        return ("Compare supplied authorization states, object ownership, role boundaries, "
                "and server-side enforcement evidence. Prioritize reproducible authorization "
                "invariants and identify exactly what must be verified independently.")


class ClientSideSpecialist(Specialist):
    name = "client-side"

    def instructions(self) -> str:
        return ("Trace untrusted inputs through supplied client-side code/artifacts toward DOM "
                "or navigation sinks. Distinguish encoding/context issues from executable impact.")


class RequestRoutingSpecialist(Specialist):
    name = "request-routing"

    def instructions(self) -> str:
        return ("Analyze supplied server-side request behavior, URL parsing, redirects, proxy "
                "boundaries, and destination controls. State required safe-lab verification.")


SPECIALISTS = {
    "access-control": AccessControlSpecialist,
    "client-side": ClientSideSpecialist,
    "request-routing": RequestRoutingSpecialist,
}
