"""
Layer 3 — Challenge-Response + EMA - Aditya
Handles dynamic challenges, HMAC-signed token verification with 90s TTL,
single-use enforcement, and adaptive EMA voiceprint updates.
"""
# ruff: noqa: S311 - random.choice is intentional for non-cryptographic phrase generation

import hashlib
import hmac
import os
import random
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from .security.challenge_lifecycle import (
    CHALLENGE_TTL_SECONDS,
    ChallengeLifecycleCode,
    ChallengeLifecycleError,
    ChallengeState,
    challenge_state,
    epoch_seconds,
    utcnow,
)

# Secret key for HMAC token signing (MUST be set via environment variable)
_hmac_secret = os.environ.get("L3_HMAC_SECRET")
if not _hmac_secret:
    # Allow import to succeed in DEBUG mode for development/testing
    # Production MUST have L3_HMAC_SECRET set
    import warnings

    if os.environ.get("DEBUG", "").lower() in ("true", "1", "yes"):
        warnings.warn(
            "L3_HMAC_SECRET not set - using insecure default for DEBUG mode only",
            RuntimeWarning,
            stacklevel=2,
        )
        _hmac_secret = "INSECURE_DEBUG_SECRET_DO_NOT_USE_IN_PRODUCTION"  # noqa: S105
    else:
        from .core.exceptions import MissingSecretError

        raise MissingSecretError("L3_HMAC_SECRET environment variable must be set")

SECRET_KEY = _hmac_secret.encode()

# =============================================================================
# SIMPLE WORD POOLS FOR CLEAR PHRASE GENERATION
# Uses common, easy-to-pronounce words that are phonetically distinct
# Hard for AI to predict, easy for humans to speak clearly
# =============================================================================

# Simple numbers (1-10 only - easy to say)
NUMBERS = [
    "one", "two", "three", "four", "five",
    "six", "seven", "eight", "nine", "ten",
]

# Basic colors - common and clear
COLORS = [
    "red", "blue", "green", "yellow", "orange",
    "purple", "pink", "brown", "black", "white",
    "gray", "gold", "silver",
]

# Common animals - easy to say clearly
ANIMALS = [
    "dog", "cat", "bird", "fish", "horse",
    "cow", "pig", "duck", "frog", "bear",
    "lion", "tiger", "wolf", "fox", "rabbit",
    "mouse", "snake", "monkey", "elephant", "zebra",
]

# Simple objects - everyday items
OBJECTS = [
    "book", "cup", "ball", "chair", "table",
    "door", "window", "car", "tree", "house",
    "phone", "key", "lamp", "clock", "box",
    "bag", "hat", "shoe", "pen", "ring",
]

# Simple words - easy to understand
WORDS = [
    "happy", "sunny", "rainy", "windy", "cloudy",
    "morning", "evening", "summer", "winter", "spring",
    "garden", "river", "mountain", "forest", "beach",
    "music", "story", "picture", "letter", "number",
]

# Simple adjectives - common descriptors
ADJECTIVES = [
    "big", "small", "fast", "slow", "tall",
    "short", "hot", "cold", "new", "old",
    "happy", "quiet", "loud", "soft", "hard",
    "bright", "dark", "clean", "strong", "kind",
]

# Simple verbs - common actions
VERBS = [
    "runs", "jumps", "sits", "walks", "eats",
    "sleeps", "plays", "reads", "sings", "draws",
    "swims", "flies", "drives", "rides", "climbs",
]

# Simple places
PLACES = [
    "park", "home", "school", "store", "beach",
    "farm", "city", "town", "lake", "hill",
]

# =============================================================================
# SIMPLE PHRASE TEMPLATES - Easy to speak, hard to predict
# =============================================================================


