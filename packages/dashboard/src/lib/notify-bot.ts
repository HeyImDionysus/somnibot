/**
 * notifyBot — Insert a config_reload action into bot_action_queue
 * so the bot hot-reloads the changed section immediately.
 *
 * Called by every dashboard write API (PUT/POST/DELETE) that changes
 * bot-relevant configuration.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';
import type { ConfigReloadAuditEvent } from '@somnibot/shared';

export type ConfigSection =
  | 'welcome'
  | 'onboarding'
  | 'levels'
  | 'music'
  | 'tickets'
  | 'moderation'
  | 'reaction-roles'
  | 'giveaways'
  | 'temp-channels'
  | 'scheduled-messages'
  | 'custom-commands'
  | 'stats-channels'
  | 'automations'
  | 'embeds'
  | 'commerce'
  | 'economy'
  | 'branding'
  | 'settings'
  | 'all';

/**
 * Notify the bot that a config section has changed.
 * Non-blocking — failures are logged but don't break the API response.
 *
 * @param auditEvent  Optional event data for the bot to emit on the PlatformEventBus
 *                    so AuditService can log CRUD operations (Finding #4).
 * @param before      Optional prior values of the changed keys (read from
 *                    guild_config BEFORE the caller applied the update) — the
 *                    bot maps them into the config.updated audit row's
 *                    before_state. When absent, AuditService falls back to its
 *                    own last-known guild_config snapshot.
 */
export async function notifyBot(
  section: ConfigSection,
  changes?: Record<string, unknown>,
  changedBy: string = 'dashboard',
  auditEvent?: ConfigReloadAuditEvent,
  before?: Record<string, unknown>,
): Promise<void> {
  // V10 Audit M-1: Guard against empty/unset DISCORD_GUILD_ID.
  // Previously used a top-level non-null assertion that silently inserted
  // empty guild_id values the bot would never pick up.
  const guildId = process.env.DISCORD_GUILD_ID?.split(',')[0]?.trim();
  if (!guildId) {
    console.warn('[notifyBot] DISCORD_GUILD_ID not set — skipping bot notification');
    return;
  }

  await enqueueBotNotification(guildId, section, changes, changedBy, auditEvent, before);
}

/**
 * Queue a config reload for the guild authorized by the current dashboard
 * request. Multi-guild installations must use this path: the process-wide
 * DISCORD_GUILD_ID can contain several guilds and cannot identify which guild
 * the authenticated owner is editing.
 */
export async function notifyBotForGuild(
  guildId: string,
  section: ConfigSection,
  changes?: Record<string, unknown>,
  changedBy: string = 'dashboard',
  auditEvent?: ConfigReloadAuditEvent,
  before?: Record<string, unknown>,
): Promise<void> {
  const scopedGuildId = guildId.trim();
  if (!scopedGuildId || scopedGuildId.includes(',')) {
    console.warn('[notifyBot] A single guild ID is required — skipping bot notification');
    return;
  }

  await enqueueBotNotification(scopedGuildId, section, changes, changedBy, auditEvent, before);
}

async function enqueueBotNotification(
  guildId: string,
  section: ConfigSection,
  changes?: Record<string, unknown>,
  changedBy: string = 'dashboard',
  auditEvent?: ConfigReloadAuditEvent,
  before?: Record<string, unknown>,
): Promise<void> {

  try {
    const supabase = createAdminSupabase();
    await supabase.from('bot_action_queue').insert({
      guild_id: guildId,
      action: 'config_reload',
      payload: {
        section,
        changes: changes ?? {},
        changed_by: changedBy,
        // Stable per-change identity: the bot uses it as the config.updated
        // audit occurrence key, so a redelivered config_reload action cannot
        // double-write the audit row.
        occurrence_id: crypto.randomUUID(),
        ...(before ? { before } : {}),
        ...(auditEvent ? { audit_event: auditEvent } : {}),
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    // Never let notification failure break the dashboard API
    console.error(`[notifyBot] Failed to notify bot (section: ${section}):`, err);
  }
}
