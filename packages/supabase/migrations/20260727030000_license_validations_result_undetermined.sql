-- =============================================================================
-- license_validations.result — record outcomes the ledger could not previously
-- express, including "we could not determine the licence status".
--
-- WHY
-- ---
-- 1. `POST /api/license/validate` now distinguishes a SERVICE FAULT from a
--    verdict: when the `license_validate_lookup` RPC fails we no longer answer
--    'revoked' (which told a paying customer their licence was cancelled
--    because the database blinked, and permanently stopped their SDK's
--    heartbeats). The forensic ledger needs a result value for that outcome, so
--    the outage is visible in the same place every other validation outcome is.
--
-- 2. Pre-existing hole: the route already logs the ENTITLEMENT status verbatim
--    (`logValidation(..., result.entitlement_status ?? 'revoked', ...)`).
--    `entitlements.status` allows 'cancelled', 'pending' and 'grace_period',
--    none of which were in this CHECK — so those inserts were rejected with
--    23514 and swallowed by logValidation's try/catch. Every rejection of a
--    cancelled or pending entitlement therefore left NO row in a ledger the
--    catalog contracts as a permanent record of "every validation attempt"
--    (see 20260724110000_license_validations_forensic_ledger.sql). Adding the
--    values closes that hole.
--
-- 3. 'rate_limited' is reserved for the same reason — a throttled caller is an
--    outcome, not a verdict.
--
-- 4. `session_invalidated` is the exact per-device verdict returned when an
--    administrator has revoked a fingerprint. It is deliberately distinct
--    from `revoked`, which describes the licence key itself.
--
-- EXISTING ROWS
-- -------------
-- This is a pure WIDENING of the allowed set: every value permitted before is
-- still permitted, so every existing row satisfies the new predicate by
-- construction. No backfill, no NOT VALID + VALIDATE dance, and no possibility
-- of the ADD CONSTRAINT failing on live data. The generated TS union in
-- packages/shared/src/types/database.generated.ts is kept in step through the
-- generator's TYPE_OVERRIDES table (the generator reads CHECKs from CREATE
-- TABLE only, which is exactly what that override table exists for).
-- =============================================================================
BEGIN;

ALTER TABLE public.license_validations
  DROP CONSTRAINT IF EXISTS license_validations_result_check;

ALTER TABLE public.license_validations
  ADD CONSTRAINT license_validations_result_check
  CHECK (result IN (
    -- original set
    'valid',
    'invalid_key',
    'expired',
    'suspended',
    'revoked',
    'over_device_limit',
    'product_mismatch',
    -- entitlement statuses the route already logs verbatim
    'cancelled',
    'pending',
    'grace_period',
    -- service faults: an outcome, NOT a verdict on the licence
    'unavailable',
    'rate_limited',
    -- terminal per-device verdict (the key itself may still be active)
    'session_invalidated'
  ));

COMMIT;
