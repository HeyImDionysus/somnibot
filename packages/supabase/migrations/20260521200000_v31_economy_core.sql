-- V31: Economy Core + Shop + Items
-- PR #42 — Foundation for the fake-economy engagement system.
-- This migration adds:
--   • ~20 guild_config columns for economy settings
--   • economy_wallets — per-member wallet + bank balances
--   • economy_transactions — full ledger of all currency moves
--   • economy_items — server-defined shop items (operator CRUD)
--   • economy_inventory — per-member item ownership
--   • economy_role_income — role → passive income mappings
--   • economy_streaks — daily/weekly/monthly claim streaks

-- ── guild_config additions ──────────────────────────────────

ALTER TABLE guild_config
  ADD COLUMN IF NOT EXISTS economy_enabled              boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS currency_name                text        NOT NULL DEFAULT 'Coins',
  ADD COLUMN IF NOT EXISTS currency_emoji               text        NOT NULL DEFAULT '🪙',
  ADD COLUMN IF NOT EXISTS economy_starting_balance     bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS economy_daily_amount         bigint      NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS economy_weekly_amount        bigint      NOT NULL DEFAULT 3500,
  ADD COLUMN IF NOT EXISTS economy_monthly_amount       bigint      NOT NULL DEFAULT 15000,
  ADD COLUMN IF NOT EXISTS economy_streak_bonus_pct     integer     NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS economy_work_cooldown_seconds integer    NOT NULL DEFAULT 1800,
  ADD COLUMN IF NOT EXISTS economy_work_min             bigint      NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS economy_work_max             bigint      NOT NULL DEFAULT 500,
  ADD COLUMN IF NOT EXISTS economy_crime_success_pct    integer     NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS economy_crime_fine_pct       integer     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS economy_crime_min            bigint      NOT NULL DEFAULT 200,
  ADD COLUMN IF NOT EXISTS economy_crime_max            bigint      NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS economy_chat_income_enabled  boolean     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS economy_chat_income_min      bigint      NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS economy_chat_income_max      bigint      NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS economy_chat_income_cooldown_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS economy_rob_enabled          boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_rob_success_pct      integer     NOT NULL DEFAULT 35,
  ADD COLUMN IF NOT EXISTS economy_rob_fine_pct         integer     NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS economy_heist_enabled        boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_passive_mode_allowed boolean     NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS economy_pay_tax_pct          integer     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS economy_max_wallet           bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS economy_max_bank             bigint      NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS economy_log_channel_id       text;

-- ── economy_wallets ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_wallets (
  guild_id   text    NOT NULL,
  user_id    text    NOT NULL,
  wallet     bigint  NOT NULL DEFAULT 0,
  bank       bigint  NOT NULL DEFAULT 0,
  bank_max   bigint  NOT NULL DEFAULT 10000,
  passive    boolean NOT NULL DEFAULT false,
  total_earned  bigint NOT NULL DEFAULT 0,
  total_spent   bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_wallets_guild
  ON economy_wallets (guild_id);

-- ── economy_transactions ────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_transactions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    text        NOT NULL,
  user_id     text        NOT NULL,
  type        text        NOT NULL,          -- 'daily','work','crime','rob','pay','shop_buy','chat_income', etc.
  amount      bigint      NOT NULL,          -- positive = credit, negative = debit
  balance_after bigint    NOT NULL DEFAULT 0,
  description text,
  metadata    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_economy_transactions_guild_user
  ON economy_transactions (guild_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_economy_transactions_guild_type
  ON economy_transactions (guild_id, type, created_at DESC);

-- ── economy_items ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_items (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    text    NOT NULL,
  name        text    NOT NULL,
  description text,
  emoji       text    NOT NULL DEFAULT '📦',
  category    text    NOT NULL DEFAULT 'Consumables',
  price       bigint  NOT NULL DEFAULT 0,
  sell_price  bigint  NOT NULL DEFAULT 0,     -- resale value (0 = not sellable)
  stock       integer,                        -- NULL = unlimited
  max_per_user integer,                       -- NULL = unlimited
  require_role_id text,                       -- must have this role to buy
  grant_role_id   text,                       -- buying grants this role
  usable      boolean NOT NULL DEFAULT false, -- can be /use'd
  use_effect  jsonb,                          -- effect when used (type-specific)
  durability  integer,                        -- NULL = infinite, >0 = uses
  tradeable   boolean NOT NULL DEFAULT true,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_economy_items_guild
  ON economy_items (guild_id, active, category);

-- ── economy_inventory ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_inventory (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    text    NOT NULL,
  user_id     text    NOT NULL,
  item_id     uuid    NOT NULL REFERENCES economy_items(id) ON DELETE CASCADE,
  quantity    integer NOT NULL DEFAULT 1,
  durability_remaining integer,               -- tracks remaining uses (NULL = infinite)
  acquired_at timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, user_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_inventory_guild_user
  ON economy_inventory (guild_id, user_id);

-- ── economy_role_income ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_role_income (
  id          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id    text    NOT NULL,
  role_id     text    NOT NULL,
  amount      bigint  NOT NULL DEFAULT 100,
  interval_minutes integer NOT NULL DEFAULT 60,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_economy_role_income_guild
  ON economy_role_income (guild_id);

-- ── economy_streaks ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS economy_streaks (
  guild_id    text    NOT NULL,
  user_id     text    NOT NULL,
  streak_type text    NOT NULL,               -- 'daily', 'weekly', 'monthly'
  current_streak integer NOT NULL DEFAULT 0,
  longest_streak integer NOT NULL DEFAULT 0,
  last_claimed_at timestamptz,
  next_claim_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id, streak_type)
);

-- ── Analytics perf fix: aggregate_member_levels RPC ──────

CREATE OR REPLACE FUNCTION aggregate_member_levels(p_guild_id text)
RETURNS json
LANGUAGE sql STABLE
AS $$
  SELECT json_build_object(
    'total_members',       count(*),
    'total_messages',      coalesce(sum(total_messages), 0),
    'total_voice_minutes', coalesce(sum(voice_minutes), 0),
    'max_level',           coalesce(max(level), 0),
    'avg_level',           round(coalesce(avg(level), 0)::numeric, 1),
    'level_distribution',  coalesce(
      (SELECT json_object_agg(bucket, cnt)
       FROM (
         SELECT (floor(level / 5) * 5)::int AS bucket, count(*) AS cnt
         FROM member_levels
         WHERE guild_id = p_guild_id
         GROUP BY bucket
         ORDER BY bucket
       ) AS dist),
      '{}'::json
    )
  )
  FROM member_levels
  WHERE guild_id = p_guild_id;
$$;
