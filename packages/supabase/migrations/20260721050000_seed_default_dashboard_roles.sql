-- Seed the five contracted system dashboard roles for every guild.
--
-- The catalog contracts that each guild has five seeded system roles
-- (owner/admin/moderator/support/finance), but nothing created them: no guild
-- provisioning path inserted dashboard_roles rows, so administration-rbac's
-- systemRoles===5 promise was unmet and there were no roles to grant. Seed them
-- via an AFTER INSERT trigger on guild (fires however a guild row is created)
-- plus a one-time backfill. Definitions mirror shared/src/constants/rbac.ts
-- SYSTEM_ROLES. ON CONFLICT (guild_id, name) DO NOTHING keeps it idempotent.

CREATE OR REPLACE FUNCTION public.seed_default_dashboard_roles(p_guild_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.dashboard_roles (guild_id, name, description, permissions, is_system, priority)
  VALUES
    (p_guild_id, 'owner',
      'Full access to everything. Cannot be removed or reassigned.',
      '["dashboard.full_access"]'::jsonb, true, 100),
    (p_guild_id, 'admin',
      'Full access except team management and critical system settings.',
      '["dashboard.view_analytics","dashboard.manage_store","dashboard.manage_products","dashboard.manage_orders","dashboard.manage_customers","dashboard.manage_licenses","dashboard.manage_moderation","dashboard.manage_tickets","dashboard.manage_automations","dashboard.manage_server","dashboard.manage_roles","dashboard.manage_channels","dashboard.view_audit","dashboard.view_diagnostics","dashboard.manage_incidents","dashboard.view_fraud","dashboard.manage_fraud","dashboard.view_workflows","dashboard.manage_workflows","dashboard.undo_changes","dashboard.manage_economy"]'::jsonb, true, 80),
    (p_guild_id, 'moderator',
      'Manage moderation, tickets, and view member data.',
      '["dashboard.manage_moderation","dashboard.manage_tickets","dashboard.view_audit","dashboard.view_diagnostics","dashboard.manage_incidents"]'::jsonb, true, 40),
    (p_guild_id, 'support',
      'View customers, manage tickets, handle support operations.',
      '["dashboard.manage_tickets","dashboard.manage_customers","dashboard.manage_licenses","dashboard.view_audit","dashboard.view_fraud"]'::jsonb, true, 30),
    (p_guild_id, 'finance',
      'Manage store, orders, promotions, and view analytics.',
      '["dashboard.view_analytics","dashboard.manage_store","dashboard.manage_products","dashboard.manage_orders","dashboard.manage_customers","dashboard.view_audit","dashboard.view_fraud"]'::jsonb, true, 30)
  ON CONFLICT (guild_id, name) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_seed_dashboard_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.seed_default_dashboard_roles(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS seed_dashboard_roles_after_guild_insert ON public.guild;
CREATE TRIGGER seed_dashboard_roles_after_guild_insert
  AFTER INSERT ON public.guild
  FOR EACH ROW EXECUTE FUNCTION public.trg_seed_dashboard_roles();

-- One-time backfill for guilds that already exist.
DO $$
DECLARE g record;
BEGIN
  FOR g IN SELECT id FROM public.guild LOOP
    PERFORM public.seed_default_dashboard_roles(g.id);
  END LOOP;
END $$;
