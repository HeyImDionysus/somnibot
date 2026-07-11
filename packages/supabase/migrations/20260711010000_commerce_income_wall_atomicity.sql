-- Keep a role that earns wagerable currency off every live purchase path.
--
-- The application still performs friendly preflight checks, but this migration
-- is the authoritative race-safe wall. Every relevant write takes a
-- transaction-scoped guild lock before changing data. Deferred constraint
-- triggers then validate the committed shape, so a waiter validates against a
-- fresh READ COMMITTED snapshot after the transaction ahead of it commits.

-- Deployment fence: acquire write-blocking/read-compatible table locks in the
-- documented dependency order products -> plans -> economy_role_income before
-- inspecting legacy state. SHARE ROW EXCLUSIVE conflicts with ordinary writer
-- ROW EXCLUSIVE locks, and PostgreSQL holds these locks until this migration
-- transaction commits, covering dirty-state validation, constraints, and all
-- trigger installation below. Reads remain available; writes to these three
-- commerce configuration tables wait for the migration to finish.
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.plans IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.economy_role_income IN SHARE ROW EXCLUSIVE MODE;

CREATE INDEX IF NOT EXISTS idx_plans_commerce_checkout_selection
  ON public.plans (guild_id, product_id, price_cents ASC, id ASC)
  WHERE active IS TRUE
    AND paypal_plan_id IS NOT NULL
    AND pg_catalog.btrim(paypal_plan_id) <> '';

CREATE OR REPLACE FUNCTION public.commerce_select_checkout_plan(
  p_guild_id text,
  p_product_id uuid
)
RETURNS SETOF public.plans
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT candidate.*
  FROM public.plans AS candidate
  INNER JOIN public.products AS parent
    ON parent.id = candidate.product_id
   AND parent.guild_id = candidate.guild_id
  WHERE candidate.guild_id = p_guild_id
    AND candidate.product_id = p_product_id
    AND candidate.active IS TRUE
    AND candidate.paypal_plan_id IS NOT NULL
    AND pg_catalog.btrim(candidate.paypal_plan_id) <> ''
    AND parent.guild_id = p_guild_id
    AND parent.active IS TRUE
    AND parent.type = 'subscription'
  ORDER BY candidate.price_cents ASC, candidate.id ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.commerce_select_checkout_plan(text, uuid) IS
  'Returns the one checkout-eligible subscription plan selected by (price_cents ASC, id ASC).';

