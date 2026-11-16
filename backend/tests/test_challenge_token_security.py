"""Security tests for challenge-token lifecycle: single use, TTL, user binding.

Covers the threat the task calls out: an attacker who records someone else's
successful authentication must not be able to replay the capture grant / challenge
token -- neither a second time, nor after expiry, nor against a different user.

All challenges and tokens are constructed locally; no model inference and no
external services are involved.
"""

from datetime import timedelta

import pytest

from app.layer3_adaptive import (
    ChallengeLifecycleCode,
    consume_challenge_token,
    generate_challenge,
    public_reason_for,
    validate_and_consume_token,
    validate_challenge_token,
    verify_token,
)
from app.security.challenge_lifecycle import (
    ChallengeLifecycleError,
    ChallengeState,
    InvalidStateTransitionError,
    can_transition,
    challenge_state,
    epoch_seconds,
    transition_challenge,
    utcnow,
)

from .challenge_helpers import insert_challenge, make_token

pytestmark = pytest.mark.usefixtures("db_session")


# ---------------------------------------------------------------------------
# Happy path: first consumption succeeds
# ---------------------------------------------------------------------------


class TestFirstConsumptionSucceeds:
    def test_first_consumption_returns_challenge_data(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id, phrase="seven blue dogs")

        outcome = consume_challenge_token(
            challenge.token, db_session, expected_user_id=str(challenge_user.id)
        )

        assert outcome.valid is True
        assert outcome.code is ChallengeLifecycleCode.TOKEN_CONSUMED
        assert outcome.challenge_id == str(challenge.id)
        assert outcome.user_id == str(challenge_user.id)
        assert outcome.phrase == "seven blue dogs"

    def test_first_consumption_marks_row_used(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)

        assert verify_token(challenge.token, db_session) is True

        db_session.refresh(challenge)
        assert challenge.used is True
        assert challenge.state == ChallengeState.CONSUMED.value
        assert challenge.consumed_at is not None

    def test_generate_challenge_token_is_consumable(self, db_session, challenge_user):
        """End-to-end with the real generator: generated token consumes exactly once."""
        data = generate_challenge(str(challenge_user.id), db=db_session)

        first = consume_challenge_token(
            data["token"], db_session, expected_user_id=str(challenge_user.id)
        )
        second = consume_challenge_token(
            data["token"], db_session, expected_user_id=str(challenge_user.id)
        )

        assert first.valid is True
        assert second.valid is False
        assert second.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED

    def test_validate_then_consume_full_flow(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)

        precheck = validate_challenge_token(
            challenge.token, db_session, expected_user_id=str(challenge_user.id)
        )
        assert precheck.valid is True
        assert precheck.code is ChallengeLifecycleCode.TOKEN_VALID

        # Pre-flight validation must not consume the token.
        assert consume_challenge_token(
            challenge.token, db_session, expected_user_id=str(challenge_user.id)
        ).valid is True


# ---------------------------------------------------------------------------
# Second submission: rejected, and distinguishable from an unknown token
# ---------------------------------------------------------------------------


