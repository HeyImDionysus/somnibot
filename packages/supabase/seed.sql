-- SomniBot seed data
-- Insert built-in role templates and channel templates.
-- These are the defaults from the architecture spec.

-- Built-in role templates (no guild_id = global builtins)
INSERT INTO role_templates (name, tier, description, permissions, permission_details, is_builtin) VALUES
  ('@everyone', 'everyone', 'Default permissions for all server members', 1049600, '{"VIEW_CHANNEL": true, "READ_MESSAGE_HISTORY": true}', true),
  ('Cosmetic Role', 'cosmetic', 'Vanity role — no permissions, display only', 0, '{}', true),
  ('Member', 'member', 'Standard verified member permissions', 1146048, '{"VIEW_CHANNEL": true, "SEND_MESSAGES": true, "ADD_REACTIONS": true, "USE_EXTERNAL_EMOJIS": true, "READ_MESSAGE_HISTORY": true, "CONNECT": true, "SPEAK": true, "USE_VAD": true}', true),
  ('Moderator', 'moderator', 'Moderation permissions — manage messages, mute, kick', 1511014486080, '{"VIEW_CHANNEL": true, "SEND_MESSAGES": true, "MANAGE_MESSAGES": true, "KICK_MEMBERS": true, "MODERATE_MEMBERS": true, "VIEW_AUDIT_LOG": true}', true),
  ('Admin', 'admin', 'Full administrative permissions (not Administrator)', 2199023255551, '{"ADMINISTRATOR": false, "MANAGE_GUILD": true, "MANAGE_ROLES": true, "MANAGE_CHANNELS": true}', true);

-- Built-in channel templates (no guild_id = global builtins)
INSERT INTO channel_templates (name, description, target_channel_type, overrides, is_builtin) VALUES
  ('View Only', 'Read-only channel — members can view but not send', 'text', '{"deny": ["SEND_MESSAGES", "ADD_REACTIONS"], "allow": ["VIEW_CHANNEL", "READ_MESSAGE_HISTORY"]}', true),
  ('View and Use', 'Standard text channel — view and send messages', 'text', '{"deny": [], "allow": ["VIEW_CHANNEL", "SEND_MESSAGES", "ADD_REACTIONS", "READ_MESSAGE_HISTORY"]}', true),
  ('Staff Only', 'Staff-restricted channel — visible only to moderators and above', 'text', '{"deny": [], "allow": ["VIEW_CHANNEL", "SEND_MESSAGES", "MANAGE_MESSAGES"], "visibility": "staff_only"}', true),
  ('Premium Only', 'Premium member channel — requires entitlement', 'text', '{"deny": [], "allow": ["VIEW_CHANNEL", "SEND_MESSAGES"], "visibility": "entitlement_required"}', true);