def _generate_dynamic_phrase() -> str:
    """
    Generate a simple, clear challenge phrase.

    Uses common words that are easy to pronounce and unlikely to be misheard.
    Phrases are 3-5 words for clarity.

    Entropy: 10 × 13 × 20 × 20 × 15 = 780,000+ unique combinations
    """
    template = random.randint(1, 8)

    if template == 1:
        # "NUMBER COLOR ANIMAL" - e.g., "three blue dogs"
        return f"{random.choice(NUMBERS)} {random.choice(COLORS)} {random.choice(ANIMALS)}"

    elif template == 2:
        # "The ADJECTIVE ANIMAL VERB" - e.g., "The big cat sleeps"
        return f"The {random.choice(ADJECTIVES)} {random.choice(ANIMALS)} {random.choice(VERBS)}"

    elif template == 3:
        # "COLOR OBJECT and OBJECT" - e.g., "red book and cup"
        return f"{random.choice(COLORS)} {random.choice(OBJECTS)} and {random.choice(OBJECTS)}"

    elif template == 4:
        # "NUMBER ADJECTIVE OBJECTS" - e.g., "five small chairs"
        return f"{random.choice(NUMBERS)} {random.choice(ADJECTIVES)} {random.choice(OBJECTS)}"

    elif template == 5:
        # "The ANIMAL VERB at PLACE" - e.g., "The dog runs at park"
        return f"The {random.choice(ANIMALS)} {random.choice(VERBS)} at {random.choice(PLACES)}"

    elif template == 6:
        # "ADJECTIVE COLOR OBJECT" - e.g., "big red ball"
        return f"{random.choice(ADJECTIVES)} {random.choice(COLORS)} {random.choice(OBJECTS)}"

    elif template == 7:
        # "My ANIMAL is ADJECTIVE" - e.g., "My cat is happy"
        return f"My {random.choice(ANIMALS)} is {random.choice(ADJECTIVES)}"

    else:  # template == 8
        # "NUMBER ANIMALS in PLACE" - e.g., "two birds in park"
        return f"{random.choice(NUMBERS)} {random.choice(ANIMALS)} in {random.choice(PLACES)}"


# =============================================================================
# DATABASE-BACKED TOKEN PERSISTENCE
# Replaces in-memory storage for production reliability
# =============================================================================


@dataclass(frozen=True)
class TokenConsumption:
    """Outcome of a challenge-token consumption attempt.

    ``code`` is always populated with a stable machine-readable identifier so
    callers can distinguish replay (``TOKEN_ALREADY_USED``), expiry
    (``TOKEN_EXPIRED``), cross-user misuse (``TOKEN_USER_MISMATCH``) and plain
    invalid tokens (``TOKEN_NOT_FOUND``) instead of collapsing them into one
    generic failure.
    """

    valid: bool
    code: ChallengeLifecycleCode
    challenge_id: str | None = None
    user_id: str | None = None
    phrase: str | None = None
    expires_at: datetime | None = None


#: Maps a lifecycle rejection code to the public policy reason code.
_LIFECYCLE_PUBLIC_REASONS: dict[ChallengeLifecycleCode, str] = {
    ChallengeLifecycleCode.TOKEN_ALREADY_USED: "REPLAY_DETECTED",
    ChallengeLifecycleCode.TOKEN_EXPIRED: "CHALLENGE_EXPIRED",
    ChallengeLifecycleCode.TOKEN_NOT_FOUND: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.MALFORMED_TOKEN_STRUCTURE: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.INVALID_TOKEN_EXPIRATION: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.INVALID_TOKEN_SIGNATURE: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.INVALID_CHALLENGE_STATE: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.INVALID_STATE_TRANSITION: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.CHALLENGE_TERMINATED: "CHALLENGE_INVALID",
    ChallengeLifecycleCode.TOKEN_USER_MISMATCH: "CHALLENGE_INVALID",
}


def public_reason_for(code: ChallengeLifecycleCode | str) -> str:
    """Translate a lifecycle rejection code into a stable public reason code."""
    try:
        code = ChallengeLifecycleCode(code)
    except ValueError:
        return "CHALLENGE_INVALID"
    return _LIFECYCLE_PUBLIC_REASONS.get(code, "CHALLENGE_INVALID")


