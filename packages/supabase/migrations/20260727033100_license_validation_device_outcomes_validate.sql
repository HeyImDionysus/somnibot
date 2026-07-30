-- Validate the widened forensic-ledger CHECK after the ADD ... NOT VALID
-- migration has committed. PostgreSQL uses the weaker validation lock for the
-- table scan; the old constraint remains active until validation succeeds.

ALTER TABLE public.license_validations
  VALIDATE CONSTRAINT license_validations_result_check_admin_device_v2;

ALTER TABLE public.license_validations
  DROP CONSTRAINT IF EXISTS license_validations_result_check;

ALTER TABLE public.license_validations
  RENAME CONSTRAINT license_validations_result_check_admin_device_v2
  TO license_validations_result_check;
