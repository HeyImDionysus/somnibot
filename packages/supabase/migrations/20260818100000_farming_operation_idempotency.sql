BEGIN;

CREATE TABLE IF NOT EXISTS public.economy_farming_operations (
  guild_id TEXT NOT NULL REFERENCES public.guild(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN ('plant', 'water', 'fertilize')),
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (guild_id, user_id, operation_id, operation_type)
);

CREATE INDEX IF NOT EXISTS idx_economy_farming_operations_created
  ON public.economy_farming_operations (created_at);

ALTER TABLE public.economy_farming_operations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.economy_farming_operations;
CREATE POLICY service_role_all ON public.economy_farming_operations
  FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE public.economy_farming_operations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.economy_farming_operations TO service_role;

CREATE OR REPLACE FUNCTION public.economy_farming_operation_atomic(
  p_guild_id TEXT,
  p_user_id TEXT,
  p_operation_id TEXT,
  p_operation_type TEXT,
  p_crop_id UUID DEFAULT NULL,
  p_item_id UUID DEFAULT NULL,
  p_plot_index INT DEFAULT NULL,
  p_grid_size INT DEFAULT 9,
  p_wilt_enabled BOOLEAN DEFAULT true,
  p_fertilizer_reduction_pct INT DEFAULT 50,
  p_fail_before_plot BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result JSONB;
  v_plot public.economy_farm_plots%ROWTYPE;
  v_empty_index INT;
  v_quantity INT;
  v_inventory_item_id UUID;
  v_affected JSONB;
  v_action TEXT;
BEGIN
  IF p_guild_id IS NULL OR pg_catalog.btrim(p_guild_id) = '' THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: p_guild_id is required';
  END IF;
  IF p_user_id IS NULL OR pg_catalog.btrim(p_user_id) = '' THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: p_user_id is required';
  END IF;
  IF p_operation_id IS NULL OR pg_catalog.btrim(p_operation_id) = '' THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: p_operation_id is required';
  END IF;
  IF p_operation_type NOT IN ('plant', 'water', 'fertilize') THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: invalid operation type';
  END IF;
  IF p_grid_size < 1 OR p_grid_size > 25 THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: p_grid_size must be between 1 and 25';
  END IF;
  IF p_fertilizer_reduction_pct < 0 OR p_fertilizer_reduction_pct > 100 THEN
    RAISE EXCEPTION 'economy_farming_operation_atomic: invalid fertilizer reduction';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('economy-farming:' || p_guild_id || ':' || p_user_id, 0)
  );

  SELECT result INTO v_result
    FROM public.economy_farming_operations
   WHERE guild_id = p_guild_id
     AND user_id = p_user_id
     AND operation_id = p_operation_id
     AND operation_type = p_operation_type
   FOR UPDATE;
  IF FOUND THEN
    RETURN v_result || pg_catalog.jsonb_build_object('replayed', true);
  END IF;

  IF p_operation_type = 'plant' THEN
    IF p_crop_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.economy_crops
       WHERE id = p_crop_id AND guild_id = p_guild_id AND active = true
    ) THEN
      v_result := pg_catalog.jsonb_build_object(
        'status', 'crop_unavailable', 'applied', false, 'replayed', false
      );
    ELSE
      SELECT slot.plot_index INTO v_empty_index
        FROM pg_catalog.generate_series(0, p_grid_size - 1) AS slot(plot_index)
        LEFT JOIN public.economy_farm_plots AS plot
          ON plot.guild_id = p_guild_id
         AND plot.user_id = p_user_id
         AND plot.plot_index = slot.plot_index
        LEFT JOIN public.economy_crops AS planted_crop ON planted_crop.id = plot.crop_id
       WHERE plot.id IS NULL
          OR plot.crop_id IS NULL
          OR plot.harvested = true
          OR (
            p_wilt_enabled
            AND plot.watered_at IS NOT NULL
            AND plot.planted_at IS NOT NULL
            AND planted_crop.id IS NOT NULL
            AND plot.planted_at
              + pg_catalog.make_interval(secs => pg_catalog.round(
                  planted_crop.grow_seconds
                  * (1 - CASE WHEN plot.fertilized THEN p_fertilizer_reduction_pct ELSE 0 END / 100.0)
                )::INT)
              + pg_catalog.make_interval(secs => planted_crop.wilt_seconds)
              < pg_catalog.now()
          )
       ORDER BY slot.plot_index
       LIMIT 1;

      IF v_empty_index IS NULL THEN
        v_result := pg_catalog.jsonb_build_object(
          'status', 'farm_full', 'applied', false, 'replayed', false
        );
      ELSE
        IF p_item_id IS NOT NULL THEN
          SELECT quantity INTO v_quantity
            FROM public.economy_inventory
           WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id
           FOR UPDATE;
          IF COALESCE(v_quantity, 0) < 1 THEN
            v_result := pg_catalog.jsonb_build_object(
              'status', 'missing_inventory', 'applied', false, 'replayed', false,
              'plot_index', v_empty_index
            );
          ELSE
            IF v_quantity = 1 THEN
              DELETE FROM public.economy_inventory
               WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
            ELSE
              UPDATE public.economy_inventory
                 SET quantity = quantity - 1, updated_at = pg_catalog.now()
               WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = p_item_id;
            END IF;
          END IF;
        END IF;

        IF v_result IS NULL THEN
          IF p_fail_before_plot THEN
            RAISE EXCEPTION 'farming operation fault before plot mutation';
          END IF;
          INSERT INTO public.economy_farm_plots (
            guild_id, user_id, plot_index, crop_id, planted_at,
            watered_at, fertilized, harvested
          ) VALUES (
            p_guild_id, p_user_id, v_empty_index, p_crop_id, pg_catalog.now(),
            NULL, false, false
          )
          ON CONFLICT (guild_id, user_id, plot_index) DO UPDATE SET
            crop_id = EXCLUDED.crop_id,
            planted_at = EXCLUDED.planted_at,
            watered_at = NULL,
            fertilized = false,
            harvested = false;
          v_result := pg_catalog.jsonb_build_object(
            'status', 'planted', 'applied', true, 'replayed', false,
            'plot_index', v_empty_index, 'crop_id', p_crop_id
          );
        END IF;
      END IF;
    END IF;
  ELSIF p_operation_type = 'water' THEN
    WITH updated AS (
      UPDATE public.economy_farm_plots
         SET watered_at = pg_catalog.now()
       WHERE guild_id = p_guild_id
         AND user_id = p_user_id
         AND crop_id IS NOT NULL
         AND harvested = false
         AND watered_at IS NULL
       RETURNING plot_index
    )
    SELECT COALESCE(pg_catalog.jsonb_agg(plot_index ORDER BY plot_index), '[]'::JSONB)
      INTO v_affected FROM updated;

    IF pg_catalog.jsonb_array_length(v_affected) > 0 THEN
      v_result := pg_catalog.jsonb_build_object(
        'status', 'watered', 'applied', true, 'replayed', false,
        'affected_plot_indexes', v_affected,
        'affected_count', pg_catalog.jsonb_array_length(v_affected)
      );
    ELSIF EXISTS (
      SELECT 1 FROM public.economy_farm_plots
       WHERE guild_id = p_guild_id AND user_id = p_user_id
         AND crop_id IS NOT NULL AND harvested = false
    ) THEN
      v_result := pg_catalog.jsonb_build_object(
        'status', 'already_watered', 'applied', false, 'replayed', false,
        'affected_plot_indexes', '[]'::JSONB, 'affected_count', 0
      );
    ELSE
      v_result := pg_catalog.jsonb_build_object(
        'status', 'no_crops', 'applied', false, 'replayed', false,
        'affected_plot_indexes', '[]'::JSONB, 'affected_count', 0
      );
    END IF;
  ELSE
    IF p_plot_index IS NULL OR p_plot_index < 0 OR p_plot_index >= p_grid_size THEN
      v_result := pg_catalog.jsonb_build_object(
        'status', 'invalid_plot', 'applied', false, 'replayed', false
      );
    ELSE
      SELECT * INTO v_plot FROM public.economy_farm_plots
       WHERE guild_id = p_guild_id AND user_id = p_user_id AND plot_index = p_plot_index
       FOR UPDATE;
      IF NOT FOUND OR v_plot.crop_id IS NULL OR v_plot.harvested THEN
        v_result := pg_catalog.jsonb_build_object(
          'status', 'empty_plot', 'applied', false, 'replayed', false,
          'plot_index', p_plot_index
        );
      ELSIF v_plot.fertilized THEN
        v_result := pg_catalog.jsonb_build_object(
          'status', 'already_fertilized', 'applied', false, 'replayed', false,
          'plot_index', p_plot_index
        );
      ELSE
        SELECT inventory.item_id, inventory.quantity
          INTO v_inventory_item_id, v_quantity
          FROM public.economy_inventory AS inventory
          JOIN public.economy_items AS item ON item.id = inventory.item_id
         WHERE inventory.guild_id = p_guild_id
           AND inventory.user_id = p_user_id
           AND inventory.quantity > 0
           AND item.guild_id = p_guild_id
           AND item.active = true
           AND pg_catalog.lower(item.name) = 'fertilizer'
           AND (p_item_id IS NULL OR inventory.item_id = p_item_id)
         ORDER BY inventory.acquired_at, inventory.item_id
         LIMIT 1
         FOR UPDATE OF inventory;
        IF COALESCE(v_quantity, 0) < 1 THEN
          v_result := pg_catalog.jsonb_build_object(
            'status', 'missing_inventory', 'applied', false, 'replayed', false,
            'plot_index', p_plot_index
          );
        ELSE
          IF v_quantity = 1 THEN
            DELETE FROM public.economy_inventory
             WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = v_inventory_item_id;
          ELSE
            UPDATE public.economy_inventory
               SET quantity = quantity - 1, updated_at = pg_catalog.now()
             WHERE guild_id = p_guild_id AND user_id = p_user_id AND item_id = v_inventory_item_id;
          END IF;
          IF p_fail_before_plot THEN
            RAISE EXCEPTION 'farming operation fault before plot mutation';
          END IF;
          UPDATE public.economy_farm_plots SET fertilized = true WHERE id = v_plot.id;
          v_result := pg_catalog.jsonb_build_object(
            'status', 'fertilized', 'applied', true, 'replayed', false,
            'plot_index', p_plot_index
          );
        END IF;
      END IF;
    END IF;
  END IF;

  v_action := 'farming.' || p_operation_type;
  v_result := v_result || pg_catalog.jsonb_build_object('audit_action', v_action);

  INSERT INTO public.economy_farming_operations (
    guild_id, user_id, operation_id, operation_type, result
  ) VALUES (p_guild_id, p_user_id, p_operation_id, p_operation_type, v_result);

  INSERT INTO public.audit_logs (
    guild_id, actor_type, actor_id, action, category, target_type, target_id,
    details, correlation_id, occurrence_key, success, error_message
  ) VALUES (
    p_guild_id, 'user', p_user_id, v_action, 'economy', 'member', p_user_id,
    v_result, p_operation_id, v_action || ':' || p_operation_id,
    COALESCE((v_result ->> 'applied')::BOOLEAN, false),
    CASE WHEN COALESCE((v_result ->> 'applied')::BOOLEAN, false)
      THEN NULL ELSE v_result ->> 'status' END
  ) ON CONFLICT (guild_id, occurrence_key) DO NOTHING;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.economy_farming_operation_atomic(
  TEXT, TEXT, TEXT, TEXT, UUID, UUID, INT, INT, BOOLEAN, INT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.economy_farming_operation_atomic(
  TEXT, TEXT, TEXT, TEXT, UUID, UUID, INT, INT, BOOLEAN, INT, BOOLEAN
) TO service_role;

COMMIT;
