"""Model-provider abstraction with an OpenAI-compatible HTTP implementation.

This supports local servers such as Ollama-compatible gateways and hosted
OpenAI-compatible APIs without coupling the orchestrator to a vendor.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

import httpx


@dataclass(slots=True)
class ModelResponse:
    text: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0


class ModelProvider(ABC):
    @abstractmethod
    async def complete(self, system: str, prompt: str) -> ModelResponse:
        """Return one model completion."""


class OpenAICompatibleProvider(ModelProvider):
    def __init__(self, base_url: str, model: str, api_key: str = "local", timeout: float = 120) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.timeout = timeout

    async def complete(self, system: str, prompt: str) -> ModelResponse:
        headers = {"Authorization": f"Bearer {self.api_key}"}
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.1,
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(f"{self.base_url}/chat/completions", headers=headers, json=body)
            response.raise_for_status()
            data = response.json()
        usage = data.get("usage", {})
        return ModelResponse(
            text=data["choices"][0]["message"]["content"],
            model=data.get("model", self.model),
            input_tokens=usage.get("prompt_tokens", 0),
            output_tokens=usage.get("completion_tokens", 0),
        )
