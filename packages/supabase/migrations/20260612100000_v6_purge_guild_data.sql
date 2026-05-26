-- ============================================================
-- V6 Audit: Auth & Anti-Raid — purge_guild_data RPC
-- ============================================================
-- Provides a single admin-only RPC to wipe all data for a guild.
-- Used when a guild owner runs "delete my server data" from the dashboard.
-- SECURITY DEFINER with search_path locked.
-- ============================================================

CREATE OR REPLACE FUNCTION public.purge_guild_data(p_guild_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Economy tables
  DELETE FROM public.economy_wallets       WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_transactions  WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_profiles      WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_inventory     WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_items         WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_streaks       WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_pets          WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_prestige      WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_crops         WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_farm_plots    WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_recipes       WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_role_income   WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_quest_progress WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_quest_templates WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_loot_tables   WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_achievement_defs WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_user_achievements WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_heists        WHERE guild_id = p_guild_id;
  DELETE FROM public.economy_pet_battles   WHERE guild_id = p_guild_id;

  -- Moderation & admin
  DELETE FROM public.infractions           WHERE guild_id = p_guild_id;
  DELETE FROM public.admin_changes         WHERE guild_id = p_guild_id;
  DELETE FROM public.incidents             WHERE guild_id = p_guild_id;

  -- Configuration
  DELETE FROM public.guild_config          WHERE guild_id = p_guild_id;
  DELETE FROM public.guild_desired_state   WHERE guild_id = p_guild_id;
  DELETE FROM public.role_templates        WHERE guild_id = p_guild_id;
  DELETE FROM public.channel_templates     WHERE guild_id = p_guild_id;
  DELETE FROM public.server_templates      WHERE guild_id = p_guild_id;
  DELETE FROM public.automod_rules         WHERE guild_id = p_guild_id;
  DELETE FROM public.reaction_roles        WHERE guild_id = p_guild_id;
  DELETE FROM public.ticket_panels         WHERE guild_id = p_guild_id;
  DELETE FROM public.automations           WHERE guild_id = p_guild_id;
  DELETE FROM public.custom_commands       WHERE guild_id = p_guild_id;

  -- Commerce
  DELETE FROM public.portal_sessions       WHERE guild_id = p_guild_id;
  DELETE FROM public.dashboard_roles       WHERE guild_id = p_guild_id;
  DELETE FROM public.dashboard_user_roles  WHERE guild_id = p_guild_id;

  -- Members
  DELETE FROM public.members               WHERE guild_id = p_guild_id;

  -- Guild row itself
  DELETE FROM public.guild                 WHERE guild_id = p_guild_id;
END;
$$;

-- Only callable by service_role
REVOKE ALL ON FUNCTION public.purge_guild_data(text) FROM anon, authenticated, public;
