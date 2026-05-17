-- Phase 4: Members tracking table for onboarding, welcome, returning member detection
-- This table stores per-guild member data that persists across leaves/rejoins.

CREATE TABLE members (
  guild_id TEXT NOT NULL REFERENCES guild(id) ON DELETE CASCADE,
  discord_id TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT '',
  avatar_url TEXT,
  roles TEXT[] DEFAULT '{}',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at TIMESTAMPTZ,
  onboarding_completed BOOLEAN DEFAULT false,
  is_returning BOOLEAN DEFAULT false,
  member_number INTEGER NOT NULL DEFAULT 0,
  total_time_seconds BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (guild_id, discord_id)
);

-- Indexes
CREATE INDEX idx_members_guild ON members(guild_id);
CREATE INDEX idx_members_guild_joined ON members(guild_id, joined_at DESC);
CREATE INDEX idx_members_returning ON members(guild_id, is_returning) WHERE is_returning = true;

-- RLS
ALTER TABLE members ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY "service_role_full_access" ON members
  FOR ALL USING (true) WITH CHECK (true);

-- Authenticated users can read members for their guild
CREATE POLICY "authenticated_read_members" ON members
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.discord_id = (SELECT owner_discord_id FROM guild WHERE id = members.guild_id)
        AND u.id = auth.uid()
    )
  );

-- Trigger for updated_at
CREATE TRIGGER update_members_updated_at
  BEFORE UPDATE ON members
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Sequence for member numbers
CREATE SEQUENCE IF NOT EXISTS member_number_seq;

-- Grants
GRANT ALL ON members TO service_role;
GRANT SELECT ON members TO authenticated;
GRANT USAGE ON SEQUENCE member_number_seq TO service_role;
