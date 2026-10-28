"""Offline normalization for previously captured, authorized test artifacts."""
from dataclasses import dataclass
from typing import Mapping

@dataclass
class TestArtifact:
    label: str
    method: str
    resource: str
    request_headers: Mapping[str, str]
    request_body: str = ""
    status: int | None = None
    response_body: str = ""

    def as_payload(self) -> dict:
        return {"label": self.label, "method": self.method.upper(), "resource": self.resource,
                "request_headers": dict(self.request_headers), "request_body": self.request_body,
                "status": self.status, "response_body": self.response_body}
