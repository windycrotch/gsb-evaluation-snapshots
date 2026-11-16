"""API-level security tests for the /v1 challenge + verify endpoints.

These drive the HTTP surface with locally-built challenges/tokens and mocked
model layers, so no real inference or external service is involved. They assert
that:

* the happy path (first consumption) still yields APPROVE;
* replay, expiry and cross-user reuse are rejected with a *stable, distinct*
  ``error_code`` / ``reason_public`` rather than a generic 500 or empty body;
* illegal challenge-state transitions are refused explicitly.
"""

import io
import time
import uuid
from datetime import timedelta

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

from app.layer3_adaptive import generate_challenge
from app.security.challenge_lifecycle import utcnow

from .challenge_helpers import insert_challenge, make_token


def generate_test_audio(duration_seconds: float = 1.0, sample_rate: int = 16000) -> bytes:
    num_samples = int(duration_seconds * sample_rate)
    audio_data = np.random.randn(num_samples).astype(np.float32) * 0.1
    buffer = io.BytesIO()
    sf.write(buffer, audio_data, sample_rate, format="WAV")
    buffer.seek(0)
    return buffer.read()


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    from app.core.ratelimit import limiter

    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def client():
    from app.main import app

    return TestClient(app)


@pytest.fixture
def enrolled_user_and_voiceprint(db_session):
    from app.models import User, Voiceprint

    user = User(
        id=uuid.uuid4(), name="API User", email=f"api_{uuid.uuid4().hex[:8]}@example.com"
    )
    db_session.add(user)
    db_session.commit()
    db_session.add(Voiceprint(user_id=user.id, embedding=[0.1] * 192, sample_count=1))
    db_session.commit()
    return user


def _post_verify(client, user_id: str, token: str, audio: bytes | None = None):
    return client.post(
        "/v1/verify",
        data={"user_id": str(user_id), "token": token},
        files={"audio": ("test.wav", audio or generate_test_audio(), "audio/wav")},
    )


def _patch_all_pass(monkeypatch):
    """Mock AD/ASR/SV so the happy path is deterministic and model-free."""
    import app.api.v1.verify as verify_mod

    monkeypatch.setattr(
        verify_mod, "detect_spoof", lambda audio: {"label": "bonafide", "confidence": 0.95}
    )
    monkeypatch.setattr(
        verify_mod, "verify_phrase", lambda audio, phrase, threshold: (True, 0.95, phrase)
    )
    monkeypatch.setattr(
        verify_mod,
        "verify_speaker",
        lambda audio, embedding: {"score": 0.85, "embedding": [0.1] * 192},
    )