class TestReplayRejected:
    def test_second_consumption_rejected(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)

        assert consume_challenge_token(challenge.token, db_session).valid is True
        replay = consume_challenge_token(challenge.token, db_session)

        assert replay.valid is False
        assert replay.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED

    def test_replay_reason_differs_from_unknown_token(self, db_session, challenge_user):
        """Replay must be distinguishable from a token that never existed."""
        challenge = insert_challenge(db_session, challenge_user.id)
        consume_challenge_token(challenge.token, db_session)

        replay = consume_challenge_token(challenge.token, db_session)
        unknown = consume_challenge_token("not-a-real-token", db_session)

        assert replay.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED
        assert unknown.code is ChallengeLifecycleCode.TOKEN_NOT_FOUND
        assert replay.code != unknown.code

        # And they map to distinct, stable public reason codes.
        assert public_reason_for(replay.code) == "REPLAY_DETECTED"
        assert public_reason_for(unknown.code) == "CHALLENGE_INVALID"

    def test_replay_reason_differs_from_expiry(self, db_session, challenge_user):
        """Replay must be distinguishable from expiry, even if TTL also elapsed."""
        challenge = insert_challenge(db_session, challenge_user.id, expires_in=90)
        assert consume_challenge_token(challenge.token, db_session).valid is True

        # Wind the clock well past the token's TTL; replay must still say "used".
        future = utcnow() + timedelta(seconds=600)
        replay = consume_challenge_token(challenge.token, db_session, now=future)

        assert replay.valid is False
        assert replay.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED

    def test_validate_replay_reports_used(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        consume_challenge_token(challenge.token, db_session)

        check = validate_challenge_token(challenge.token, db_session)
        assert check.valid is False
        assert check.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED

    def test_replay_does_not_return_phrase(self, db_session, challenge_user):
        """A replaying caller must not even learn the expected phrase."""
        challenge = insert_challenge(db_session, challenge_user.id, phrase="secret phrase")
        consume_challenge_token(challenge.token, db_session)

        check = validate_challenge_token(challenge.token, db_session)
        assert check.valid is False

        from app.layer3_adaptive import get_token_phrase

        assert get_token_phrase(challenge.token, db_session) is None


# ---------------------------------------------------------------------------
# Expiry: rejected, never treated as valid because of clock/cache quirks
# ---------------------------------------------------------------------------


class TestExpiredTokenRejected:
    def test_expired_in_database_rejected(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)

        # Force the stored expiry into the past (simulates a stale cache/TTL).
        challenge.expires_at = utcnow() - timedelta(seconds=1)
        db_session.commit()

        outcome = consume_challenge_token(challenge.token, db_session)
        assert outcome.valid is False
        assert outcome.code is ChallengeLifecycleCode.TOKEN_EXPIRED

    def test_expired_row_not_consumed(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        challenge.expires_at = utcnow() - timedelta(seconds=1)
        db_session.commit()

        consume_challenge_token(challenge.token, db_session)

        db_session.refresh(challenge)
        assert challenge.used is False

    def test_signed_claim_expiry_enforced(self, db_session, challenge_user):
        """Token whose signed expiry claim has passed is rejected even if the DB
        row still claims it is fresh (clock/cache skew simulation)."""
        past_ts = epoch_seconds(utcnow()) - 5
        token, payload, signature = make_token(
            str(challenge_user.id), "seven blue dogs", expires_ts=past_ts
        )
        challenge = insert_challenge(
            db_session,
            challenge_user.id,
            phrase="seven blue dogs",
            token=token,
            payload=payload,
            signature=signature,
            expires_in=90,  # DB row says still valid
        )

        outcome = consume_challenge_token(challenge.token, db_session)
        assert outcome.valid is False
        assert outcome.code is ChallengeLifecycleCode.TOKEN_EXPIRED

    def test_expiry_public_reason_is_challenge_expired(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        challenge.expires_at = utcnow() - timedelta(seconds=1)
        db_session.commit()

        outcome = consume_challenge_token(challenge.token, db_session)
        assert public_reason_for(outcome.code) == "CHALLENGE_EXPIRED"

    def test_timestamp_round_trip_is_timezone_independent(self, db_session, challenge_user):
        """The signed expiry must be a true epoch timestamp, not local-time shifted.

        A naive ``datetime.utcnow().timestamp()`` embeds local time and makes a
        90s token appear already expired (or valid far too long) on non-UTC hosts.
        """
        import time

        before = int(time.time())
        data = generate_challenge(str(challenge_user.id), db=db_session)
        after = int(time.time())

        token_exp = int(data["token"].split(".")[1])
        assert before + 85 <= token_exp <= after + 95, (
            f"embedded expiry {token_exp} is not ~90s ahead of epoch clock "
            f"[{before}, {after}]"
        )

        # The DB row and the signed claim must agree within 1s.
        from app.security.challenge_lifecycle import epoch_seconds

        assert abs(epoch_seconds(data["expires_at"]) - token_exp) <= 1


# ---------------------------------------------------------------------------
# Cross-user misuse: A's token must never authorize B
# ---------------------------------------------------------------------------


class TestCrossUserTokenRejected:
    def test_user_b_cannot_consume_user_a_token(self, db_session, challenge_user, other_user):
        challenge = insert_challenge(db_session, challenge_user.id)

        outcome = consume_challenge_token(
            challenge.token, db_session, expected_user_id=str(other_user.id)
        )

        assert outcome.valid is False
        assert outcome.code is ChallengeLifecycleCode.TOKEN_USER_MISMATCH

    def test_user_b_token_remains_unused_after_rejection(
        self, db_session, challenge_user, other_user
    ):
        challenge = insert_challenge(db_session, challenge_user.id)

        consume_challenge_token(
            challenge.token, db_session, expected_user_id=str(other_user.id)
        )
        db_session.refresh(challenge)
        assert challenge.used is False

        # Owner can still use it afterwards.
        assert consume_challenge_token(
            challenge.token, db_session, expected_user_id=str(challenge_user.id)
        ).valid is True

    def test_cross_user_validate_reports_mismatch(self, db_session, challenge_user, other_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        check = validate_challenge_token(
            challenge.token, db_session, expected_user_id=str(other_user.id)
        )
        assert check.valid is False
        assert check.code is ChallengeLifecycleCode.TOKEN_USER_MISMATCH

    def test_cross_user_differs_from_replay(self, db_session, challenge_user, other_user):
        a_challenge = insert_challenge(db_session, challenge_user.id)
        b_challenge = insert_challenge(db_session, other_user.id)
        consume_challenge_token(b_challenge.token, db_session)

        mismatch = consume_challenge_token(
            a_challenge.token, db_session, expected_user_id=str(other_user.id)
        )
        replay = consume_challenge_token(b_challenge.token, db_session)

        assert mismatch.code is ChallengeLifecycleCode.TOKEN_USER_MISMATCH
        assert replay.code is ChallengeLifecycleCode.TOKEN_ALREADY_USED
        assert mismatch.code != replay.code

    def test_validate_and_consume_token_returns_none_for_cross_user(
        self, db_session, challenge_user, other_user
    ):
        challenge = insert_challenge(db_session, challenge_user.id)
        assert (
            validate_and_consume_token(
                challenge.token, db_session, expected_user_id=str(other_user.id)
            )
            is None
        )


# ---------------------------------------------------------------------------
# Structural / signature rejection codes
# ---------------------------------------------------------------------------


class TestTokenStructureRejections:
    def test_unknown_token(self, db_session):
        assert (
            consume_challenge_token("does-not-exist", db_session).code
            is ChallengeLifecycleCode.TOKEN_NOT_FOUND
        )

    def test_empty_token(self, db_session):
        for value in ("", "   ", None):
            assert (
                consume_challenge_token(value, db_session).code
                is ChallengeLifecycleCode.TOKEN_NOT_FOUND
            )

    def test_malformed_structure(self, db_session, challenge_user):
        challenge = insert_challenge(
            db_session,
            challenge_user.id,
            token="only.two",
            payload=f"{challenge_user.id}:1:x:n",
        )
        outcome = consume_challenge_token(challenge.token, db_session)
        assert outcome.code is ChallengeLifecycleCode.MALFORMED_TOKEN_STRUCTURE

    def test_tampered_signature(self, db_session, challenge_user):
        """A structurally valid token whose signature does not cover its payload
        must be rejected with INVALID_TOKEN_SIGNATURE, not silently accepted."""
        token, payload, signature = make_token(str(challenge_user.id), "seven blue dogs")
        tampered = token[:-4] + "dead"

        # Simulate the row being present with the tampered token (e.g. written by a
        # deployment with a different signing key / corrupted storage).
        challenge = insert_challenge(
            db_session,
            challenge_user.id,
            phrase="seven blue dogs",
            token=tampered,
            payload=payload,
            signature=signature,
        )

        outcome = consume_challenge_token(challenge.token, db_session)
        assert outcome.valid is False
        assert outcome.code is ChallengeLifecycleCode.INVALID_TOKEN_SIGNATURE

    def test_tampered_token_not_in_database_is_not_found(self, db_session, challenge_user):
        """Editing any part of a token makes it unknown -> TOKEN_NOT_FOUND."""
        challenge = insert_challenge(db_session, challenge_user.id)
        tampered = challenge.token[:-4] + "dead"

        outcome = consume_challenge_token(tampered, db_session)
        assert outcome.valid is False
        assert outcome.code is ChallengeLifecycleCode.TOKEN_NOT_FOUND

        # The original token remains usable.
        db_session.refresh(challenge)
        assert challenge.used is False

    def test_tampered_token_does_not_consume_row(self, db_session, challenge_user):
        token, payload, signature = make_token(str(challenge_user.id), "seven blue dogs")
        tampered = token[:-4] + "dead"
        challenge = insert_challenge(
            db_session,
            challenge_user.id,
            phrase="seven blue dogs",
            token=tampered,
            payload=payload,
            signature=signature,
        )
        consume_challenge_token(challenge.token, db_session)

        db_session.refresh(challenge)
        assert challenge.used is False


# ---------------------------------------------------------------------------
# Challenge state machine: reactivation must be impossible
# ---------------------------------------------------------------------------


class TestStateMachine:
    def test_consumed_challenge_cannot_be_reactivated(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        consume_challenge_token(challenge.token, db_session)
        db_session.refresh(challenge)

        for target in (
            ChallengeState.CREATED,
            ChallengeState.AUTHORIZED,
            ChallengeState.CAPTURE_RECEIVED,
        ):
            with pytest.raises(InvalidStateTransitionError) as err:
                transition_challenge(challenge, target)
            assert err.value.code == ChallengeLifecycleCode.INVALID_STATE_TRANSITION.value

    def test_illegal_transition_leaves_row_untouched(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        consume_challenge_token(challenge.token, db_session)
        db_session.refresh(challenge)
        before = (challenge.used, challenge.state)

        with pytest.raises(InvalidStateTransitionError):
            transition_challenge(challenge, ChallengeState.AUTHORIZED)

        db_session.refresh(challenge)
        assert (challenge.used, challenge.state) == before

    def test_expired_challenge_cannot_be_reactivated(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id, expires_in=-5)
        db_session.refresh(challenge)

        with pytest.raises(InvalidStateTransitionError):
            transition_challenge(challenge, ChallengeState.CAPTURE_RECEIVED)

        db_session.refresh(challenge)
        assert challenge.expires_at < utcnow()

    def test_expired_state_has_no_pending_transitions(self):
        assert can_transition(ChallengeState.EXPIRED, ChallengeState.CREATED) is False
        assert can_transition(ChallengeState.EXPIRED, ChallengeState.AUTHORIZED) is False
        assert can_transition(ChallengeState.EXPIRED, ChallengeState.CAPTURE_RECEIVED) is False

    def test_consumed_state_has_no_pending_transitions(self):
        assert can_transition(ChallengeState.CONSUMED, ChallengeState.CREATED) is False
        assert can_transition(ChallengeState.CONSUMED, ChallengeState.AUTHORIZED) is False
        assert can_transition(ChallengeState.CONSUMED, ChallengeState.CAPTURE_RECEIVED) is False

    def test_terminal_states_are_terminal(self):
        for terminal in (
            ChallengeState.COMPLETED,
            ChallengeState.TERMINATED,
        ):
            for target in ChallengeState:
                assert can_transition(terminal, target) is False

    def test_legal_pending_transitions_still_work(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id)
        assert transition_challenge(challenge, ChallengeState.AUTHORIZED) is ChallengeState.AUTHORIZED
        assert (
            transition_challenge(challenge, ChallengeState.CAPTURE_RECEIVED)
            is ChallengeState.CAPTURE_RECEIVED
        )
        assert (
            transition_challenge(challenge, ChallengeState.CONSUMED)
            is ChallengeState.CONSUMED
        )

    def test_derived_state_respects_used_flag(self, db_session, challenge_user):
        """A row marked used is CONSUMED regardless of a stale ``state`` column."""
        challenge = insert_challenge(db_session, challenge_user.id, used=True)
        assert challenge_state(challenge) is ChallengeState.CONSUMED

    def test_derived_state_respects_expiry(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id, expires_in=-1)
        assert challenge_state(challenge) is ChallengeState.EXPIRED

    def test_unknown_state_raises(self, db_session, challenge_user):
        challenge = insert_challenge(db_session, challenge_user.id, state="BOGUS")
        with pytest.raises(ChallengeLifecycleError) as err:
            challenge_state(challenge)
        assert err.value.code == ChallengeLifecycleCode.INVALID_CHALLENGE_STATE.value

    def test_pure_state_machine_consume_success(self):
        token, exp_ts = _helper_token("user-01", "seven blue dogs")
        from app.security.challenge_lifecycle import validate_and_consume_challenge

        state, meta = validate_and_consume_challenge(
            token=token,
            stored_user_id="user-01",
            stored_phrase="seven blue dogs",
            current_state=ChallengeState.CAPTURE_RECEIVED,
            expires_at_ts=exp_ts,
            secret_key=_SECRET,
        )
        assert state is ChallengeState.CONSUMED
        assert meta["user_id"] == "user-01"

    def test_pure_state_machine_cross_user_rejected(self):
        from app.security.challenge_lifecycle import validate_and_consume_challenge

        token, exp_ts = _helper_token("user-01", "seven blue dogs")
        with pytest.raises(ChallengeLifecycleError) as err:
            validate_and_consume_challenge(
                token=token,
                stored_user_id="user-01",
                stored_phrase="seven blue dogs",
                current_state=ChallengeState.CAPTURE_RECEIVED,
                expires_at_ts=exp_ts,
                presented_user_id="user-02",
            )
        assert err.value.code == ChallengeLifecycleCode.TOKEN_USER_MISMATCH.value

    def test_pure_state_machine_expired_rejected(self):
        from app.security.challenge_lifecycle import validate_and_consume_challenge

        token, exp_ts = _helper_token("user-01", "seven blue dogs", ttl=-5)
        with pytest.raises(ChallengeLifecycleError) as err:
            validate_and_consume_challenge(
                token=token,
                stored_user_id="user-01",
                stored_phrase="seven blue dogs",
                current_state=ChallengeState.CAPTURE_RECEIVED,
                expires_at_ts=exp_ts,
            )
        assert err.value.code == ChallengeLifecycleCode.TOKEN_EXPIRED.value


# Helpers for the pure (DB-free) state-machine tests -------------------------

_SECRET = b"test-challenge-signing-secret-key-32ch!"


def _helper_token(user_id: str, phrase: str, ttl: int = 90):
    from app.security.challenge_lifecycle import generate_challenge_token

    return generate_challenge_token(user_id, phrase, _SECRET, ttl_seconds=ttl)
