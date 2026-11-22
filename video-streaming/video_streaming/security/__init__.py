"""Security boundary contracts for authenticated service requests."""

from .authorization import (
    RESOURCE_DENIED_MESSAGE,
    AuthorizationError,
    authorize_tenant_resource,
    require_scope,
)
from .principal import RequestPrincipal

__all__ = [
    "RESOURCE_DENIED_MESSAGE",
    "AuthorizationError",
    "RequestPrincipal",
    "authorize_tenant_resource",
    "require_scope",
]
