-- Temp channel branded message templates.
--
-- The member-facing surfaces a temp channel produces — the welcome posted when a
-- room is created, the confirmation shown when an owner control is applied, and
-- the notice shown when a control is denied — were hard-coded strings with no
-- owner customization. A white-label server therefore could not brand them, and
-- the {owner-name} variable owners already use in naming_format was unavailable
-- on these surfaces. Add nullable per-surface template columns on the hub. NULL
-- (or a blank string) means "use the bot's built-in default"; a non-empty string
-- overrides it. The bot resolves {owner-name}, {room-name}, {user}, {server},
-- {action}, {reason}, {target} at send time.

ALTER TABLE public.temp_channel_hubs
  ADD COLUMN IF NOT EXISTS room_created_template    text,
  ADD COLUMN IF NOT EXISTS control_applied_template text,
  ADD COLUMN IF NOT EXISTS control_denied_template  text;

-- Bound each template so it can never overflow a Discord message (2000 chars)
-- and to keep the dashboard editor honest. NULL is always allowed (= default).
ALTER TABLE public.temp_channel_hubs
  ADD CONSTRAINT temp_channel_hubs_room_created_template_len
    CHECK (room_created_template IS NULL OR char_length(room_created_template) <= 500),
  ADD CONSTRAINT temp_channel_hubs_control_applied_template_len
    CHECK (control_applied_template IS NULL OR char_length(control_applied_template) <= 500),
  ADD CONSTRAINT temp_channel_hubs_control_denied_template_len
    CHECK (control_denied_template IS NULL OR char_length(control_denied_template) <= 500);
