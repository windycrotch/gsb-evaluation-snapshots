"""Shared helpers for challenge-token lifecycle security tests.

Everything here is locally constructed (no real model inference, no external
services): challenges are inserted straight into a temp DB and tokens are signed
with the same HMAC secret the application uses.

The ``challenge_user`` / ``other_user`` fixtures live in ``conftest.py``.
"""

import hashlib
import hmac
import time
import uuid
from datetime import timedelta

from app.layer3_adaptive import SECRET_KEY
from app.models import Challenge
from app.security.challenge_lifecycle import ChallengeState, utcnow


def make_token(user_id: str, phrase: str, *, expires_ts: int | None = None, nonce: str | None = None):
    """Build an HMAC-signed token for (user_id, phrase) exactly like production does."""
    expires_ts = int(time.time()) + 90 if expires_ts is None else int(expires_ts)
    nonce = nonce or uuid.uuid4().hex
    payload = f"{user_id}:{expires_ts}:{phrase}:{nonce}"
    signature = hmac.new(SECRET_KEY, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{nonce}.{expires_ts}.{signature}", payload, signature


def insert_challenge(
    db_session,
    user_id,
    *,
    phrase: str = "seven blue dogs",
    token: str | None = None,
    payload: str | None = None,
    signature: str | None = None,
    expires_in: int = 90,
    used: bool = False,
    state: str | None = ChallengeState.CREATED.value,
) -> Challenge:
    """Insert a challenge row directly, optionally with a matching signed token."""
    if token is None:
        token, payload, signature = make_token(
            str(user_id), phrase, expires_ts=int(time.time()) + expires_in
        )

    challenge = Challenge(
        id=uuid.uuid4(),
        user_id=user_id if not isinstance(user_id, str) else uuid.UUID(user_id),
        phrase=phrase,
        token=token,
        payload=payload,
        signature=signature,
        expires_at=utcnow() + timedelta(seconds=expires_in),
        used=used,
        state=state,
    )
    db_session.add(challenge)
    db_session.commit()
    db_session.refresh(challenge)
    return challenge
