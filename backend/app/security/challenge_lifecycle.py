"""
AAA Engine - Challenge Lifecycle Security Module
Target 2: Challenge State Machine, Capture Grants, and Atomic Consumption.

Author: Karthik Mallareddy (mrkarthik1811@gmail.com)
Role: Security & Perimeter Defense Engineer

This module owns the pure (database-free) challenge lifecycle rules:

* The challenge state machine and its legal transitions.
* Signed, time-limited challenge tokens.
* Single-use enforcement with stable, assertable rejection codes.
* User binding, so a token issued to user A can never authorize user B.

Every rejection raises/carries a stable machine-readable code (see
``ChallengeLifecycleCode``) instead of a generic error. Callers (API layer,
``layer3_adaptive``) map these codes to public reason codes.
"""

import hashlib
import hmac
import os
import secrets
import time
from datetime import UTC, datetime
from enum import Enum
from typing import Any

from jose import ExpiredSignatureError, JWTError, jwt
from jose.exceptions import JWTClaimsError

CHALLENGE_TTL_SECONDS = 90
CAPTURE_GRANT_AUDIENCE = "aaa-capture"


class ChallengeState(str, Enum):
    """Lifecycle states of an acoustic authentication challenge."""

    CREATED = "CREATED"
    AUTHORIZED = "AUTHORIZED"
    CAPTURE_RECEIVED = "CAPTURE_RECEIVED"
    CONSUMED = "CONSUMED"
    COMPLETED = "COMPLETED"
    EXPIRED = "EXPIRED"
    TERMINATED = "TERMINATED"


#: States from which a challenge can no longer be consumed.
TERMINAL_STATES: frozenset[ChallengeState] = frozenset(
    {
        ChallengeState.CONSUMED,
        ChallengeState.COMPLETED,
        ChallengeState.EXPIRED,
        ChallengeState.TERMINATED,
    }
)

#: States that represent "pending verification" -- a challenge in one of these
#: states has not yet been used and has not yet expired.
PENDING_STATES: frozenset[ChallengeState] = frozenset(
    {
        ChallengeState.CREATED,
        ChallengeState.AUTHORIZED,
        ChallengeState.CAPTURE_RECEIVED,
    }
)


class ChallengeLifecycleCode(str, Enum):
    """Stable, machine-readable rejection identifiers for challenge lifecycle.

    These are status codes, not credentials; bandit's S105 heuristic flags the
    ``TOKEN_*`` names, hence the module-level suppression below.
    """

    # ruff: noqa: S105

    # Token lookup / format
    TOKEN_NOT_FOUND = "TOKEN_NOT_FOUND"
    MALFORMED_TOKEN_STRUCTURE = "MALFORMED_TOKEN_STRUCTURE"
    INVALID_TOKEN_EXPIRATION = "INVALID_TOKEN_EXPIRATION"
    INVALID_TOKEN_SIGNATURE = "INVALID_TOKEN_SIGNATURE"

    # Lifecycle / replay
    TOKEN_ALREADY_USED = "TOKEN_ALREADY_USED"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    CHALLENGE_TERMINATED = "CHALLENGE_TERMINATED"
    INVALID_CHALLENGE_STATE = "INVALID_CHALLENGE_STATE"
    INVALID_STATE_TRANSITION = "INVALID_STATE_TRANSITION"

    # Ownership
    TOKEN_USER_MISMATCH = "TOKEN_USER_MISMATCH"

    # Consumption success markers
    TOKEN_VALID = "TOKEN_VALID"  # read-only validation passed, not yet consumed
    TOKEN_CONSUMED = "TOKEN_CONSUMED"


class ChallengeLifecycleError(Exception):
    """Base exception for challenge lifecycle failures.

    Carries a stable ``code`` attribute so callers and tests can assert on a
    machine-readable identifier rather than a free-form message. ``str(exc)``
    keeps the historical behaviour of containing that code.
    """

    def __init__(self, code: str | ChallengeLifecycleCode, message: str | None = None):
        self.code = code.value if isinstance(code, ChallengeLifecycleCode) else str(code)
        self.message = message or self.code
        super().__init__(self.message)