def generate_challenge(user_id: str, db: Session | None = None) -> dict:
    """
    Generate a dynamic challenge phrase and single-use HMAC-SHA256 signed token with 90s TTL.

    If db session is provided, persists the challenge to database.
    If db is None, returns the challenge without persistence (for testing/legacy).

    Args:
        user_id: UUID of the user requesting authentication
        db: Optional SQLAlchemy session for persistence

    Returns:
        {"phrase": str, "token": str, "expires_at": datetime, "challenge_id": str (if persisted)}
    """
    phrase = _generate_dynamic_phrase()

    # Expiration: strictly 90 seconds (per shared contract section 6 & layer3 spec)
    now = utcnow()
    expires_at = now + timedelta(seconds=CHALLENGE_TTL_SECONDS)
    # Use the true Unix epoch for the signed claim. ``datetime.timestamp()`` on a
    # naive datetime interprets it in local time, which silently shifts the
    # embedded expiry by the host's UTC offset (and breaks expiry checks).
    expires_timestamp = str(epoch_seconds(expires_at))

    # Create raw payload and sign with HMAC-SHA256
    raw_nonce = secrets.token_hex(16)
    raw_payload = f"{user_id}:{expires_timestamp}:{phrase}:{raw_nonce}"
    signature = hmac.new(SECRET_KEY, raw_payload.encode("utf-8"), hashlib.sha256).hexdigest()

    # URL-safe HMAC token
    token = f"{raw_nonce}.{expires_timestamp}.{signature}"

    result = {"phrase": phrase, "token": token, "expires_at": expires_at}

    # Persist to database if session provided
    if db is not None:
        import uuid

        from .models import Challenge

        challenge = Challenge(
            id=uuid.uuid4(),
            user_id=uuid.UUID(user_id) if isinstance(user_id, str) else user_id,
            phrase=phrase,
            token=token,
            signature=signature,
            payload=raw_payload,
            expires_at=expires_at,
            used=False,
            state=ChallengeState.CREATED.value,
        )
        db.add(challenge)
        db.commit()
        db.refresh(challenge)
        result["challenge_id"] = str(challenge.id)

    return result


def _verify_signature(challenge, token: str) -> bool:
    """Verify the HMAC signature of the *presented* token, in constant time.

    The signed payload is reconstructed from the presented token's nonce/expiry
    combined with the user_id and phrase stored in the database. This means a
    forged or edited token can never be accepted by replaying a previously stored
    signature: the signature must actually cover the presented nonce and expiry.
    """
    parts = token.split(".")
    if len(parts) != 3:
        return False
    nonce, exp_str, signature = parts
    payload = f"{challenge.user_id}:{exp_str}:{challenge.phrase}:{nonce}"
    expected_sig = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected_sig)


def validate_challenge_token(
    token: str,
    db: Session,
    expected_user_id: str | None = None,
    now: datetime | None = None,
) -> TokenConsumption:
    """Read-only validation of a challenge token (no state mutation).

    Returns a ``TokenConsumption`` whose ``code`` explains any rejection. This is
    used as a cheap pre-flight before running model inference, so lifecycle
    failures produce a stable, assertable reason instead of falling through to
    the acoustic gates.
    """
    if not token or not db or not token.strip():
        return TokenConsumption(valid=False, code=ChallengeLifecycleCode.TOKEN_NOT_FOUND)

    from .models import Challenge

    now = now or utcnow()
    challenge = db.query(Challenge).filter(Challenge.token == token).first()
    if challenge is None:
        return TokenConsumption(valid=False, code=ChallengeLifecycleCode.TOKEN_NOT_FOUND)

    result = TokenConsumption(
        valid=False,
        code=ChallengeLifecycleCode.INVALID_CHALLENGE_STATE,
        challenge_id=str(challenge.id),
        user_id=str(challenge.user_id),
        phrase=challenge.phrase,
        expires_at=challenge.expires_at,
    )

    try:
        state = challenge_state(challenge, now=now)
    except ChallengeLifecycleError as err:
        return TokenConsumption(
            valid=False,
            code=ChallengeLifecycleCode(err.code),
            challenge_id=result.challenge_id,
            user_id=result.user_id,
            phrase=result.phrase,
            expires_at=result.expires_at,
        )

    # Terminal states first: a replayed token must report replay even if its TTL
    # has also elapsed by the time of the second submission.
    if state in (ChallengeState.CONSUMED, ChallengeState.COMPLETED):
        code = ChallengeLifecycleCode.TOKEN_ALREADY_USED
    elif state is ChallengeState.TERMINATED:
        code = ChallengeLifecycleCode.CHALLENGE_TERMINATED
    elif state is ChallengeState.EXPIRED:
        code = ChallengeLifecycleCode.TOKEN_EXPIRED
    elif expected_user_id is not None and str(expected_user_id) != str(challenge.user_id):
        # Ownership binding: never let user B ride on user A's challenge.
        code = ChallengeLifecycleCode.TOKEN_USER_MISMATCH
    else:
        # Structural + signature validation for pending tokens.
        parts = token.split(".")
        if len(parts) != 3:
            code = ChallengeLifecycleCode.MALFORMED_TOKEN_STRUCTURE
        else:
            try:
                token_exp = int(parts[1])
            except ValueError:
                code = ChallengeLifecycleCode.INVALID_TOKEN_EXPIRATION
            else:
                if epoch_seconds(now) > token_exp:
                    # The signed claim itself has passed; treat exactly like DB expiry.
                    code = ChallengeLifecycleCode.TOKEN_EXPIRED
                elif not _verify_signature(challenge, token):
                    code = ChallengeLifecycleCode.INVALID_TOKEN_SIGNATURE
                else:
                    return TokenConsumption(
                        valid=True,
                        code=ChallengeLifecycleCode.TOKEN_VALID,
                        challenge_id=result.challenge_id,
                        user_id=result.user_id,
                        phrase=result.phrase,
                        expires_at=result.expires_at,
                    )

    return TokenConsumption(
        valid=False,
        code=code,
        challenge_id=result.challenge_id,
        user_id=result.user_id,
        phrase=result.phrase,
        expires_at=result.expires_at,
    )


