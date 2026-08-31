BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.commerce_stamp_product_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  NEW.updated_at := GREATEST(pg_catalog.clock_timestamp(), OLD.updated_at + interval '1 microsecond');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_stamp_product_revision()
  FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS update_products_updated_at ON public.products;
CREATE TRIGGER update_products_updated_at BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.commerce_stamp_product_revision();

CREATE OR REPLACE FUNCTION public.commerce_touch_product_contract_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_old_product_id uuid;
  v_new_product_id uuid;
  v_guild_id text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (pg_catalog.to_jsonb(NEW) - ARRAY['download_count', 'updated_at'])
       IS NOT DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['download_count', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN v_old_product_id := OLD.product_id; END IF;
  IF TG_OP <> 'DELETE' THEN v_new_product_id := NEW.product_id; END IF;
  -- Match the income-wall order before taking either parent row lock.
  FOR v_guild_id IN
    SELECT DISTINCT guild_id FROM public.products
     WHERE id IN (v_old_product_id, v_new_product_id) ORDER BY guild_id
  LOOP
    PERFORM public.commerce_income_wall_lock_guild(v_guild_id);
  END LOOP;
  PERFORM id FROM public.products
   WHERE id IN (v_old_product_id, v_new_product_id) ORDER BY id FOR UPDATE;
  UPDATE public.products SET updated_at = pg_catalog.clock_timestamp()
   WHERE id IN (v_old_product_id, v_new_product_id);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.commerce_touch_product_contract_revision()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER commerce_product_files_contract_revision
  AFTER INSERT OR UPDATE OR DELETE ON public.product_files
  FOR EACH ROW EXECUTE FUNCTION public.commerce_touch_product_contract_revision();
CREATE TRIGGER commerce_plans_contract_revision
  AFTER INSERT OR UPDATE OR DELETE ON public.plans
  FOR EACH ROW EXECUTE FUNCTION public.commerce_touch_product_contract_revision();

COMMIT;
