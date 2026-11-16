# Challenge Token Lifecycle — Security Hardening

**Date:** 2026-11-17
**Scope:** `app/security/challenge_lifecycle.py`, `app/layer3_adaptive.py`,
`app/api/v1/verify.py`, `app/api/v1/capture.py`, `app/main.py`

## Threat model

After a challenge is issued, the capture grant / challenge token is the only
thing proving that a verification upload belongs to the user who requested the
challenge. If any of the following are silently allowed, an attacker who records
one successful authentication can impersonate the user forever:

1. **Replay** — the same token submitted twice.
2. **Late submission** — a token submitted after its 90 s TTL.
3. **Cross-user reuse** — user A's token presented in user B's verification.

## Guarantees added

| Property | Enforcement point |
|---|---|
| Single use | `consume_challenge_token` — conditional `UPDATE ... WHERE used = false AND expires_at > :now` |
| TTL | Signed expiry claim + DB `expires_at`; checked before any model inference |
| User binding | `expected_user_id` compared against `challenges.user_id` inside the pre-check **and** the atomic UPDATE |
| State machine | `challenge_state()` / `transition_challenge()`; terminal states can never return to a pending state |

### Rejection codes

All rejections carry a stable `ChallengeLifecycleCode` that is safe to assert on:

| Code | Meaning | Public reason |
|---|---|---|
| `TOKEN_ALREADY_USED` | replay of a consumed token | `REPLAY_DETECTED` |
| `TOKEN_EXPIRED` | past TTL (DB row or signed claim) | `CHALLENGE_EXPIRED` |
| `TOKEN_USER_MISMATCH` | token belongs to another user | `CHALLENGE_INVALID` |
| `TOKEN_NOT_FOUND` | unknown/empty token | `CHALLENGE_INVALID` |
| `MALFORMED_TOKEN_STRUCTURE` | not `nonce.exp.sig` | `CHALLENGE_INVALID` |
| `INVALID_TOKEN_EXPIRATION` | non-numeric expiry segment | `CHALLENGE_INVALID` |
| `INVALID_TOKEN_SIGNATURE` | HMAC over presented payload fails | `CHALLENGE_INVALID` |
| `CHALLENGE_TERMINATED` | challenge terminated | `CHALLENGE_INVALID` |
| `INVALID_CHALLENGE_STATE` | unknown persisted state | `CHALLENGE_INVALID` |
| `INVALID_STATE_TRANSITION` | illegal state machine transition | `CHALLENGE_INVALID` |

Rejection precedence is deliberate: **terminal state → ownership → expiry →
transition legality → structure → signature**. A replay therefore always reports
`TOKEN_ALREADY_USED`, even if the token's TTL has also elapsed by the second
submission.

### API surface

`POST /v1/verify` returns HTTP 200 with:

```json
{
  "decision": "DENY",
  "error_code": "TOKEN_ALREADY_USED",
  "reason_public": "REPLAY_DETECTED",
  "requires_fresh_challenge": true
}
```

`POST /v1/capture/grants` returns `409 CHALLENGE_CONSUMED` / `409 CHALLENGE_TERMINATED`
or `400 CHALLENGE_EXPIRED` and never re-activates a consumed/expired challenge.

The legacy `POST /auth/verify` response now also includes `error_code` and
`reason_public`.

### Timezone correctness

`generate_challenge` previously derived the signed expiry with
`datetime.utcnow().timestamp()`, which interprets a naive datetime in **local**
time. On a non-UTC host that shifted the embedded expiry by the UTC offset
(−8 h on the test machine), making fresh 90-second tokens look long expired.
The expiry now comes from a true epoch value (`epoch_seconds()`), and the
timezone-independence test asserts a ~90 s round trip.

### Migrations

`004_challenges_lifecycle_state.sql` adds `state` and `consumed_at`. The consume
path degrades gracefully to a `used`-only update on a database that has not yet
run the migration, but the state-machine guards still apply in-process.

## Tests

* `tests/test_challenge_token_security.py` — 38 DB-level tests (single use,
  replay vs. unknown vs. expiry distinction, clock-skew expiry, cross-user,
  tampered signature, state machine).
* `tests/test_challenge_api_security.py` — 16 HTTP tests through `/v1/verify`,
  `/v1/capture/grants` and `/auth/verify` with mocked model layers.

All challenges/tokens are constructed locally; no model inference or external
service is used.