class InvalidStateTransitionError(ChallengeLifecycleError):
    """Raised when an invalid state transition is attempted.

    The offending state is left untouched: this exception is raised *before*
    any mutation, so an illegal transition can never silently rewrite a row.
    """

    def __init__(
        self,
        current_state: ChallengeState | str | None,
        new_state: ChallengeState | str | None = None,
        message: str | None = None,
    ):
        if new_state is None:
            # Backwards-compatible single-argument construction (message only).
            self.current_state = None
            self.requested_state = None
            super().__init__(
                ChallengeLifecycleCode.INVALID_STATE_TRANSITION,
                message or str(current_state),
            )
            return

        self.current_state = ChallengeState(current_state)
        self.requested_state = ChallengeState(new_state)
        detail = message or (
            f"{ChallengeLifecycleCode.INVALID_STATE_TRANSITION.value}: cannot transition "
            f"from {self.current_state.value} to {self.requested_state.value}"
        )
        super().__init__(ChallengeLifecycleCode.INVALID_STATE_TRANSITION, detail)


#: Legal transitions. Consuming directly from a pending state is allowed
#: because the acoustic upload implicitly represents the capture step.
VALID_TRANSITIONS: dict[ChallengeState, list[ChallengeState]] = {
    ChallengeState.CREATED: [
        ChallengeState.AUTHORIZED,
        ChallengeState.CONSUMED,
        ChallengeState.EXPIRED,
        ChallengeState.TERMINATED,
    ],
    ChallengeState.AUTHORIZED: [
        ChallengeState.CAPTURE_RECEIVED,
        ChallengeState.CONSUMED,
        ChallengeState.EXPIRED,
        ChallengeState.TERMINATED,
    ],
    ChallengeState.CAPTURE_RECEIVED: [
        ChallengeState.CONSUMED,
        ChallengeState.EXPIRED,
        ChallengeState.TERMINATED,
    ],
    ChallengeState.CONSUMED: [ChallengeState.COMPLETED, ChallengeState.TERMINATED],
    ChallengeState.EXPIRED: [ChallengeState.TERMINATED],
    ChallengeState.COMPLETED: [],
    ChallengeState.TERMINATED: [],
}


def utcnow() -> datetime:
    """Current UTC time as a naive datetime (matches the DB column type)."""
    return datetime.now(UTC).replace(tzinfo=None)


def epoch_seconds(moment: datetime) -> int:
    """Convert a naive-UTC datetime (as stored in the DB) to a real epoch value."""
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return int(moment.timestamp())


def can_transition(current_state: ChallengeState, new_state: ChallengeState) -> bool:
    """Verifies whether transition from current_state to new_state is permissible."""
    return new_state in VALID_TRANSITIONS.get(current_state, [])


def challenge_state(challenge: Any, now: datetime | None = None) -> ChallengeState:
    """Derive the effective lifecycle state of a challenge row.

    Works on ORM rows and on simple objects exposing ``state``/``used``/
    ``expires_at``. The ``used`` flag is the legacy source of truth; when it
    disagrees with ``state`` the *more restrictive* interpretation wins so a
    replay can never slip through via an inconsistent row.
    """
    now = now or utcnow()
    raw_state = getattr(challenge, "state", None)
    used = bool(getattr(challenge, "used", False))
    expires_at = getattr(challenge, "expires_at", None)

    state: ChallengeState | None = None
    if raw_state:
        try:
            state = ChallengeState(raw_state)
        except ValueError as err:
            raise ChallengeLifecycleError(
                ChallengeLifecycleCode.INVALID_CHALLENGE_STATE,
                f"{ChallengeLifecycleCode.INVALID_CHALLENGE_STATE.value}: "
                f"unknown challenge state {raw_state!r}",
            ) from err

    if state in (ChallengeState.CONSUMED, ChallengeState.COMPLETED):
        return state
    if used:
        # Legacy rows (or partially-written rows) mark consumption via `used`.
        return ChallengeState.CONSUMED
    if state in (ChallengeState.EXPIRED, ChallengeState.TERMINATED):
        return state

    if state is None:
        state = ChallengeState.CREATED
    if expires_at is not None and expires_at <= now:
        return ChallengeState.EXPIRED
    return state


