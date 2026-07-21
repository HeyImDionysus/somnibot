-- Fix: dashboard RBAC role assignment was impossible for every guild.
--
-- History: 20260518000001_missing_tables.sql created dashboard_user_roles with
-- `user_id UUID NOT NULL REFERENCES users(id)` and `UNIQUE(guild_id,user_id,role_id)`.
-- Later migrations meant to move it to a Discord-id key: 20260518200000 added
-- `assigned_by UUID` + nullable `discord_id TEXT`, and 20260520000001 intended
-- `assigned_by TEXT` but its `ADD COLUMN IF NOT EXISTS` was a no-op (the UUID
-- column already existed). Neither dropped `user_id NOT NULL` nor the old unique
-- key. So the live shape is: user_id UUID NOT NULL, assigned_by UUID,
-- discord_id TEXT NULL, UNIQUE(guild_id,user_id,role_id).
--
-- The production route packages/dashboard/src/app/api/rbac/users/route.ts inserts
-- { guild_id, discord_id, role_id, assigned_by: <discord snowflake> } with NO
-- user_id. That fails NOT NULL on user_id (23502), and writes a snowflake string
-- into the uuid assigned_by column (22P02). Result: EVERY role-assignment POST
-- errors and no team member can ever be granted a dashboard role.
--
-- This migration completes the intended Discord-id keying:
--   1. user_id becomes optional (the production path never sets it).
--   2. discord_id is backfilled from user_id and made NOT NULL (the real key).
--   3. assigned_by becomes TEXT (it holds a Discord snowflake, not a users.id).
--   4. A discord_id-based unique key restores replay-safe dedup (the old
--      user_id key no longer dedupes once user_id is nullable).

-- 1. Production never supplies user_id.
ALTER TABLE public.dashboard_user_roles ALTER COLUMN user_id DROP NOT NULL;

-- 2. Backfill discord_id for any legacy rows, then require it.
UPDATE public.dashboard_user_roles
  SET discord_id = user_id::text
  WHERE discord_id IS NULL AND user_id IS NOT NULL;
ALTER TABLE public.dashboard_user_roles ALTER COLUMN discord_id SET NOT NULL;

-- 3. assigned_by holds ctx.discordId (a Discord snowflake), not a users.id uuid.
--    No FK references assigned_by, so a plain type change is safe. Harmless
--    no-op if a prior run already made it TEXT.
ALTER TABLE public.dashboard_user_roles
  ALTER COLUMN assigned_by TYPE TEXT USING assigned_by::text;

-- 4. Discord-id dedup fence (idempotent add).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.dashboard_user_roles'::regclass
      AND conname = 'dashboard_user_roles_guild_discord_role_key'
  ) THEN
    ALTER TABLE public.dashboard_user_roles
      ADD CONSTRAINT dashboard_user_roles_guild_discord_role_key
      UNIQUE (guild_id, discord_id, role_id);
  END IF;
END $$;