class TestVerifyHappyPath:
    def test_first_consumption_approves(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        response = _post_verify(client, user.id, challenge["token"])

        assert response.status_code == 200
        data = response.json()
        assert data["decision"] == "APPROVE"
        assert data["error_code"] is None
        assert data["reason_public"] == "OK"

    def test_token_marked_consumed_after_approve(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass(monkeypatch)
        from app.models import Challenge

        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        assert _post_verify(client, user.id, challenge["token"]).json()["decision"] == "APPROVE"

        row = (
            db_session.query(Challenge).filter(Challenge.token == challenge["token"]).one()
        )
        db_session.refresh(row)
        assert row.used is True


class TestVerifyRejections:
    def test_replay_second_submission_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        first = _post_verify(client, user.id, challenge["token"])
        second = _post_verify(client, user.id, challenge["token"])

        assert first.json()["decision"] == "APPROVE"
        assert second.status_code == 200
        data = second.json()
        assert data["decision"] == "DENY"
        assert data["error_code"] == "TOKEN_ALREADY_USED"
        assert data["reason_public"] == "REPLAY_DETECTED"
        assert data["requires_fresh_challenge"] is True

    def test_replay_reason_differs_from_unknown_token(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)
        _post_verify(client, user.id, challenge["token"])

        replay = _post_verify(client, user.id, challenge["token"]).json()
        unknown = _post_verify(client, user.id, "completely-unknown-token").json()

        assert replay["error_code"] == "TOKEN_ALREADY_USED"
        assert unknown["error_code"] == "TOKEN_NOT_FOUND"
        assert replay["error_code"] != unknown["error_code"]
        assert replay["reason_public"] != unknown["reason_public"]

    def test_expired_token_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        from app.models import Challenge

        row = (
            db_session.query(Challenge).filter(Challenge.token == challenge["token"]).one()
        )
        row.expires_at = utcnow() - timedelta(seconds=1)
        db_session.commit()

        response = _post_verify(client, user.id, challenge["token"])

        assert response.status_code == 200
        data = response.json()
        assert data["decision"] == "DENY"
        assert data["error_code"] == "TOKEN_EXPIRED"
        assert data["reason_public"] == "CHALLENGE_EXPIRED"

    def test_expired_signed_claim_rejected_despite_fresh_row(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        """Clock/cache skew guard: the signed expiry claim alone can expire a token."""
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        past_ts = int(time.time()) - 5
        token, payload, signature = make_token(str(user.id), "seven blue dogs", expires_ts=past_ts)
        insert_challenge(
            db_session,
            user.id,
            phrase="seven blue dogs",
            token=token,
            payload=payload,
            signature=signature,
            expires_in=90,  # DB row still looks fresh
        )

        data = _post_verify(client, user.id, token).json()
        assert data["decision"] == "DENY"
        assert data["error_code"] == "TOKEN_EXPIRED"

    def test_cross_user_token_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        """A token issued to user A must not authenticate user B."""
        _patch_all_pass(monkeypatch)
        user_a = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user_a.id), db=db_session)

        from app.models import User, Voiceprint

        user_b = User(
            id=uuid.uuid4(), name="Victim B", email=f"victim_{uuid.uuid4().hex[:8]}@example.com"
        )
        db_session.add(user_b)
        db_session.commit()
        db_session.add(Voiceprint(user_id=user_b.id, embedding=[0.1] * 192, sample_count=1))
        db_session.commit()

        response = _post_verify(client, user_b.id, challenge["token"])

        assert response.status_code == 200
        data = response.json()
        assert data["decision"] == "DENY"
        assert data["error_code"] == "TOKEN_USER_MISMATCH"
        assert data["reason_public"] == "CHALLENGE_INVALID"

        # A's token must remain unused for its rightful owner.
        from app.models import Challenge

        row = (
            db_session.query(Challenge).filter(Challenge.token == challenge["token"]).one()
        )
        db_session.refresh(row)
        assert row.used is False

    def test_rejection_response_is_stable_and_assertable(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        """Every rejection path must carry decision + error_code + reason_public."""
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)
        _post_verify(client, user.id, challenge["token"])

        for token in (challenge["token"], "unknown-token"):
            response = _post_verify(client, user.id, token)
            assert response.status_code == 200, "rejections must not be 500s"
            body = response.json()
            assert body["decision"] == "DENY"
            assert isinstance(body["error_code"], str) and body["error_code"]
            assert isinstance(body["reason_public"], str) and body["reason_public"]


class TestChallengeStateTransitionsOverApi:
    def test_consumed_challenge_cannot_get_new_capture_grant(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        """A consumed challenge must not be re-activated via a capture grant."""
        _patch_all_pass(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)
        assert _post_verify(client, user.id, challenge["token"]).json()["decision"] == "APPROVE"

        response = client.post(
            "/v1/capture/grants",
            json={"user_id": str(user.id), "challenge_id": challenge["challenge_id"]},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "CHALLENGE_CONSUMED"

    def test_expired_challenge_cannot_get_capture_grant(
        self, client, db_session, enrolled_user_and_voiceprint
    ):
        user = enrolled_user_and_voiceprint
        challenge = insert_challenge(db_session, user.id, expires_in=-5)

        response = client.post(
            "/v1/capture/grants",
            json={"user_id": str(user.id), "challenge_id": str(challenge.id)},
        )

        assert response.status_code == 400
        assert response.json()["detail"]["code"] == "CHALLENGE_EXPIRED"

    def test_fresh_challenge_can_get_capture_grant(
        self, client, db_session, enrolled_user_and_voiceprint
    ):
        user = enrolled_user_and_voiceprint
        challenge = insert_challenge(db_session, user.id, expires_in=90)

        response = client.post(
            "/v1/capture/grants",
            json={"user_id": str(user.id), "challenge_id": str(challenge.id)},
        )

        assert response.status_code == 201
        body = response.json()
        assert body["grant_id"]
        assert 0 < body["ttl_seconds"] <= 90

    def test_grant_issue_is_idempotent_for_authorized_challenge(
        self, client, db_session, enrolled_user_and_voiceprint
    ):
        """Re-issuing a grant while still pending is allowed (state stays AUTHORIZED)."""
        user = enrolled_user_and_voiceprint
        challenge = insert_challenge(db_session, user.id, expires_in=90)
        payload = {"user_id": str(user.id), "challenge_id": str(challenge.id)}

        first = client.post("/v1/capture/grants", json=payload)
        second = client.post("/v1/capture/grants", json=payload)

        assert first.status_code == 201
        assert second.status_code == 201
        db_session.refresh(challenge)
        assert challenge.state == "AUTHORIZED"

    def test_terminated_challenge_cannot_get_capture_grant(
        self, client, db_session, enrolled_user_and_voiceprint
    ):
        user = enrolled_user_and_voiceprint
        challenge = insert_challenge(db_session, user.id, state="TERMINATED", expires_in=90)

        response = client.post(
            "/v1/capture/grants",
            json={"user_id": str(user.id), "challenge_id": str(challenge.id)},
        )

        assert response.status_code == 409
        assert response.json()["detail"]["code"] == "CHALLENGE_TERMINATED"


class TestLegacyAuthVerifyRejections:
    """The legacy /auth/verify endpoint must enforce the same lifecycle rules."""

    def _legacy_verify(self, client, user_id, token):
        return client.post(
            "/auth/verify",
            data={"user_id": str(user_id), "token": token},
            files={"audio": ("test.wav", generate_test_audio(), "audio/wav")},
        )

    def test_legacy_replay_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass_legacy(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        first = self._legacy_verify(client, user.id, challenge["token"])
        second = self._legacy_verify(client, user.id, challenge["token"])

        assert first.status_code == 200
        first_body = first.json()
        assert first_body["decision"] == "APPROVE" or first_body["result"] == "ACCEPT"

        assert second.status_code == 200
        body = second.json()
        assert body["decision"] == "DENY"
        assert body["error_code"] == "TOKEN_ALREADY_USED"
        assert body["reason_public"] == "REPLAY_DETECTED"

    def test_legacy_cross_user_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass_legacy(monkeypatch)
        user_a = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user_a.id), db=db_session)

        from app.models import User, Voiceprint

        user_b = User(
            id=uuid.uuid4(), name="B", email=f"b_{uuid.uuid4().hex[:8]}@example.com"
        )
        db_session.add(user_b)
        db_session.commit()
        db_session.add(Voiceprint(user_id=user_b.id, embedding=[0.1] * 192, sample_count=1))
        db_session.commit()

        body = self._legacy_verify(client, user_b.id, challenge["token"]).json()
        assert body["decision"] == "DENY"
        assert body["error_code"] == "TOKEN_USER_MISMATCH"

    def test_legacy_expired_rejected(
        self, client, db_session, enrolled_user_and_voiceprint, monkeypatch
    ):
        _patch_all_pass_legacy(monkeypatch)
        user = enrolled_user_and_voiceprint
        challenge = generate_challenge(str(user.id), db=db_session)

        from app.models import Challenge

        row = (
            db_session.query(Challenge).filter(Challenge.token == challenge["token"]).one()
        )
        row.expires_at = utcnow() - timedelta(seconds=1)
        db_session.commit()

        body = self._legacy_verify(client, user.id, challenge["token"]).json()
        assert body["decision"] == "DENY"
        assert body["error_code"] == "TOKEN_EXPIRED"


def _patch_all_pass_legacy(monkeypatch):
    import app.main as main_mod

    monkeypatch.setattr(
        main_mod, "detect_spoof", lambda audio: {"label": "bonafide", "confidence": 0.95}
    )
    monkeypatch.setattr(
        main_mod, "verify_phrase", lambda audio, phrase, threshold: (True, 0.95, phrase)
    )
    monkeypatch.setattr(
        main_mod,
        "verify_speaker",
        lambda audio, embedding: {"score": 0.85, "embedding": [0.1] * 192},
    )