def transition_challenge(
    challenge: Any,
    new_state: ChallengeState | str,
    now: datetime | None = None,
) -> ChallengeState:
    """Apply a state transition or raise ``InvalidStateTransitionError``.

    The challenge object is only mutated once the transition has been proven
    legal; an illegal transition therefore never rewrites the record.
    """
    requested = ChallengeState(new_state)
    current = challenge_state(challenge, now=now)
    if not can_transition(current, requested):
        raise InvalidStateTransitionError(current, requested)

    if requested is ChallengeState.CONSUMED:
        challenge.used = True
        if hasattr(challenge, "consumed_at"):
            challenge.consumed_at = now or utcnow()
    if hasattr(challenge, "state"):
        challenge.state = requested.value
    return requested


def generate_challenge_token(
    user_id: str,
    phrase: str,
    secret_key: bytes | None = None,
    ttl_seconds: int = CHALLENGE_TTL_SECONDS,
) -> tuple[str, int]:
    """
    Generates a cryptographically signed, unguessable challenge token.
    Token format: {nonce}.{expires_timestamp}.{signature}

    The expiry timestamp is a true Unix epoch value (``time.time()``), not a
    local-time interpretation of a naive datetime. This keeps the token valid
    on hosts configured with a non-UTC timezone.
    """
    secret = (
        secret_key or os.environ.get("SECRET_KEY", "fallback-secret-for-signing-token!!").encode()
    )
    now_ts = int(time.time())
    expires_ts = now_ts + ttl_seconds
    nonce = secrets.token_hex(16)  # 32 hex characters

    payload = f"{user_id}:{expires_ts}:{phrase}:{nonce}"
    signature = hmac.new(secret, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token = f"{nonce}.{expires_ts}.{signature}"

    return token, expires_ts


def issue_capture_grant(
    challenge_id: str,
    tenant_id: str,
    expires_at_ts: int,
    jwt_secret: str | None = None,
) -> str:
    """
    Issues a short-lived capture grant JWT authorizing single audio upload.
    Binds challenge_id as subject and 'aaa-capture' as audience.
    """
    secret = jwt_secret or os.environ.get(
        "AAA_JWT_SECRET", "default-fallback-key-32-characters-min!!"
    )
    now_ts = int(time.time())
    payload = {
        "sub": str(challenge_id),
        "tenant_id": str(tenant_id),
        "aud": CAPTURE_GRANT_AUDIENCE,
        "iat": now_ts,
        "exp": expires_at_ts,
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def verify_capture_grant(
    grant_token: str,
    expected_challenge_id: str,
    jwt_secret: str | None = None,
) -> dict[str, Any]:
    """
    Validates a capture grant token against challenge and audience restrictions.
    """
    secret = jwt_secret or os.environ.get(
        "AAA_JWT_SECRET", "default-fallback-key-32-characters-min!!"
    )
    try:
        claims = jwt.decode(
            grant_token,
            secret,
            algorithms=["HS256"],
            audience=CAPTURE_GRANT_AUDIENCE,
        )
    except ExpiredSignatureError as err:
        raise ChallengeLifecycleError("CAPTURE_GRANT_EXPIRED") from err
    except (JWTClaimsError, JWTError) as err:
        raise ChallengeLifecycleError("INVALID_CAPTURE_GRANT") from err

    if claims.get("sub") != str(expected_challenge_id):
        raise ChallengeLifecycleError("CAPTURE_GRANT_CHALLENGE_MISMATCH")

    return claims


def validate_and_consume_challenge(
    token: str,
    stored_user_id: str,
    stored_phrase: str,
    current_state: ChallengeState,
    expires_at_ts: int,
    secret_key: bytes | None = None,
    presented_user_id: str | None = None,
    now_ts: int | None = None,
) -> tuple[ChallengeState, dict[str, Any]]:
    """
    Atomically validates HMAC signature, expiration, ownership, and enforces
    single-use semantics. Transitions state to CONSUMED upon success.

    Rejection precedence is deliberate and stable:

    1. terminal states (replay) -- so a re-submitted token always reports
       ``TOKEN_ALREADY_USED`` even once its TTL has also elapsed;
    2. ownership -- a token presented by a different user is always rejected;
    3. expiry -- ``TOKEN_EXPIRED`` (never "valid because of clock/cache");
    4. state machine legality;
    5. token structure/signature.

    Raises:
        InvalidStateTransitionError: if the transition is not legal.
        ChallengeLifecycleError: with a stable ``code`` for every other failure.
    """
    now_ts = int(time.time()) if now_ts is None else int(now_ts)

    # 1. Single-use / terminal-state enforcement.
    if current_state in (ChallengeState.CONSUMED, ChallengeState.COMPLETED):
        raise ChallengeLifecycleError(ChallengeLifecycleCode.TOKEN_ALREADY_USED)
    if current_state is ChallengeState.TERMINATED:
        raise ChallengeLifecycleError(ChallengeLifecycleCode.CHALLENGE_TERMINATED)

    # 2. Ownership binding: a token belongs to exactly one user.
    if presented_user_id is not None and str(presented_user_id) != str(stored_user_id):
        raise ChallengeLifecycleError(
            ChallengeLifecycleCode.TOKEN_USER_MISMATCH,
            f"{ChallengeLifecycleCode.TOKEN_USER_MISMATCH.value}: token was not issued "
            "to this user",
        )

    # 3. TTL expiration (both stored expiry and the token's own claim).
    if current_state is ChallengeState.EXPIRED or now_ts > int(expires_at_ts):
        raise ChallengeLifecycleError(ChallengeLifecycleCode.TOKEN_EXPIRED)

    # 4. State machine legality.
    if not can_transition(current_state, ChallengeState.CONSUMED):
        raise InvalidStateTransitionError(current_state, ChallengeState.CONSUMED)

    # 5. Parse token structure and expiry claim.
    parts = token.split(".")
    if len(parts) != 3:
        raise ChallengeLifecycleError(ChallengeLifecycleCode.MALFORMED_TOKEN_STRUCTURE)

    nonce, exp_str, signature = parts
    try:
        token_exp = int(exp_str)
    except ValueError as err:
        raise ChallengeLifecycleError(ChallengeLifecycleCode.INVALID_TOKEN_EXPIRATION) from err

    if now_ts > token_exp:
        raise ChallengeLifecycleError(ChallengeLifecycleCode.TOKEN_EXPIRED)

    # 6. Constant-time HMAC signature verification.
    secret = (
        secret_key or os.environ.get("SECRET_KEY", "fallback-secret-for-signing-token!!").encode()
    )
    expected_payload = f"{stored_user_id}:{exp_str}:{stored_phrase}:{nonce}"
    expected_sig = hmac.new(secret, expected_payload.encode("utf-8"), hashlib.sha256).hexdigest()

    if not hmac.compare_digest(signature, expected_sig):
        raise ChallengeLifecycleError(ChallengeLifecycleCode.INVALID_TOKEN_SIGNATURE)

    metadata = {
        "nonce": nonce,
        "consumed_at": now_ts,
        "user_id": stored_user_id,
        "phrase": stored_phrase,
    }
    return ChallengeState.CONSUMED, metadata
