"""Shared gRPC adapter guard for durable Job and playback resources."""
from video_streaming.grpc import exceptions
from video_streaming.grpc.authentication import get_request_principal
from video_streaming.security import AuthorizationError, require_scope
from video_streaming.workflows.service import get_workflow_repository


def _authorize(operation, required_scope, resource_id, context):
    """Run a repository authorization and return the same denial on failure.

    Authentication must already have produced a principal. Scope and token
    expiry are validated before the repository is resolved so an already
    invalid caller never reaches storage.
    """
    principal = get_request_principal()
    try:
        require_scope(principal, required_scope)
    except AuthorizationError:
        raise exceptions.ResourceNotFoundOrDeniedException(context=context)

    repository = get_workflow_repository(required=True)
    try:
        operation(repository, resource_id, principal)
    except AuthorizationError:
        # Same public response for missing, legacy-unowned and foreign
        # resources; never reveal whether the resource exists.
        raise exceptions.ResourceNotFoundOrDeniedException(context=context)
    return repository


def require_job_access(job_id, required_scope, context):
    """Authorize a durable Job before touching Redis or any side effect."""
    return _authorize(
        lambda repository, resource_id, principal: (
            repository.authorize_job_access(
                resource_id, principal, required_scope)
        ),
        required_scope,
        job_id,
        context,
    )


def require_playback_session_access(session_id, required_scope, context):
    """Authorize session ownership as well as the session capability token."""
    return _authorize(
        lambda repository, resource_id, principal: (
            repository.authorize_playback_session_access(
                resource_id, principal, required_scope)
        ),
        required_scope,
        session_id,
        context,
    )
