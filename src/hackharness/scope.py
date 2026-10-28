"""Authorization and target-scope enforcement.

All network-capable components should call ScopePolicy.require_allowed() before
interacting with a target. This centralizes the deny-by-default boundary.
"""

from __future__ import annotations

from fnmatch import fnmatch
from ipaddress import ip_address, ip_network
from urllib.parse import urlparse

from pydantic import BaseModel, Field


class ScopeError(PermissionError):
    """Raised when a target is outside the explicitly authorized scope."""


class ScopePolicy(BaseModel):
    domains: list[str] = Field(default_factory=list)
    networks: list[str] = Field(default_factory=list)
    allow_localhost: bool = True

    def is_allowed(self, target: str) -> bool:
        """Return True only when target matches an explicit scope rule."""
        parsed = urlparse(target if "://" in target else f"https://{target}")
        host = parsed.hostname
        if not host:
            return False

        if self.allow_localhost and host in {"localhost", "127.0.0.1", "::1"}:
            return True

        try:
            addr = ip_address(host)
        except ValueError:
            normalized = host.rstrip(".").lower()
            return any(fnmatch(normalized, pattern.lower()) for pattern in self.domains)

        return any(addr in ip_network(network, strict=False) for network in self.networks)

    def require_allowed(self, target: str) -> None:
        """Fail closed when a worker attempts to leave authorized scope."""
        if not self.is_allowed(target):
            raise ScopeError(f"Target is outside authorized scope: {target}")