def consume_challenge_token(
    token: str,
    db: Session,
    expected_user_id: str | None = None,
    now: datetime | None = None,
) -> TokenConsumption:
    """Atomically validate *and* consume a challenge token exactly once.

    Single-use is enforced by a conditional ``UPDATE`` (``used = false AND
    expires_at > :now``), so two concurrent submissions can never both succeed.
    When the update matches no row the current row is re-read to return a
    precise, stable rejection code.

    Args:
        token: Challenge token presented by the caller.
        db: SQLAlchemy session (required).
        expected_user_id: User the verification request claims to authenticate.
            When provided the token must have been issued to this exact user.
        now: Injectable clock (testing only).
    """
    if not token or not db or not str(token).strip():
        return TokenConsumption(valid=False, code=ChallengeLifecycleCode.TOKEN_NOT_FOUND)

    from .models import Challenge

    now = now or utcnow()
    challenge = db.query(Challenge).filter(Challenge.token == token).first()
    if challenge is None:
        return TokenConsumption(valid=False, code=ChallengeLifecycleCode.TOKEN_NOT_FOUND)

    precheck = validate_challenge_token(token, db, expected_user_id=expected_user_id, now=now)
    if not precheck.valid:
        return precheck

    # Atomic consume. ``used`` is the canonical flag; ``state``/``consumed_at``
    # are kept in sync. The ownership predicate is part of the UPDATE itself so
    # that a concurrent request from another user cannot slip in between the
    # pre-check and the write.
    params = {"token": token, "now": now}
    if expected_user_id is None:
        full_statement = text("""
            UPDATE challenges
            SET used = true, state = 'CONSUMED', consumed_at = :now
            WHERE token = :token
              AND used = false
              AND expires_at > :now
        """)
        legacy_statement = text("""
            UPDATE challenges
            SET used = true
            WHERE token = :token
              AND used = false
              AND expires_at > :now
        """)
    else:
        params["user_id"] = str(expected_user_id)
        full_statement = text("""
            UPDATE challenges
            SET used = true, state = 'CONSUMED', consumed_at = :now
            WHERE token = :token
              AND used = false
              AND expires_at > :now
              AND user_id = :user_id
        """)
        legacy_statement = text("""
            UPDATE challenges
            SET used = true
            WHERE token = :token
              AND used = false
              AND expires_at > :now
              AND user_id = :user_id
        """)

    try:
        result = db.execute(full_statement, params)
    except Exception:
        # Deployment without migration 004 (no state/consumed_at columns):
        # fall back to the legacy `used`-only update rather than failing open.
        db.rollback()
        result = db.execute(legacy_statement, params)
    db.commit()

    if result.rowcount == 0:
        # Lost the race, expired between pre-check and update, or wrong owner.
        db.expire_all()
        return _classify_consumption_failure(token, db, expected_user_id, now)

    return TokenConsumption(
        valid=True,
        code=ChallengeLifecycleCode.TOKEN_CONSUMED,
        challenge_id=str(challenge.id),
        user_id=str(challenge.user_id),
        phrase=challenge.phrase,
        expires_at=challenge.expires_at,
    )


def _classify_consumption_failure(
    token: str, db: Session, expected_user_id: str | None, now: datetime
) -> TokenConsumption:
    """Explain why the atomic consume matched no rows."""
    from .models import Challenge

    challenge = db.query(Challenge).filter(Challenge.token == token).first()
    if challenge is None:
        return TokenConsumption(valid=False, code=ChallengeLifecycleCode.TOKEN_NOT_FOUND)

    challenge_data = {
        "challenge_id": str(challenge.id),
        "user_id": str(challenge.user_id),
        "phrase": challenge.phrase,
        "expires_at": challenge.expires_at,
    }
    if challenge.used or getattr(challenge, "state", None) in (
        ChallengeState.CONSUMED.value,
        ChallengeState.COMPLETED.value,
    ):
        code = ChallengeLifecycleCode.TOKEN_ALREADY_USED
    elif expected_user_id is not None and str(expected_user_id) != str(challenge.user_id):
        code = ChallengeLifecycleCode.TOKEN_USER_MISMATCH
    elif challenge.expires_at is None or challenge.expires_at <= now:
        code = ChallengeLifecycleCode.TOKEN_EXPIRED
    else:
        code = ChallengeLifecycleCode.INVALID_CHALLENGE_STATE

    return TokenConsumption(valid=False, code=code, **challenge_data)