CREATE OR REPLACE FUNCTION public.commerce_income_wall_lock_guild(
  p_guild_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = '' THEN
    RETURN;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'somnibot:commerce-income-wall:' || p_guild_id,
      0
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_assert_income_wall_guild(
  p_guild_id text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_product_id uuid;
  v_role_id text;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id = '' THEN
    RETURN;
  END IF;

  PERFORM public.commerce_income_wall_lock_guild(p_guild_id);

  SELECT product.id, income.role_id
    INTO v_product_id, v_role_id
  FROM public.products AS product
  INNER JOIN public.economy_role_income AS income
    ON income.guild_id = product.guild_id
   AND income.amount > 0
   AND income.role_id = ANY(
     COALESCE(product.granted_role_ids, '{}'::text[])
   )
  WHERE product.guild_id = p_guild_id
    AND product.active IS TRUE
    AND (
      (product.type = 'one_time' AND product.price_cents > 0)
      OR
      (
        product.type = 'subscription'
        AND EXISTS (
          SELECT 1
          FROM public.commerce_select_checkout_plan(
            p_guild_id,
            product.id
          )
        )
      )
    )
  ORDER BY product.id ASC, income.role_id ASC
  LIMIT 1;

  IF v_product_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'COMMERCE_INCOME_WALL_CONFLICT: guild=' || p_guild_id
        || ' product=' || v_product_id::text
        || ' role=' || v_role_id,
      DETAIL = 'An active real-money purchase path grants a role that also earns wagerable currency.',
      HINT = 'Remove the role-income row or close the purchase path before retrying.';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_income_wall_lock_row()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_guild_id text;
  v_new_guild_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_guild_id := OLD.guild_id;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_guild_id := NEW.guild_id;
  END IF;

  -- A cross-guild update always locks in lexical order, preventing a pair of
  -- opposing moves from deadlocking each other.
  IF v_old_guild_id IS NOT NULL
     AND v_new_guild_id IS NOT NULL
     AND v_old_guild_id <> v_new_guild_id THEN
    IF v_old_guild_id < v_new_guild_id THEN
      PERFORM public.commerce_income_wall_lock_guild(v_old_guild_id);
      PERFORM public.commerce_income_wall_lock_guild(v_new_guild_id);
    ELSE
      PERFORM public.commerce_income_wall_lock_guild(v_new_guild_id);
      PERFORM public.commerce_income_wall_lock_guild(v_old_guild_id);
    END IF;
  ELSE
    PERFORM public.commerce_income_wall_lock_guild(
      COALESCE(v_new_guild_id, v_old_guild_id)
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.commerce_income_wall_validate_row()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_old_guild_id text;
  v_new_guild_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_old_guild_id := OLD.guild_id;
  END IF;

  IF TG_OP <> 'DELETE' THEN
    v_new_guild_id := NEW.guild_id;
  END IF;

  -- A guild-wide assertion examines every product and every eligible plan, so
  -- a plan move validates both its OLD and NEW parent even when both parents
  -- live in the same guild.
  IF v_old_guild_id IS NOT NULL
     AND v_new_guild_id IS NOT NULL
     AND v_old_guild_id <> v_new_guild_id THEN
    IF v_old_guild_id < v_new_guild_id THEN
      PERFORM public.commerce_assert_income_wall_guild(v_old_guild_id);
      PERFORM public.commerce_assert_income_wall_guild(v_new_guild_id);
    ELSE
      PERFORM public.commerce_assert_income_wall_guild(v_new_guild_id);
      PERFORM public.commerce_assert_income_wall_guild(v_old_guild_id);
    END IF;
  ELSE
    PERFORM public.commerce_assert_income_wall_guild(
      COALESCE(v_new_guild_id, v_old_guild_id)
    );
  END IF;

  RETURN NULL;
END;
$$;

-- Existing non-positive rows are not silently normalized. A dirty deployment
-- fails before the constraint is installed so operators can repair the source
-- data deliberately.
DO $$
DECLARE
  v_bad_guild_id text;
  v_bad_role_id text;
  v_bad_amount bigint;
BEGIN
  SELECT income.guild_id, income.role_id, income.amount
    INTO v_bad_guild_id, v_bad_role_id, v_bad_amount
  FROM public.economy_role_income AS income
  WHERE income.amount <= 0
  ORDER BY income.guild_id ASC, income.role_id ASC
  LIMIT 1;

  IF v_bad_guild_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'economy_role_income_amount_positive migration check failed',
      DETAIL = 'guild=' || v_bad_guild_id
        || ' role=' || v_bad_role_id
        || ' amount=' || v_bad_amount::text;
  END IF;
END;
$$;

ALTER TABLE public.economy_role_income
  ADD CONSTRAINT economy_role_income_amount_positive
  CHECK (amount > 0);

-- Fail the migration when live data already violates the wall. This uses the
-- same SQLSTATE and stable marker that runtime trigger conflicts expose.
DO $$
DECLARE
  v_guild_id text;
BEGIN
  FOR v_guild_id IN
    SELECT guild.guild_id
    FROM (
      SELECT product.guild_id
      FROM public.products AS product
      UNION
      SELECT plan.guild_id
      FROM public.plans AS plan
      UNION
      SELECT income.guild_id
      FROM public.economy_role_income AS income
    ) AS guild
    WHERE guild.guild_id IS NOT NULL
    ORDER BY guild.guild_id ASC
  LOOP
    PERFORM public.commerce_assert_income_wall_guild(v_guild_id);
  END LOOP;
END;
$$;

CREATE TRIGGER commerce_income_wall_products_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_lock_row();

CREATE CONSTRAINT TRIGGER commerce_income_wall_products_validate
  AFTER INSERT OR UPDATE OR DELETE ON public.products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_validate_row();

CREATE TRIGGER commerce_income_wall_plans_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.plans
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_lock_row();

CREATE CONSTRAINT TRIGGER commerce_income_wall_plans_validate
  AFTER INSERT OR UPDATE OR DELETE ON public.plans
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_validate_row();

CREATE TRIGGER commerce_income_wall_role_income_lock
  BEFORE INSERT OR UPDATE OR DELETE ON public.economy_role_income
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_lock_row();

CREATE CONSTRAINT TRIGGER commerce_income_wall_role_income_validate
  AFTER INSERT OR UPDATE OR DELETE ON public.economy_role_income
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commerce_income_wall_validate_row();

-- Supabase grants EXECUTE to PUBLIC for new functions by default. The checkout
-- selector is deliberately service-role-only, and trigger internals are not an
-- application RPC surface at all.
REVOKE ALL ON FUNCTION public.commerce_select_checkout_plan(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_select_checkout_plan(text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.commerce_select_checkout_plan(text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commerce_select_checkout_plan(text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_guild(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_guild(text) FROM anon;
REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_guild(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.commerce_assert_income_wall_guild(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_assert_income_wall_guild(text) FROM anon;
REVOKE ALL ON FUNCTION public.commerce_assert_income_wall_guild(text) FROM authenticated;
REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_row() FROM anon;
REVOKE ALL ON FUNCTION public.commerce_income_wall_lock_row() FROM authenticated;
REVOKE ALL ON FUNCTION public.commerce_income_wall_validate_row() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commerce_income_wall_validate_row() FROM anon;
REVOKE ALL ON FUNCTION public.commerce_income_wall_validate_row() FROM authenticated;
