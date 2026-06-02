/**
 * notifyBot — Insert a config_reload action into bot_action_queue
 * so the bot hot-reloads the changed section immediately.
 *
 * Called by every dashboard write API (PUT/POST/DELETE) that changes
 * bot-relevant configuration.
 */
import { createAdminSupabase } from '@/lib/supabase/admin';

const GUILD_ID = process.env.DISCORD_GUILD_ID!;

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
  | 'settings'
  | 'all';

/**
 * Notify the bot that a config section has changed.
 * Non-blocking — failures are logged but don't break the API response.
 *
 * @param auditEvent  Optional event data for the bot to emit on the PlatformEventBus
 *                    so AuditService can log CRUD operations (Finding #4).
 */
export async function notifyBot(
  section: ConfigSection,
  changes?: Record<string, unknown>,
  changedBy: string = 'dashboard',
  auditEvent?: { type: string; data: Record<string, unknown> },
): Promise<void> {
  try {
    const supabase = createAdminSupabase();
    await supabase.from('bot_action_queue').insert({
      guild_id: GUILD_ID,
      action: 'config_reload',
      payload: {
        section,
        changes: changes ?? {},
        changed_by: changedBy,
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