def verify_token(token: str, db: Session = None) -> bool:
    """
    Verify token is valid (exists, HMAC valid, not expired, not used).
    Enforces single-use by marking token as used immediately.

    Uses atomic database operations to prevent race conditions.

    Args:
        token: Challenge token to verify
        db: Optional SQLAlchemy session for database verification

    Returns:
        True if token is valid and now consumed, False otherwise
    """
    if not token:
        return False

    if db is None:
        # Legacy behavior: no database, always return False
        return False

    return consume_challenge_token(token, db).valid


def validate_and_consume_token(
    token: str, db: Session, expected_user_id: str | None = None
) -> dict | None:
    """
    Atomically validate and consume a challenge token.

    Returns challenge data if valid, None otherwise.
    This is the recommended function for production use.

    Args:
        token: Challenge token to verify
        db: SQLAlchemy session (required)
        expected_user_id: Optional user the caller claims to authenticate; the
            token must belong to this user (cross-user reuse is rejected).

    Returns:
        dict with challenge data if valid, None otherwise
    """
    if not token or not db:
        return None

    outcome = consume_challenge_token(token, db, expected_user_id=expected_user_id)
    if not outcome.valid:
        return None

    return {
        "challenge_id": outcome.challenge_id,
        "id": outcome.challenge_id,
        "user_id": outcome.user_id,
        "phrase": outcome.phrase,
        "token": token,
        "expires_at": outcome.expires_at,
    }


def get_token_user_id(token: str, db: Session = None) -> str | None:
    """Get the user_id associated with a token."""
    if not token:
        return None

    if db is None:
        return None

    from .models import Challenge

    challenge = db.query(Challenge).filter(Challenge.token == token).first()
    if challenge:
        return str(challenge.user_id)
    return None


def get_token_phrase(token: str, db: Session = None) -> str | None:
    """Get the challenge phrase associated with a *usable* token.

    Returns ``None`` when the token is unknown, expired, already consumed or
    terminated. Callers use this both to decide which phrase to expect and as a
    pre-flight check, so a replay must not be able to recover the phrase.
    """
    if not token or db is None:
        return None

    outcome = validate_challenge_token(token, db)
    if not outcome.valid:
        return None
    return outcome.phrase


def cleanup_expired_tokens(db: Session) -> int:
    """
    Remove expired challenge tokens from database.

    Should be called periodically (e.g., via background task or cron).

    Args:
        db: SQLAlchemy session

    Returns:
        Number of tokens deleted
    """
    now = utcnow()
    result = db.execute(text("DELETE FROM challenges WHERE expires_at < :now"), {"now": now})
    db.commit()
    return result.rowcount


# Legacy in-memory store for backward compatibility with tests
# WARNING: Do not use in production - use database-backed functions instead
_token_store: dict[str, dict] = {}


def update_voiceprint(
    old_embedding: list[float], new_embedding: list[float], alpha: float = 0.2
) -> list[float]:
    """
    Exponential Moving Average update of voiceprint.
    Formula: New = (1 - alpha) * Old + alpha * Current
    With alpha = 0.2: New = 0.8 * Old + 0.2 * Current
    (weights Current embedding by 0.2, Old by 0.8)

    Args:
        old_embedding: Current stored embedding (192-dim)
        new_embedding: New embedding from successful authentication (192-dim)
        alpha: Weight for current embedding (default 0.2)

    Returns:
        Updated embedding vector (same dimension)
    """
    if len(old_embedding) != len(new_embedding):
        raise ValueError(
            f"Embedding dimension mismatch: {len(old_embedding)} vs {len(new_embedding)}"
        )

    # Calculate elementwise: 0.8 * old + 0.2 * current
    updated = [
        (1.0 - alpha) * old_val + alpha * new_val
        for old_val, new_val in zip(old_embedding, new_embedding, strict=True)
    ]

    return updated
