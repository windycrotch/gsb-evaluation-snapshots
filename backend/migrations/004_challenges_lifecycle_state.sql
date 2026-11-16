-- Migration 004: Add Challenge Lifecycle State Columns
-- Status: PENDING
-- Date: 2026-11-17
--
-- Adds explicit lifecycle state tracking to the challenges table so that
-- consumed/expired challenges can never be re-activated and illegal state
-- transitions can be rejected (see app/security/challenge_lifecycle.py).
--
--   state       : CREATED | AUTHORIZED | CAPTURE_RECEIVED | CONSUMED |
--                 COMPLETED | EXPIRED | TERMINATED
--   consumed_at : timestamp the token was atomically consumed
--
-- Both columns are nullable and backfilled, preserving existing rows.

ALTER TABLE challenges ADD COLUMN IF NOT EXISTS state VARCHAR(20) DEFAULT 'CREATED';
ALTER TABLE challenges ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMP;

-- Backfill: rows already marked used are CONSUMED; the rest stay CREATED.
UPDATE challenges
SET state = 'CONSUMED'
WHERE used = true AND (state IS NULL OR state = 'CREATED');

UPDATE challenges
SET state = 'CREATED'
WHERE state IS NULL;

CREATE INDEX IF NOT EXISTS ix_challenges_state ON challenges(state);

-- Verification query:
-- SELECT state, COUNT(*) FROM challenges GROUP BY state;
